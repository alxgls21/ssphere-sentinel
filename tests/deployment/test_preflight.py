"""The PostgreSQL preflight script, against a fake ``docker`` that reports which
volumes exist. No Docker is needed: the script only lists and inspects, so its
whole decision table can be exercised and its calls checked for being read-only."""

from __future__ import annotations

import itertools
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.deployment.helpers import write_executable

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "postgres-preflight.sh"

# What the script may ask Docker: nothing that creates or changes anything.
READ_ONLY_CALLS = (
    "compose config",
    "compose config --volumes",
    "volume ls --quiet",
    "volume inspect --format {{.CreatedAt}} ",
)

FAKE_DOCKER = """#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
    "compose config")
        [ -z "$FAKE_CONFIG_FAILS" ] || { echo "invalid configuration" >&2; exit 1; }
        printf 'name: %s\\nservices: {}\\n' "$FAKE_PROJECT" ;;
    "compose config --volumes") echo "$FAKE_SELECTED_KEY" ;;
    "volume ls --quiet")
        [ -z "$FAKE_DAEMON_DOWN" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
        for volume in $FAKE_VOLUMES; do echo "$volume"; done ;;
    "volume inspect --format {{.CreatedAt}} "*) echo "2026-01-01 00:00:00 +0000 UTC" ;;
    *) echo "unexpected docker call: $*" >&2; exit 99 ;;
esac
"""

LEGACY, CURRENT = "sentinel_postgres_data", "sentinel_postgres18_data"
KEYS = {"16": "postgres_data", "18": "postgres18_data"}
VOLUMES = {
    "none": [],
    "only16": [LEGACY],
    "only18": [CURRENT],
    "both": [LEGACY, CURRENT],
}


def expected_status(state: str, selected: str, migrate: bool, confirm: str | None) -> int:
    """The policy, stated independently of the script."""
    if state == "none":
        return 0
    if state == "only16":
        return 0 if selected == "16" or migrate else 1
    if state == "only18":
        return 0 if selected == "18" else 1
    if confirm is None:
        return 2
    return 0 if confirm == selected else 1


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.bin = Path(self.directory.name) / "bin"
        self.bin.mkdir()
        write_executable(self.bin / "docker", FAKE_DOCKER)
        self.log = Path(self.directory.name) / "docker.log"

    def run_script(self, state="none", selected="16", args=(), **extra):
        environment = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "FAKE_DOCKER_LOG": str(self.log),
            "FAKE_PROJECT": "sentinel",
            "FAKE_SELECTED_KEY": KEYS[selected],
            "FAKE_VOLUMES": " ".join(VOLUMES[state]),
            "FAKE_CONFIG_FAILS": "",
            "FAKE_DAEMON_DOWN": "",
            **extra,
        }
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=environment,
            cwd=self.directory.name,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_the_decision_table(self):
        options = [(False, None), (True, None), (False, "16"), (False, "18")]
        for state, selected, (migrate, confirm) in itertools.product(VOLUMES, KEYS, options):
            args = (["--migrate"] if migrate else []) + (["--confirm", confirm] if confirm else [])
            with self.subTest(state=state, selected=selected, args=args):
                result = self.run_script(state, selected, args)
                self.assertEqual(
                    result.returncode,
                    expected_status(state, selected, migrate, confirm),
                    result.stdout + result.stderr,
                )

    def test_a_new_installation_is_told_about_the_initialization_authorization(self):
        output = self.run_script("none", "18").stdout
        self.assertIn("new installation", output)
        self.assertIn("SENTINEL_POSTGRES_INITIALIZE=true", output)

    def test_existing_installations_are_recognised(self):
        self.assertIn("existing PostgreSQL 16 installation", self.run_script("only16", "16").stdout)
        self.assertIn("existing PostgreSQL 18 installation", self.run_script("only18", "18").stdout)

    def test_refusals_name_the_way_forward(self):
        premature = self.run_script("only16", "18").stdout
        self.assertIn("REFUSED", premature)
        self.assertIn("--migrate", premature)
        self.assertIn("empty PostgreSQL 18 database", premature)
        revert = self.run_script("only18", "16").stdout
        self.assertIn("REFUSED", revert)
        self.assertIn("no PostgreSQL 16 data", revert)

    def test_both_volumes_are_ambiguous_until_confirmed(self):
        result = self.run_script("both", "18")
        self.assertEqual(result.returncode, 2)
        self.assertIn("AMBIGUOUS", result.stdout)
        self.assertIn("--confirm 18", result.stdout)
        # --migrate does not settle an ambiguity.
        self.assertEqual(self.run_script("both", "18", ["--migrate"]).returncode, 2)
        mismatch = self.run_script("both", "16", ["--confirm", "18"])
        self.assertEqual(mismatch.returncode, 1)
        self.assertIn("selects PostgreSQL 16", mismatch.stdout)

    def test_volumes_of_other_projects_do_not_count(self):
        result = self.run_script("none", "18", FAKE_VOLUMES="other_postgres_data sentinel_postgres_data_old")
        self.assertEqual(result.returncode, 0)
        self.assertIn("new installation", result.stdout)

    def test_the_project_name_comes_from_compose(self):
        result = self.run_script("only16", "18", FAKE_PROJECT="other", FAKE_VOLUMES="other_postgres_data")
        self.assertEqual(result.returncode, 1)
        self.assertIn("project 'other'", result.stdout)

    def test_an_undeterminable_state_is_never_a_go(self):
        cases = {
            "docker unreachable": dict(FAKE_DAEMON_DOWN="1"),
            "configuration does not resolve": dict(FAKE_CONFIG_FAILS="1"),
            "unsupported volume": dict(FAKE_SELECTED_KEY="postgres20_data"),
        }
        for name, extra in cases.items():
            with self.subTest(name):
                self.assertEqual(self.run_script("none", "16", **extra).returncode, 3)
        for args in (["--force"], ["--confirm"], ["--confirm", "17"]):
            with self.subTest(args=args):
                self.assertEqual(self.run_script("none", "16", args).returncode, 3)

    def test_it_only_lists_and_inspects(self):
        for state, selected in itertools.product(VOLUMES, KEYS):
            self.run_script(state, selected, ["--confirm", selected])
        calls = {line for line in self.log.read_text().splitlines()}
        self.assertTrue(calls)
        for call in calls:
            self.assertTrue(
                any(call.startswith(prefix) for prefix in READ_ONLY_CALLS), f"unexpected call: {call}"
            )
        # The commands the script contains, not just the ones this run reached.
        invoked = re.findall(r"\$\(docker ([^)]*)\)", SCRIPT.read_text())
        self.assertTrue(invoked)
        for command in invoked:
            self.assertTrue(
                command.startswith(("compose config", "volume ls", "volume inspect")), command
            )

    def test_the_supported_volumes_match_the_database_definitions(self):
        text = SCRIPT.read_text()
        for volume in KEYS.values():
            self.assertIn(volume, text)
        self.assertTrue(os.access(SCRIPT, os.X_OK), "the script must be executable")


if __name__ == "__main__":
    unittest.main()

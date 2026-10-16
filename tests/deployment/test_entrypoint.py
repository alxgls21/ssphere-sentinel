"""The server image's entrypoint.sh, run with stand-ins for the database wait,
Django's manage.py and the container command.

``python -m sentinel.database mode`` runs for real (it imports nothing but the
standard library); every other ``python`` call and the command are recorded
instead of executed. Each case runs under dash, the /bin/sh of the image's
Debian base, when the host has it.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT = ROOT / "entrypoint.sh"

WAIT = "-m sentinel.database wait"
MIGRATE = "manage.py migrate --noinput"
VERIFY = "-m sentinel.database verify"

PYTHON_STUB = """#!/bin/sh
echo "python $*" >> "$STUB_CALLS"
if [ "$1 $2 $3" = "-m sentinel.database mode" ]; then
    if [ -n "${STUB_MODE:-}" ]; then
        echo "$STUB_MODE"
        exit 0
    fi
    exec "$REAL_PYTHON" "$@"
fi
case " $* " in
    *" $STUB_FAIL "*) exit 1 ;;
esac
exit 0
"""
COMMAND_STUB = """#!/bin/sh
echo "command $*" >> "$STUB_CALLS"
"""


class EntrypointTests(unittest.TestCase):
    shells = [shell for shell in ("dash", "sh") if shutil.which(shell)][:1]

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.bin = base / "bin"
        self.bin.mkdir()
        self.calls = base / "calls"
        for name, text in (("python", PYTHON_STUB), ("gunicorn", COMMAND_STUB)):
            path = self.bin / name
            path.write_text(text)
            path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def run_entrypoint(self, *command: str, fail: str = "", **environment: str) -> subprocess.CompletedProcess:
        self.calls.unlink(missing_ok=True)
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "REAL_PYTHON": sys.executable,
            "STUB_CALLS": str(self.calls),
            "STUB_FAIL": fail or "no-call-fails",
            **environment,
        }
        return subprocess.run(
            [self.shells[0], str(ENTRYPOINT), *command],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def recorded(self) -> list[str]:
        if not self.calls.exists():
            return []
        lines = self.calls.read_text().splitlines()
        return [line.removeprefix("python ") for line in lines if line != "python -m sentinel.database mode"]

    def test_legacy_web_waits_migrates_and_starts_exactly_as_before(self):
        # An .env that predates the setting, with and without the variables
        # compose.yml sets for web.
        for environment in ({}, {"SENTINEL_DB_ACCESS": "runtime"}, {"SENTINEL_DB_ROLES": "legacy"}):
            with self.subTest(environment=environment):
                result = self.run_entrypoint("gunicorn", "--bind", "0.0.0.0:8000", **environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.recorded(), [WAIT, MIGRATE, "command --bind 0.0.0.0:8000"])
                self.assertIn("entrypoint: waiting for the database at db:5432", result.stderr)
                self.assertIn("entrypoint: applying database migrations", result.stderr)

    def test_legacy_migrate_service_has_nothing_to_do_and_never_connects(self):
        result = self.run_entrypoint("apply-migrations", SENTINEL_DB_ACCESS="migrate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [])
        self.assertIn("the web service applies the migrations", result.stderr)

    def test_legacy_migrate_service_runs_no_other_command(self):
        result = self.run_entrypoint("gunicorn", SENTINEL_DB_ACCESS="migrate")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.recorded(), [])
        self.assertIn("run manage.py commands in the web service", result.stderr)

    def test_separate_web_waits_verifies_and_starts_without_migrating(self):
        result = self.run_entrypoint("gunicorn", SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="runtime")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [WAIT, VERIFY, "command "])
        self.assertNotIn("applying database migrations", result.stderr)

    def test_separate_migrate_service_checks_applies_the_migrations_verifies_and_exits(self):
        # The roles, django_migrations included, are checked before any migration runs.
        result = self.run_entrypoint("apply-migrations", SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [WAIT, VERIFY, MIGRATE, VERIFY])
        self.assertIn("entrypoint: checking the database roles before anything runs", result.stderr)

    def test_a_password_not_its_own_stops_a_process_before_anything_runs(self):
        cases = (
            ("gunicorn", {"SENTINEL_DB_ROLES": "separate", "POSTGRES_PASSWORD": "bootstrap-secret"}),
            ("gunicorn", {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_MIGRATE_PASSWORD": "migration-secret"}),
            ("apply-migrations", {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate",
                                  "POSTGRES_PASSWORD": "bootstrap-secret"}),
            ("apply-migrations", {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate",
                                  "SENTINEL_DB_PASSWORD": "runtime-secret"}),
            # The migrate service given its password but not SENTINEL_DB_ROLES: never "nothing to do".
            ("apply-migrations", {"SENTINEL_DB_ACCESS": "migrate", "SENTINEL_DB_MIGRATE_PASSWORD": "migration-secret"}),
            ("gunicorn", {"SENTINEL_DB_PASSWORD": "runtime-secret"}),
        )
        for command, environment in cases:
            with self.subTest(command=command, environment=sorted(environment)):
                result = self.run_entrypoint(command, **environment)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.recorded(), [])
                self.assertNotIn("nothing to do", result.stderr)
                self.assertRegex(result.stderr, r"entrypoint: [A-Z_ ]+(?: and [A-Z_]+)? (is|are) set, but ")
                for secret in ("bootstrap-secret", "migration-secret", "runtime-secret"):
                    self.assertNotIn(secret, result.stdout + result.stderr)

    def test_separate_migrate_service_runs_other_commands_with_its_login(self):
        result = self.run_entrypoint(
            "gunicorn", "showmigrations", SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # Any of its commands could migrate (manage.py migrate): checked first all the same.
        self.assertEqual(self.recorded(), [WAIT, VERIFY, "command showmigrations"])
        result = self.run_entrypoint(
            "gunicorn", "migrate", fail="verify", SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.recorded(), [WAIT, VERIFY])

    def test_apply_migrations_is_refused_outside_the_migrate_service(self):
        for roles in ("legacy", "separate"):
            with self.subTest(roles=roles):
                result = self.run_entrypoint("apply-migrations", SENTINEL_DB_ROLES=roles, SENTINEL_DB_ACCESS="runtime")
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.recorded(), [])
                self.assertIn("only runs in the migrate service", result.stderr)

    def test_unknown_settings_stop_before_anything_runs(self):
        for name, value in (("SENTINEL_DB_ROLES", "seperate"), ("SENTINEL_DB_ACCESS", "admin")):
            with self.subTest(name=name):
                result = self.run_entrypoint("gunicorn", **{name: value})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.recorded(), [])
                self.assertIn(f"{name} must be one of", result.stderr)

    def test_an_unexpected_mode_never_starts_the_command(self):
        # Defence in depth: the mode command validates its output, but web must
        # not start without its migrations if it ever printed something else.
        result = self.run_entrypoint("gunicorn", STUB_MODE="legacy  runtime")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.recorded(), [WAIT])
        self.assertIn("unexpected database mode", result.stderr)

    def test_a_failed_wait_or_migration_never_starts_the_command(self):
        cases = (
            ("sentinel.database wait", {}, [WAIT]),
            ("migrate", {}, [WAIT, MIGRATE]),
            ("migrate", {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate"}, [WAIT, VERIFY, MIGRATE]),
            # The check before the migrations stops them, and anything else.
            ("verify", {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate"}, [WAIT, VERIFY]),
            ("verify", {"SENTINEL_DB_ROLES": "separate"}, [WAIT, VERIFY]),
        )
        for fail, environment, calls in cases:
            with self.subTest(fail=fail, environment=environment):
                command = "apply-migrations" if environment.get("SENTINEL_DB_ACCESS") == "migrate" else "gunicorn"
                result = self.run_entrypoint(command, fail=fail, **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.recorded(), calls)

    def test_the_command_replaces_the_shell(self):
        # exec keeps Gunicorn as the process that receives the stop signal.
        self.assertTrue(ENTRYPOINT.read_text().rstrip().endswith('exec "$@"'))
        self.assertTrue(os.access(ENTRYPOINT, os.X_OK))


if __name__ == "__main__":
    unittest.main()

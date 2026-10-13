"""Guards for the way the migration rehearsal (.github/scripts) talks to Django.

The rehearsal once failed because ``manage.py shell`` announces its automatic
imports on stdout ("32 objects imported automatically"), in front of what the
command prints, and the script compared the whole output with "True". These
tests keep that class of mistake out and keep the verification in place.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".github" / "scripts"
REHEARSAL = SCRIPTS / "postgres-upgrade-e2e.sh"


def logical_lines(text: str) -> list[str]:
    """Shell lines with backslash continuations joined."""
    return re.sub(r"\\\n\s*", " ", text).splitlines()


class ShellInvocationTests(unittest.TestCase):
    def test_every_django_shell_call_is_quiet_and_takes_its_code_as_an_argument(self):
        calls = [
            (path.name, line.strip())
            for path in SCRIPTS.glob("*.sh")
            for line in logical_lines(path.read_text())
            if "manage.py shell" in line and not line.lstrip().startswith("#")
        ]
        self.assertTrue(calls, "the rehearsal no longer runs the Django shell")
        for name, line in calls:
            with self.subTest(script=name, line=line):
                # No notice about imported models in front of the output ...
                self.assertIn("--no-imports", line)
                self.assertRegex(line, r"(?<![\w-])-v 0(?![\w-])")
                # ... and the code travels as -c: the shell's stdin path only
                # runs what is already readable when it starts.
                self.assertRegex(line, r"(?<![\w-])-c ")
                self.assertNotIn("<<", line)
                self.assertNotRegex(line, r"\|\s*(docker|python)")


class RehearsalVerificationTests(unittest.TestCase):
    def setUp(self):
        self.script = REHEARSAL.read_text()

    def test_real_records_are_seeded_and_checked_before_the_migration(self):
        self.assertIn("rehearsal seed", self.script)
        self.assertIn('rehearsal fingerprint > "$work/data-before"', self.script)
        # The database itself is asked as well, not only the application.
        for table in ("auth_user", "infrastructure_servertelemetrysample", "network_networkmeasurement"):
            self.assertRegex(self.script, rf"'{table} \d+'")

    def test_the_records_are_checked_after_every_move(self):
        for where in ("after the restore", "after the rollback", "once the PostgreSQL 16 volume is retired"):
            self.assertRegex(self.script, rf'assert_rehearsal_data "[^"]*{where}')

    def test_the_comparison_is_strict(self):
        body = re.search(r"assert_rehearsal_data\(\) \{.*?\n\}", self.script, re.S)[0]
        # The records must be identical, and a difference must stop the rehearsal.
        self.assertRegex(body, re.compile(r'^\s*diff -u "\$work/data-before" "\$work/data-now" \|\| fail "', re.M))
        self.assertNotRegex(body, r"\|\|\s*(true|:)\b")

    def test_preflight_and_initialization_guard_steps_are_kept(self):
        for text in (
            "run_preflight",
            "--migrate",
            "--confirm 18",
            "--confirm 16",
            "creating one is not authorized",
            "revoke_initialization",
            "authorize_initialization",
        ):
            self.assertIn(text, self.script)

    def test_the_data_script_covers_each_table_the_rehearsal_counts(self):
        data = (SCRIPTS / "rehearsal_data.py").read_text()
        for label in re.findall(r"'((?:auth|inventory|infrastructure|agents|network)_\w+) \d+'", self.script):
            app, _, model = label.partition("_")
            self.assertRegex(data, rf'"{app}\.\w+"', label)
            self.assertIn(model, data.lower(), label)


if __name__ == "__main__":
    unittest.main()

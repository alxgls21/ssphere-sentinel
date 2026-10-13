"""The data script of the PostgreSQL migration rehearsal (.github/scripts/rehearsal_data.py).

The rehearsal runs it inside the web container against a real migration. Here it
runs against the test database on every supported Django, so a model change that
breaks it (or a fingerprint that stops noticing a changed value) fails the normal
test run and not only the deployment job.
"""

from __future__ import annotations

import contextlib
import io
import os
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.management import call_command
from django.test import TestCase

from apps.infrastructure.models import ServerTelemetry, ServerTelemetrySample
from apps.inventory.models import Customer
from apps.network.models import NetworkTarget

SCRIPT = Path(settings.BASE_DIR) / ".github" / "scripts" / "rehearsal_data.py"


def run_script(action: str) -> str:
    """Run the script the way the rehearsal does and return exactly what it prints."""
    output = io.StringIO()
    with mock.patch.dict(os.environ, {"REHEARSAL_ACTION": action}), contextlib.redirect_stdout(output):
        call_command("shell", command=SCRIPT.read_text(), no_imports=True, verbosity=0)
    return output.getvalue()


class RehearsalDataTests(TestCase):
    def test_seeding_creates_records_in_every_table_the_rehearsal_checks(self):
        run_script("seed")
        output = run_script("fingerprint")
        lines = output.splitlines()
        # Nothing but the script's own lines: a shell notice in front of them
        # is what once made the rehearsal compare "32 objects imported ..." with "True".
        self.assertTrue(all(line.startswith("rehearsal ") for line in lines), output)
        self.assertIn("rehearsal relations ok", lines)
        self.assertTrue(lines[-1].startswith("rehearsal total rows=18 "), lines[-1])
        self.assertEqual(len([line for line in lines if " rows=" in line]), 12)

    def test_the_fingerprint_is_repeatable(self):
        run_script("seed")
        self.assertEqual(run_script("fingerprint"), run_script("fingerprint"))

    def test_an_empty_database_is_refused(self):
        with self.assertRaises(SystemExit) as raised:
            run_script("fingerprint")
        self.assertIn("rehearsal data is not as seeded", str(raised.exception))

    def test_a_missing_record_is_refused(self):
        run_script("seed")
        ServerTelemetrySample.objects.order_by("sampled_at").first().delete()
        with self.assertRaises(SystemExit) as raised:
            run_script("fingerprint")
        self.assertIn("ServerTelemetrySample: 2 rows, expected 3", str(raised.exception))

    def test_any_changed_value_is_noticed(self):
        run_script("seed")
        before = run_script("fingerprint")
        telemetry, customers, targets = ServerTelemetry.objects, Customer.objects, NetworkTarget.objects
        notes = customers.get().notes
        changes = {
            "a float": (
                lambda: telemetry.update(cpu_percent=12.626),
                lambda: telemetry.update(cpu_percent=12.625),
            ),
            "a big integer": (
                lambda: telemetry.update(uptime_seconds=9_876_543_211),
                lambda: telemetry.update(uptime_seconds=9_876_543_210),
            ),
            "a decimal": (
                lambda: targets.update(expected_sla_percentage=Decimal("99.90")),
                lambda: targets.update(expected_sla_percentage=Decimal("99.95")),
            ),
            "a non-ASCII text": (
                lambda: customers.update(notes=notes.replace("\u2713", "v")),
                lambda: customers.update(notes=notes),
            ),
        }
        for label, (change, revert) in changes.items():
            with self.subTest(label):
                change()
                try:
                    # Noticed either as a different digest or as a refusal.
                    try:
                        noticed = run_script("fingerprint") != before
                    except SystemExit:
                        noticed = True
                    self.assertTrue(noticed, f"{label} went unnoticed")
                finally:
                    revert()
                self.assertEqual(run_script("fingerprint"), before)

"""Telemetry history settings are validated at start-up (imported in a clean subprocess)."""

import json
import subprocess
import sys

from django.test import SimpleTestCase

from apps.core.tests.test_settings import BASE_DIR, BASE_ENV

REPORT = """
import json
import sentinel.settings as s
print(json.dumps([s.SENTINEL_TELEMETRY_RETENTION_DAYS, s.SENTINEL_TELEMETRY_SAMPLE_SECONDS]))
"""


def load(**overrides):
    return subprocess.run(
        [sys.executable, "-c", REPORT], cwd=BASE_DIR, env={**BASE_ENV, **overrides}, capture_output=True, text=True, check=False
    )


class TelemetrySettingsTests(SimpleTestCase):
    def test_defaults(self):
        result = load()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [7, 60])

    def test_invalid_values_are_refused_and_name_the_setting(self):
        cases = {
            "SENTINEL_TELEMETRY_RETENTION_DAYS": ["0", "1", "366", "x", "-7"],
            # only the divisors of 60 from 5 to 60, and 300, line up with the chart buckets
            "SENTINEL_TELEMETRY_SAMPLE_SECONDS": ["0", "4", "7", "45", "90", "120", "180", "240", "301", "360", "x"],
        }
        for name, values in cases.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    result = load(**{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)

    def test_the_accepted_values(self):
        for days in ("2", "7", "365"):
            self.assertEqual(load(SENTINEL_TELEMETRY_RETENTION_DAYS=days).returncode, 0, days)
        for seconds in ("5", "6", "10", "12", "15", "20", "30", "60", "300"):
            result = load(SENTINEL_TELEMETRY_SAMPLE_SECONDS=seconds)
            self.assertEqual(result.returncode, 0, (seconds, result.stderr))
            self.assertEqual(json.loads(result.stdout)[1], int(seconds))

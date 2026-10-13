"""Console settings are validated at start-up (imported in a clean subprocess)."""

import json
import subprocess
import sys

from django.test import SimpleTestCase

from apps.core.tests.test_settings import BASE_DIR, BASE_ENV

REPORT = """
import json
import sentinel.settings as s
print(json.dumps({
    "session": s.SENTINEL_CONSOLE_SESSION_SECONDS,
    "attempts": s.SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS,
    "lockout": s.SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS,
    "warn": s.SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT,
    "crit": s.SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT,
    "loss": s.SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT,
    "latency": s.SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS,
    "failures": s.SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES,
    "csrf_failure_view": s.CSRF_FAILURE_VIEW,
    "session_cookie_secure": s.SESSION_COOKIE_SECURE,
    "samesite": getattr(s, "SESSION_COOKIE_SAMESITE", "Lax"),
    "httponly": getattr(s, "SESSION_COOKIE_HTTPONLY", True),
}))
"""


def load(**overrides):
    return subprocess.run(
        [sys.executable, "-c", REPORT],
        cwd=BASE_DIR,
        env={**BASE_ENV, **overrides},
        capture_output=True,
        text=True,
        check=False,
    )


class ConsoleSettingsTests(SimpleTestCase):
    def test_defaults(self):
        result = load()
        self.assertEqual(result.returncode, 0, result.stderr)
        conf = json.loads(result.stdout)
        self.assertEqual(
            (conf["session"], conf["attempts"], conf["lockout"]), (43200, 5, 900)
        )
        self.assertEqual((conf["warn"], conf["crit"], conf["loss"], conf["latency"], conf["failures"]), (80, 95, 2, 150, 3))
        self.assertTrue(conf["session_cookie_secure"])
        self.assertEqual((conf["samesite"], conf["httponly"]), ("Lax", True))
        self.assertEqual(conf["csrf_failure_view"], "apps.console.http.csrf_failure")

    def test_invalid_values_are_refused_at_start_up(self):
        cases = {
            "SENTINEL_CONSOLE_SESSION_SECONDS": ["10", "99999999", "abc", "-5"],
            "SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS": ["0", "101", "x"],
            "SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS": ["59", "86401", "x"],
            "SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT": ["0", "95", "96", "x"],
            "SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT": ["80", "101"],
            "SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT": ["0", "101"],
            "SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS": ["0", "60001"],
            "SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES": ["0", "1001"],
        }
        for name, values in cases.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    result = load(**{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("RuntimeError", result.stderr)
                    self.assertIn(name, result.stderr)  # the message names the setting that is wrong

    def test_the_boundaries_of_every_range_are_accepted(self):
        accepted = {
            "SENTINEL_CONSOLE_SESSION_SECONDS": ["300", "2592000"],
            "SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS": ["1", "100"],
            "SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS": ["60", "86400"],
            "SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT": ["1", "100"],
            "SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS": ["1", "60000"],
            "SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES": ["1", "1000"],
        }
        for name, values in accepted.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    result = load(**{name: value})
                    self.assertEqual(result.returncode, 0, result.stderr)
        for warn, crit in (("1", "2"), ("99", "100"), ("50", "51")):
            with self.subTest(warn=warn, crit=crit):
                result = load(SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT=warn, SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT=crit)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_valid_overrides_are_applied(self):
        result = load(SENTINEL_CONSOLE_SESSION_SECONDS="3600", SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT="70", SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT="90")
        conf = json.loads(result.stdout)
        self.assertEqual((conf["session"], conf["warn"], conf["crit"]), (3600, 70, 90))

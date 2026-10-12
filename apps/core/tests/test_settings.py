"""Production settings behaviour, imported in a subprocess with a clean
environment (settings are evaluated once per process)."""

import json
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase

BASE_DIR = Path(__file__).resolve().parents[3]
BASE_ENV = {
    "DJANGO_SECRET_KEY": "test-only-secret-key-not-used-anywhere-else-0123456789",
    "AGENT_TOKEN_PEPPER": "test-only-pepper",
    "POSTGRES_DB": "sentinel",
    "POSTGRES_USER": "sentinel",
    "POSTGRES_PASSWORD": "unused",
}
REPORT = """
import json
import sentinel.settings as s
print(json.dumps({
    "DEBUG": s.DEBUG,
    "SESSION_COOKIE_SECURE": s.SESSION_COOKIE_SECURE,
    "CSRF_COOKIE_SECURE": s.CSRF_COOKIE_SECURE,
    "SECURE_SSL_REDIRECT": s.SECURE_SSL_REDIRECT,
    "SECURE_HSTS_SECONDS": s.SECURE_HSTS_SECONDS,
    "SECURE_HSTS_INCLUDE_SUBDOMAINS": s.SECURE_HSTS_INCLUDE_SUBDOMAINS,
    "SECURE_HSTS_PRELOAD": s.SECURE_HSTS_PRELOAD,
    "SECURE_PROXY_SSL_HEADER": getattr(s, "SECURE_PROXY_SSL_HEADER", None),
    "USE_X_FORWARDED_HOST": getattr(s, "USE_X_FORWARDED_HOST", False),
    "ALLOWED_HOSTS": s.ALLOWED_HOSTS,
    "CSRF_TRUSTED_ORIGINS": s.CSRF_TRUSTED_ORIGINS,
    "MIDDLEWARE": s.MIDDLEWARE,
    "LOG_LEVEL": s.LOG_LEVEL,
}))
"""


def load_settings(**overrides):
    env = {**BASE_ENV, **overrides}
    return subprocess.run(
        [sys.executable, "-c", REPORT],
        cwd=BASE_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class ProductionSettingsTests(SimpleTestCase):
    def settings_for(self, **overrides):
        result = load_settings(**overrides)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def assert_refused(self, message, **overrides):
        result = load_settings(**overrides)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)

    def test_production_defaults_are_secure(self):
        conf = self.settings_for()
        self.assertFalse(conf["DEBUG"])
        self.assertTrue(conf["SESSION_COOKIE_SECURE"])
        self.assertTrue(conf["CSRF_COOKIE_SECURE"])
        self.assertEqual(conf["ALLOWED_HOSTS"], ["localhost", "127.0.0.1"])
        self.assertEqual(conf["CSRF_TRUSTED_ORIGINS"], [])
        # Proxy headers are never trusted by Django itself (Gunicorn decides
        # per peer address via FORWARDED_ALLOW_IPS).
        self.assertIsNone(conf["SECURE_PROXY_SSL_HEADER"])
        self.assertFalse(conf["USE_X_FORWARDED_HOST"])
        self.assertEqual(conf["MIDDLEWARE"][0], "apps.core.middleware.HealthCheckMiddleware")
        self.assertEqual(
            conf["MIDDLEWARE"][2], "whitenoise.middleware.WhiteNoiseMiddleware"
        )

    def test_debug_relaxes_cookies_and_uses_runserver_static_files(self):
        conf = self.settings_for(DJANGO_DEBUG="true")
        self.assertFalse(conf["SESSION_COOKIE_SECURE"])
        self.assertFalse(conf["CSRF_COOKIE_SECURE"])
        self.assertNotIn("whitenoise.middleware.WhiteNoiseMiddleware", conf["MIDDLEWARE"])

    def test_https_settings_are_configurable(self):
        conf = self.settings_for(
            DJANGO_ALLOWED_HOSTS="sentinel.example.com, ",
            DJANGO_CSRF_TRUSTED_ORIGINS="https://sentinel.example.com,https://admin.example.com",
            DJANGO_SECURE_SSL_REDIRECT="true",
            DJANGO_SECURE_HSTS_SECONDS="31536000",
            DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS="yes",
            DJANGO_SECURE_HSTS_PRELOAD="on",
            DJANGO_LOG_LEVEL="warning",
        )
        self.assertEqual(conf["ALLOWED_HOSTS"], ["sentinel.example.com"])
        self.assertEqual(
            conf["CSRF_TRUSTED_ORIGINS"],
            ["https://sentinel.example.com", "https://admin.example.com"],
        )
        self.assertTrue(conf["SECURE_SSL_REDIRECT"])
        self.assertEqual(conf["SECURE_HSTS_SECONDS"], 31536000)
        self.assertTrue(conf["SECURE_HSTS_INCLUDE_SUBDOMAINS"])
        self.assertTrue(conf["SECURE_HSTS_PRELOAD"])
        self.assertEqual(conf["LOG_LEVEL"], "WARNING")

    def test_placeholder_secret_key_is_refused_outside_debug(self):
        placeholder = "change-me-to-a-long-random-string"
        self.assert_refused("placeholder", DJANGO_SECRET_KEY=placeholder)
        # Local development may keep the example value.
        self.settings_for(DJANGO_SECRET_KEY=placeholder, DJANGO_DEBUG="true")

    def test_missing_or_empty_secrets_are_refused(self):
        self.assert_refused("DJANGO_SECRET_KEY is empty", DJANGO_SECRET_KEY=" ")
        self.assert_refused("AGENT_TOKEN_PEPPER is empty", AGENT_TOKEN_PEPPER="")

    def test_invalid_values_are_errors_not_silent_defaults(self):
        self.assert_refused("must be true or false", DJANGO_SESSION_COOKIE_SECURE="ture")
        self.assert_refused("must be true or false", DJANGO_DEBUG="maybe")
        self.assert_refused("DJANGO_SECURE_HSTS_SECONDS", DJANGO_SECURE_HSTS_SECONDS="-1")
        self.assert_refused("DJANGO_LOG_LEVEL", DJANGO_LOG_LEVEL="verbose")

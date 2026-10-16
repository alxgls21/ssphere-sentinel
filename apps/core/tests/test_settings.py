"""Production settings behaviour, imported in a subprocess with a clean
environment (settings are evaluated once per process)."""

import json
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase

BASE_DIR = Path(__file__).resolve().parents[3]
# The .env.example of the releases before SENTINEL_DB_ROLES existed (frozen).
LEGACY_ENV_EXAMPLE = BASE_DIR / "tests" / "deployment" / "legacy.env.example"
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
    "SNMP_RETENTION_DAYS": s.SENTINEL_SNMP_RETENTION_DAYS,
    "SNMP_MAX_AGE_DAYS": s.SENTINEL_SNMP_MAX_AGE_DAYS,
    "DATABASES": s.DATABASES,
}))
"""


def load_settings(**overrides):
    # None removes a variable.
    env = {name: value for name, value in {**BASE_ENV, **overrides}.items() if value is not None}
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

    def test_snmp_retention_defaults_and_overrides(self):
        conf = self.settings_for()
        self.assertEqual((conf["SNMP_RETENTION_DAYS"], conf["SNMP_MAX_AGE_DAYS"]), (30, 8))
        conf = self.settings_for(SENTINEL_SNMP_RETENTION_DAYS="90", SENTINEL_SNMP_MAX_AGE_DAYS="14")
        self.assertEqual((conf["SNMP_RETENTION_DAYS"], conf["SNMP_MAX_AGE_DAYS"]), (90, 14))

    def test_invalid_snmp_retention_settings_are_refused(self):
        for name in ("SENTINEL_SNMP_RETENTION_DAYS", "SENTINEL_SNMP_MAX_AGE_DAYS"):
            for value in ("0", "-3"):
                with self.subTest(name=name, value=value):
                    self.assert_refused("must be a positive integer", **{name: value})
            with self.subTest(name=name, value="soon"):
                self.assert_refused("must be an integer", **{name: "soon"})

    def test_an_existing_installation_keeps_its_database_settings(self):
        # The engine is Django's PostgreSQL backend with the check of sentinel/postgresql.
        expected = {
            "ENGINE": "sentinel.postgresql",
            "NAME": "sentinel",
            "USER": "sentinel",
            "PASSWORD": "unused",
            "HOST": "localhost",
            "PORT": "5432",
            "OPTIONS": {"connect_timeout": 10},
        }
        self.assertEqual(self.settings_for()["DATABASES"], {"default": expected})
        # The same from an .env made with the example of those releases.
        legacy = {}
        for line in LEGACY_ENV_EXAMPLE.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                name, _, value = line.partition("=")
                legacy[name.strip()] = value.strip()
        legacy.update(DJANGO_SECRET_KEY=BASE_ENV["DJANGO_SECRET_KEY"], AGENT_TOKEN_PEPPER="test-only-pepper")
        conf = self.settings_for(**legacy)["DATABASES"]["default"]
        self.assertEqual(
            {key: conf[key] for key in ("USER", "PASSWORD", "OPTIONS")},
            {"USER": "sentinel", "PASSWORD": "change-me-db-password", "OPTIONS": {"connect_timeout": 10}},
        )

    def test_separate_database_roles_select_the_login_of_each_service(self):
        # Without the bootstrap superuser's password, which neither service gets.
        separate = {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_PASSWORD": "app-secret", "POSTGRES_PASSWORD": None}
        web = self.settings_for(**separate)["DATABASES"]["default"]
        self.assertEqual((web["USER"], web["PASSWORD"]), ("sentinel_app", "app-secret"))
        self.assertEqual(web["OPTIONS"], {"connect_timeout": 10})
        migrate = self.settings_for(
            SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate", SENTINEL_DB_MIGRATE_PASSWORD="migrate-secret",
            POSTGRES_PASSWORD=None,
        )["DATABASES"]["default"]
        self.assertEqual((migrate["USER"], migrate["PASSWORD"]), ("sentinel_migrate", "migrate-secret"))
        self.assertEqual(migrate["OPTIONS"], {"connect_timeout": 10, "assume_role": "sentinel_owner"})

    def test_invalid_database_role_settings_are_refused(self):
        self.assert_refused("SENTINEL_DB_ROLES must be one of", SENTINEL_DB_ROLES="yes")
        self.assert_refused("SENTINEL_DB_PASSWORD is not set", SENTINEL_DB_ROLES="separate", POSTGRES_PASSWORD=None)
        self.assert_refused(
            "SENTINEL_DB_MIGRATE_PASSWORD is empty",
            SENTINEL_DB_ROLES="separate",
            SENTINEL_DB_ACCESS="migrate",
            SENTINEL_DB_MIGRATE_PASSWORD="",
            POSTGRES_PASSWORD=None,
        )

    def test_a_password_that_is_not_the_process_own_stops_every_command(self):
        # sentinel/database.py check_passwords: the settings run it for Gunicorn and manage.py alike.
        self.assert_refused(
            "POSTGRES_PASSWORD is set, but with SENTINEL_DB_ROLES=separate",
            SENTINEL_DB_ROLES="separate", SENTINEL_DB_PASSWORD="app-secret",
        )
        self.assert_refused(
            "SENTINEL_DB_PASSWORD is set, but with SENTINEL_DB_ROLES=separate",
            SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate", SENTINEL_DB_MIGRATE_PASSWORD="migrate-secret",
            SENTINEL_DB_PASSWORD="app-secret", POSTGRES_PASSWORD=None,
        )
        self.assert_refused("but SENTINEL_DB_ROLES is legacy", SENTINEL_DB_MIGRATE_PASSWORD="migrate-secret")
        result = load_settings(SENTINEL_DB_ROLES="separate", SENTINEL_DB_PASSWORD="app-secret")
        self.assertNotIn("unused", result.stderr)  # the value of POSTGRES_PASSWORD
        self.assertNotIn("app-secret", result.stderr)

"""Which PostgreSQL login a process uses (sentinel/database.py)."""

import io
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import psycopg
from django.test import SimpleTestCase

from sentinel import database

LEGACY_ENV = {"POSTGRES_DB": "sentinel", "POSTGRES_USER": "sentinel", "POSTGRES_PASSWORD": "db-password"}
SEPARATE_ENV = {
    **LEGACY_ENV,
    "SENTINEL_DB_ROLES": "separate",
    "SENTINEL_DB_PASSWORD": "app-password",
    "SENTINEL_DB_MIGRATE_PASSWORD": "migrate-password",
}


class LoginTests(SimpleTestCase):
    def test_without_the_setting_the_installation_keeps_its_single_role(self):
        for extra in ({}, {"SENTINEL_DB_ROLES": ""}, {"SENTINEL_DB_ROLES": "legacy"}, {"SENTINEL_DB_ACCESS": "migrate"}):
            with self.subTest(extra=extra):
                login = database.login({**LEGACY_ENV, **extra})
                self.assertEqual(login, database.Login("sentinel", "db-password", {}))

    def test_legacy_requires_what_it_always_required_and_allows_an_empty_password(self):
        for name in ("POSTGRES_USER", "POSTGRES_PASSWORD"):
            environment = {key: value for key, value in LEGACY_ENV.items() if key != name}
            with self.subTest(name=name), self.assertRaisesMessage(
                RuntimeError, f"Required environment variable {name} is not set"
            ):
                database.login(environment)
        self.assertEqual(database.login({**LEGACY_ENV, "POSTGRES_PASSWORD": ""}).password, "")

    def test_separate_runtime_uses_the_application_login_only(self):
        login = database.login({**SEPARATE_ENV, "SENTINEL_DB_ACCESS": "runtime"})
        self.assertEqual(login, database.Login("sentinel_app", "app-password", {}))
        self.assertEqual(database.login(SEPARATE_ENV), login)  # runtime is the default

    def test_separate_migrate_switches_to_the_owner_role(self):
        login = database.login({**SEPARATE_ENV, "SENTINEL_DB_ACCESS": "migrate"})
        self.assertEqual(login, database.Login("sentinel_migrate", "migrate-password", {"assume_role": "sentinel_owner"}))

    def test_separate_logins_need_neither_the_bootstrap_credentials_nor_each_other(self):
        runtime = {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_PASSWORD": "app-password"}
        self.assertEqual(database.login(runtime).user, "sentinel_app")
        migrate = {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate", "SENTINEL_DB_MIGRATE_PASSWORD": "m"}
        self.assertEqual(database.login(migrate).user, "sentinel_migrate")

    def test_a_separate_login_without_its_password_is_refused(self):
        cases = (
            ("runtime", "SENTINEL_DB_PASSWORD", None, "is not set"),
            ("runtime", "SENTINEL_DB_PASSWORD", " ", "is empty"),
            ("migrate", "SENTINEL_DB_MIGRATE_PASSWORD", None, "is not set"),
            ("migrate", "SENTINEL_DB_MIGRATE_PASSWORD", "", "is empty"),
        )
        for use, name, value, message in cases:
            environment = {key: v for key, v in SEPARATE_ENV.items() if key != name}
            if value is not None:
                environment[name] = value
            environment["SENTINEL_DB_ACCESS"] = use
            with self.subTest(use=use, value=value), self.assertRaisesMessage(RuntimeError, f"{name} {message}"):
                database.login(environment)

    def test_unknown_values_are_errors_not_a_fallback(self):
        for name, value in (
            ("SENTINEL_DB_ROLES", "Separate"),
            ("SENTINEL_DB_ROLES", "superuser"),
            ("SENTINEL_DB_ACCESS", "owner"),
        ):
            with self.subTest(name=name, value=value), self.assertRaisesMessage(RuntimeError, f"{name} must be one of"):
                database.login({**LEGACY_ENV, name: value})


class CommandTests(SimpleTestCase):
    def run_command(self, argv, environment):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = database.main(["database", *argv], environment)
        return status, out.getvalue(), err.getvalue()

    def test_mode_reports_the_arrangement_and_the_login_in_use(self):
        cases = (
            ({}, "legacy runtime"),
            ({"SENTINEL_DB_ACCESS": "migrate"}, "legacy migrate"),
            ({"SENTINEL_DB_ROLES": "separate"}, "separate runtime"),
            ({"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate"}, "separate migrate"),
        )
        for environment, expected in cases:
            with self.subTest(environment=environment):
                self.assertEqual(self.run_command(["mode"], environment), (0, f"{expected}\n", ""))

    def test_mode_needs_no_credentials_and_refuses_unknown_values(self):
        status, out, err = self.run_command(["mode"], {"SENTINEL_DB_ROLES": "maybe"})
        self.assertEqual((status, out), (2, ""))
        self.assertIn("SENTINEL_DB_ROLES must be one of: legacy, separate", err)

    def test_usage(self):
        self.assertEqual(self.run_command([], {})[0], 2)
        self.assertEqual(self.run_command(["migrate"], {})[0], 2)


class WaitTests(SimpleTestCase):
    def wait(self, environment, connect):
        err = io.StringIO()
        with mock.patch.object(psycopg, "connect", side_effect=connect) as patched, mock.patch.object(
            database.time, "sleep"
        ) as sleep, redirect_stderr(err):
            status = database.main(["database", "wait"], environment)
        return status, patched, sleep, err.getvalue()

    def test_connects_with_the_selected_login(self):
        environment = {**SEPARATE_ENV, "SENTINEL_DB_ACCESS": "migrate", "POSTGRES_HOST": "db", "POSTGRES_PORT": "5432"}
        status, connect, sleep, _ = self.wait(environment, [mock.MagicMock()])
        self.assertEqual(status, 0)
        connect.assert_called_once_with(
            host="db", port="5432", dbname="sentinel", user="sentinel_migrate", password="migrate-password", connect_timeout=3
        )
        sleep.assert_not_called()

    def test_legacy_wait_is_unchanged(self):
        # Same login, defaults, attempts and pauses as the entrypoint always had.
        status, connect, sleep, _ = self.wait(LEGACY_ENV, [psycopg.OperationalError("starting")] * 4 + [mock.MagicMock()])
        self.assertEqual(status, 0)
        self.assertEqual(connect.call_count, 5)
        self.assertEqual(
            connect.call_args.kwargs,
            {"host": "db", "port": "5432", "dbname": "sentinel", "user": "sentinel", "password": "db-password", "connect_timeout": 3},
        )
        self.assertEqual(sleep.call_count, 4)

    def test_gives_up_after_thirty_attempts(self):
        status, connect, sleep, err = self.wait(LEGACY_ENV, psycopg.OperationalError("refused"))
        self.assertEqual(status, 1)
        self.assertEqual(connect.call_count, 30)
        self.assertEqual(sleep.call_count, 29)
        self.assertIn("entrypoint: database unavailable: refused", err)

    def test_a_missing_setting_stops_the_wait_with_a_message(self):
        status, connect, _, err = self.wait({"SENTINEL_DB_ROLES": "separate"}, [mock.MagicMock()])
        self.assertEqual(status, 1)
        connect.assert_not_called()
        self.assertIn("SENTINEL_DB_PASSWORD is not set", err)

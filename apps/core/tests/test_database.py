"""Which PostgreSQL login a process uses (sentinel/database.py)."""

import io
import re
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import psycopg
from django.test import SimpleTestCase

from sentinel import database

LEGACY_ENV = {"POSTGRES_DB": "sentinel", "POSTGRES_USER": "sentinel", "POSTGRES_PASSWORD": "db-password"}
# What web and the migrate service get with the separate logins: their own
# password each, never the bootstrap superuser's.
SEPARATE_ENV = {
    "POSTGRES_DB": "sentinel",
    "POSTGRES_USER": "sentinel",
    "SENTINEL_DB_ROLES": "separate",
    "SENTINEL_DB_PASSWORD": "app-password",
}
MIGRATE_ENV = {
    "POSTGRES_DB": "sentinel",
    "POSTGRES_USER": "sentinel",
    "SENTINEL_DB_ROLES": "separate",
    "SENTINEL_DB_ACCESS": "migrate",
    "SENTINEL_DB_MIGRATE_PASSWORD": "migrate-password",
}

# What the guard query answers: can the login act as a superuser, the login,
# does schema sentinel_restricted exist here, which of the three roles exist.
ROLES = "sentinel_app, sentinel_migrate, sentinel_owner"
ORDINARY = (False, "sentinel_app", True, ROLES)
LEGACY = (True, "sentinel", False, None)
PROVISIONED = (True, "sentinel", True, ROLES)
SECURE_PATH = "SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)"
BUSY = "python -m sentinel.db_roles apply is provisioning the separate logins in this cluster"


def fake_connection(row=LEGACY, *, admitted=..., provisioning=False, failure=None):
    """A psycopg connection whose guard query answers ``row``; the admission answers
    ``admitted`` (by default: the lock, for a superuser login, NULL otherwise), the look
    at the lock ``provisioning``. With ``failure``, every query but the search path raises it."""
    answers = {
        database.ADMISSION_QUERY: ((row[0] or None) if admitted is ... else admitted,),
        database.PROVISIONING_QUERY: (provisioning,),
        database.GUARD_QUERY: row,
    }

    def execute(query):
        if failure is not None and query != SECURE_PATH:
            raise failure
        cursor = mock.MagicMock()
        cursor.fetchone.return_value = answers.get(query)
        return cursor

    connection = mock.MagicMock()
    connection.__enter__.return_value = connection
    connection.execute.side_effect = execute
    return connection


def steps(connection):
    """The queries and rollbacks ``connection`` saw, in order."""
    return [args[0] if name == "execute" else name
            for name, args, _ in connection.mock_calls if name in ("execute", "rollback")]


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
        login = database.login(MIGRATE_ENV)
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
            base = MIGRATE_ENV if use == "migrate" else SEPARATE_ENV
            environment = {key: v for key, v in base.items() if key != name}
            if value is not None:
                environment[name] = value
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


class PasswordIsolationTests(SimpleTestCase):
    """A process never goes on with a password that is not its own."""

    BOOTSTRAP = {"POSTGRES_PASSWORD": "db-password"}
    RUNTIME = {"SENTINEL_DB_PASSWORD": "app-password"}
    MIGRATION = {"SENTINEL_DB_MIGRATE_PASSWORD": "migrate-password"}

    def test_each_separate_process_refuses_every_password_but_its_own(self):
        cases = (
            (SEPARATE_ENV, self.BOOTSTRAP, ["POSTGRES_PASSWORD"]),
            (SEPARATE_ENV, self.MIGRATION, ["SENTINEL_DB_MIGRATE_PASSWORD"]),
            (SEPARATE_ENV, {**self.BOOTSTRAP, **self.MIGRATION}, ["POSTGRES_PASSWORD", "SENTINEL_DB_MIGRATE_PASSWORD"]),
            (MIGRATE_ENV, self.BOOTSTRAP, ["POSTGRES_PASSWORD"]),
            (MIGRATE_ENV, self.RUNTIME, ["SENTINEL_DB_PASSWORD"]),
        )
        for base, extra, names in cases:
            environment = {**base, **extra}
            with self.subTest(access=base.get("SENTINEL_DB_ACCESS", "runtime"), extra=sorted(extra)):
                self.assertEqual(database.foreign_passwords(environment), names)
                with self.assertRaises(RuntimeError) as raised:
                    database.login(environment)
                message = str(raised.exception)
                self.assertIn(f"{' and '.join(names)} {'is' if len(names) == 1 else 'are'} set", message)
                self.assertIn("docs/server-deployment.md", message)
                for secret in ("db-password", "app-password", "migrate-password"):
                    self.assertNotIn(secret, message)

    def test_a_blanked_password_is_no_password(self):
        # compose.yml blanks what a service must not get; an empty value is not one.
        for value in ("", " "):
            with self.subTest(value=value):
                self.assertEqual(database.login({**SEPARATE_ENV, "POSTGRES_PASSWORD": value,
                                                 "SENTINEL_DB_MIGRATE_PASSWORD": value}).user, "sentinel_app")
                self.assertEqual(database.login({**MIGRATE_ENV, "POSTGRES_PASSWORD": value,
                                                 "SENTINEL_DB_PASSWORD": value}).user, "sentinel_migrate")

    def test_legacy_with_a_separate_password_is_a_switch_made_by_half(self):
        # The migrate service, given its env file but not SENTINEL_DB_ROLES, must not
        # report "nothing to do" while web goes on as the superuser.
        for extra in (self.RUNTIME, self.MIGRATION, {**self.RUNTIME, **self.MIGRATION}):
            for access in ("runtime", "migrate"):
                environment = {**LEGACY_ENV, **extra, "SENTINEL_DB_ACCESS": access}
                with self.subTest(extra=sorted(extra), access=access), self.assertRaisesMessage(
                    RuntimeError, "but SENTINEL_DB_ROLES is legacy: set SENTINEL_DB_ROLES=separate"
                ):
                    database.login(environment)
        # An installation that never heard of the separate logins is not concerned.
        self.assertEqual(database.foreign_passwords(LEGACY_ENV), [])

    def test_the_mode_check_refuses_before_anything_runs(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = database.main(["database", "mode"], {**SEPARATE_ENV, **self.BOOTSTRAP})
        self.assertEqual((status, out.getvalue()), (2, ""))
        self.assertIn("entrypoint: POSTGRES_PASSWORD is set, but with SENTINEL_DB_ROLES=separate a process with "
                      "SENTINEL_DB_ACCESS=runtime may only hold SENTINEL_DB_PASSWORD", err.getvalue())
        self.assertNotIn("db-password", err.getvalue())
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            status = database.main(["database", "mode"], {"SENTINEL_DB_ACCESS": "migrate", **self.MIGRATION})
        self.assertEqual(status, 2)
        self.assertNotIn("migrate-password", err.getvalue())


class VerifyTests(SimpleTestCase):
    """The roles, checked after migrations and before web starts, as status checks them."""

    def connection(self, deviation=None, *, failure=None):
        """A connection whose startup check raises ``deviation`` (a message), or whose
        statements but the guard's raise ``failure``."""
        from sentinel import db_roles

        connection = fake_connection(ORDINARY)
        guard = connection.execute.side_effect
        check = db_roles.startup_check("sentinel")

        def execute(query):
            if failure is not None and query.startswith(("REVOKE", "DO $sentinel_startup$")):
                raise failure
            if query == check:
                if deviation is not None:
                    raise psycopg.errors.RaiseException(deviation)
                return mock.MagicMock()
            return guard(query)

        connection.execute.side_effect = execute
        return connection

    def verify(self, environment, connection):
        err = io.StringIO()
        with mock.patch.object(psycopg, "connect", return_value=connection) as connect, redirect_stderr(err):
            status = database.main(["database", "verify"], environment)
        return status, connect, err.getvalue()

    def test_both_services_only_check_in_a_read_only_session(self):
        # Nothing is taken back for the operator: what differs stops the start, before the
        # migrations as after them.
        from sentinel import db_roles

        for environment, user in ((MIGRATE_ENV, "sentinel_migrate"), (SEPARATE_ENV, "sentinel_app")):
            with self.subTest(user=user):
                connection = self.connection()
                status, connect, err = self.verify(environment, connection)
                self.assertEqual((status, err), (0, ""))
                self.assertEqual(connect.call_args.kwargs["user"], user)
                self.assertEqual(connect.call_args.kwargs["options"], "-c default_transaction_read_only=on")
                executed = steps(connection)
                self.assertFalse([step for step in executed if step.startswith(("SET ROLE", "REVOKE", "GRANT"))])
                self.assertLess(executed.index(database.GUARD_QUERY), executed.index(db_roles.startup_check("sentinel")))
                self.assertEqual(executed[-1], "rollback")
                connection.commit.assert_not_called()

    def test_a_deviation_stops_the_start(self):
        for environment in (SEPARATE_ENV, MIGRATE_ENV):
            with self.subTest(access=environment.get("SENTINEL_DB_ACCESS", "runtime")):
                status, _, err = self.verify(environment, self.connection(
                    "sentinel-roles: the runtime role lacks SELECT, or may grant it, on auth_user"))
                self.assertEqual(status, 1)
                self.assertIn("entrypoint: the database roles differ from what Sentinel provisions: "
                              "the runtime role lacks SELECT, or may grant it, on auth_user. ", err)
                self.assertIn("Correct that by hand, as scripts/postgres-roles.sh status names it (apply changes nothing", err)

    def test_a_failure_stops_the_start(self):
        for failure in (psycopg.errors.InsufficientPrivilege("denied"), psycopg.errors.RaiseException("denied")):
            with self.subTest(failure=type(failure).__name__):
                status, _, err = self.verify(MIGRATE_ENV, self.connection(failure=failure))
                self.assertEqual(status, 1)
                self.assertIn("entrypoint: the database roles could not be checked: denied", err)
        # Another error raised by a function the check calls is no deviation, but stops all the same.
        status, _, err = self.verify(SEPARATE_ENV, self.connection("an error of something else"))
        self.assertEqual(status, 1)
        self.assertIn("could not be checked: an error of something else", err)
        status, _, err = self.verify({**SEPARATE_ENV, "SENTINEL_DB_PASSWORD": ""}, self.connection())
        self.assertEqual(status, 1)
        self.assertIn("SENTINEL_DB_PASSWORD is empty", err)
        status, _, err = self.verify({**SEPARATE_ENV, "POSTGRES_PASSWORD": "db-password"}, self.connection())
        self.assertEqual(status, 1)
        self.assertNotIn("db-password", err)

    def test_a_database_the_check_cannot_be_written_for_is_a_deviation(self):
        status, _, err = self.verify({**SEPARATE_ENV, "POSTGRES_DB": "postgres"}, self.connection())
        self.assertEqual(status, 1)
        self.assertIn("entrypoint: the database roles differ from what Sentinel provisions: POSTGRES_DB", err)

    def test_nothing_to_verify_with_one_login(self):
        status, connect, err = self.verify(LEGACY_ENV, self.connection())
        self.assertEqual(status, 2)
        connect.assert_not_called()
        self.assertIn("nothing to verify", err)

    def test_the_runtime_login_reads_django_migrations_and_nothing_takes_privileges_back_later(self):
        self.assertEqual(database.MIGRATIONS_TABLE_PRIVILEGES, (
            "REVOKE ALL ON TABLE public.django_migrations FROM sentinel_app",
            "GRANT SELECT ON TABLE public.django_migrations TO sentinel_app",
        ))
        self.assertFalse(hasattr(database, "SETTLE_STATEMENTS"))
        self.assertFalse(hasattr(database, "settle"))
        # Every path to more than reading: the login itself, PUBLIC (in has_*_privilege), the
        # roles it inherits from and those it may SET ROLE to, on the table or on a column.
        unsafe = " ".join(database.MIGRATIONS_TABLE_UNSAFE.split())
        self.assertIn("a.rolname = 'sentinel_app' AND pg_catalog.pg_has_role(a.oid, r.oid, 'SET')", unsafe)
        self.assertIn("pg_catalog.to_regclass('public.django_migrations') AS record", unsafe)
        self.assertIn("pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER',"
                      " 'SELECT WITH GRANT OPTION', 'REFERENCES WITH GRANT OPTION']) p(privilege)", unsafe)
        self.assertIn("CASE WHEN p.privilege IN ('INSERT', 'UPDATE', 'SELECT WITH GRANT OPTION',"
                      " 'REFERENCES WITH GRANT OPTION') THEN pg_catalog.has_any_column_privilege(r.oid, m.record,"
                      " p.privilege) ELSE pg_catalog.has_table_privilege(r.oid, m.record, p.privilege) END", unsafe)

    def test_django_names_the_table_alike(self):
        from django.db.migrations.recorder import MigrationRecorder

        self.assertEqual(MigrationRecorder.Migration._meta.db_table, database.MIGRATIONS_TABLE)


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
        environment = {**MIGRATE_ENV, "POSTGRES_HOST": "db", "POSTGRES_PORT": "5432"}
        status, connect, sleep, _ = self.wait(environment, [fake_connection(ORDINARY)])
        self.assertEqual(status, 0)
        connect.assert_called_once_with(
            host="db", port="5432", dbname="sentinel", user="sentinel_migrate", password="migrate-password", connect_timeout=3
        )
        sleep.assert_not_called()

    def test_legacy_wait_is_unchanged(self):
        # Same login, defaults, attempts and pauses as the entrypoint always had.
        status, connect, sleep, _ = self.wait(LEGACY_ENV, [psycopg.OperationalError("starting")] * 4 + [fake_connection()])
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
        status, connect, _, err = self.wait({"SENTINEL_DB_ROLES": "separate"}, [fake_connection(ORDINARY)])
        self.assertEqual(status, 1)
        connect.assert_not_called()
        self.assertIn("SENTINEL_DB_PASSWORD is not set", err)

    def test_a_superuser_login_in_a_provisioned_database_stops_at_once(self):
        connection = fake_connection(PROVISIONED)
        status, connect, sleep, err = self.wait(LEGACY_ENV, [connection])
        self.assertEqual(status, 1)
        connect.assert_called_once()
        sleep.assert_not_called()
        self.assertIn("entrypoint: the separate logins are provisioned (schema sentinel_restricted exists in this database)", err)
        self.assertNotIn("db-password", err)
        self.assertEqual(steps(connection)[-1], "rollback")

    def test_a_refused_password_is_not_retried_and_names_its_variable(self):
        refused = psycopg.OperationalError('connection failed: FATAL:  password authentication failed for user "sentinel_app"')
        for environment, variable in (
            (SEPARATE_ENV, "SENTINEL_DB_PASSWORD for sentinel_app"),
            (MIGRATE_ENV, "SENTINEL_DB_MIGRATE_PASSWORD for sentinel_migrate"),
            (LEGACY_ENV, "POSTGRES_PASSWORD for sentinel"),
        ):
            with self.subTest(variable=variable):
                status, connect, sleep, err = self.wait(environment, refused)
                self.assertEqual((status, connect.call_count, sleep.call_count), (1, 1, 0))
                self.assertIn(f"entrypoint: check {variable};", err)
                for secret in ("app-password", "migrate-password", "db-password"):
                    self.assertNotIn(secret, err)

    def test_a_superuser_login_while_apply_runs_stops_at_once(self):
        for settings in ({"admitted": False}, {"provisioning": True}):
            with self.subTest(**settings):
                status, connect, sleep, err = self.wait(LEGACY_ENV, [fake_connection(**settings)])
                self.assertEqual((status, connect.call_count, sleep.call_count), (1, 1, 0))
                self.assertIn(f"entrypoint: {BUSY}", err)

    def test_a_failed_check_stops_the_wait_with_a_message(self):
        connection = fake_connection(failure=psycopg.ProgrammingError("relation does not exist"))
        status, connect, sleep, err = self.wait(LEGACY_ENV, [connection])
        self.assertEqual((status, connect.call_count, sleep.call_count), (1, 1, 0))
        self.assertIn("entrypoint: the database could not be checked: relation does not exist", err)

    def test_a_separate_login_never_falls_back_to_the_bootstrap_one(self):
        # Missing, or refused: either way the wait fails, with POSTGRES_* never tried.
        for environment, connect in (
            ({**SEPARATE_ENV, "SENTINEL_DB_PASSWORD": ""}, [fake_connection(ORDINARY)]),
            (SEPARATE_ENV, psycopg.OperationalError("password authentication failed")),
        ):
            with self.subTest(environment=sorted(environment)):
                status, patched, _, _ = self.wait(environment, connect)
                self.assertEqual(status, 1)
                for call in patched.call_args_list:
                    self.assertEqual(call.kwargs["user"], "sentinel_app")


class GuardTests(SimpleTestCase):
    """The check of every new connection (refusal, check)."""

    def test_a_login_that_cannot_act_as_a_superuser_is_never_refused(self):
        for row in (ORDINARY, (False, "sentinel_migrate", True, ROLES), (False, "someone", False, None)):
            with self.subTest(row=row):
                self.assertIsNone(database.refusal(fake_connection(row)))

    def test_a_superuser_login_is_refused_on_either_evidence(self):
        self.assertIsNone(database.refusal(fake_connection(LEGACY)))  # an installation that never had separate logins
        schema = database.refusal(fake_connection((True, "sentinel", True, None)))
        self.assertIn("(schema sentinel_restricted exists in this database), and sentinel, a superuser login, may not be used", schema)
        # Another database of the cluster: the roles are the cluster's.
        roles = database.refusal(fake_connection((True, "postgres", False, ROLES)))
        self.assertIn(f"(the cluster has the roles {ROLES}), and postgres", roles)
        with self.assertRaisesMessage(database.SuperuserRefused, "may not be used for Sentinel there"):
            database.check(fake_connection(PROVISIONED))

    def test_the_refusal_says_what_to_do(self):
        message = database.refusal(fake_connection(PROVISIONED))
        for text in ("SENTINEL_DB_ROLES=separate", "sentinel_app (SENTINEL_DB_PASSWORD)",
                     "sentinel_migrate (SENTINEL_DB_MIGRATE_PASSWORD)", "python -m sentinel.db_roles apply"):
            self.assertIn(text, message)

    def test_the_check_runs_with_the_catalog_first_and_leaves_nothing_behind(self):
        # Each query in a transaction of its own: the evidence is read with a snapshot
        # taken after the lock and the look at it.
        superuser = fake_connection(PROVISIONED)
        database.refusal(superuser)
        self.assertEqual(steps(superuser), [
            SECURE_PATH, database.ADMISSION_QUERY, "rollback",
            SECURE_PATH, database.PROVISIONING_QUERY, "rollback",
            SECURE_PATH, database.GUARD_QUERY, "rollback",
        ])
        ordinary = fake_connection(ORDINARY)
        database.refusal(ordinary)
        self.assertEqual(steps(ordinary), [SECURE_PATH, database.ADMISSION_QUERY, "rollback", SECURE_PATH, database.GUARD_QUERY, "rollback"])
        failing = fake_connection(failure=psycopg.OperationalError("gone"))
        with self.assertRaises(psycopg.OperationalError):
            database.refusal(failing)
        self.assertEqual(steps(failing), [SECURE_PATH, database.ADMISSION_QUERY, "rollback"])

    def test_a_superuser_login_is_not_admitted_while_apply_runs(self):
        # The lock is held exclusively in this database (no lock), or apply holds it in
        # another one (seen in pg_locks): refused before the evidence, which is not read.
        for settings in ({"admitted": False}, {"provisioning": True}):
            with self.subTest(**settings):
                connection = fake_connection(LEGACY, **settings)
                self.assertIn(BUSY, database.refusal(connection))
                self.assertNotIn(database.GUARD_QUERY, steps(connection))
                with self.assertRaisesMessage(database.SuperuserRefused, BUSY):
                    database.check(fake_connection(LEGACY, **settings))
        # A login that cannot act as a superuser takes no lock and is not concerned.
        self.assertIsNone(database.refusal(fake_connection(ORDINARY, provisioning=True)))
        self.assertNotIn(database.PROVISIONING_QUERY, steps(fake_connection(ORDINARY, provisioning=True)))

    def test_the_lock_is_shared_held_by_the_session_and_looked_for_in_the_whole_cluster(self):
        from sentinel import db_roles

        self.assertEqual(database.PROVISIONING_LOCK, int.from_bytes(b"SENTINEL", "big"))
        self.assertEqual(db_roles.ADVISORY_LOCK_KEY, database.PROVISIONING_LOCK)
        admission = " ".join(database.ADMISSION_QUERY.split())
        superuser = " ".join(database.SUPERUSER.split())
        self.assertEqual(admission, f"SELECT CASE WHEN {superuser} THEN pg_catalog.pg_try_advisory_lock_shared({database.PROVISIONING_LOCK}) END")
        # Shared, and kept until the session ends: never the transaction-scoped variant.
        self.assertNotIn("xact", admission)
        provisioning = " ".join(database.PROVISIONING_QUERY.split())
        high, low = int.from_bytes(b"SENT", "big"), int.from_bytes(b"INEL", "big")
        self.assertIn("FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND objsubid = 1"
                      f" AND classid = {high} AND objid = {low}", provisioning)
        # Every database, and waiting as well as granted.
        self.assertNotIn("database", provisioning)
        self.assertNotIn("granted", provisioning)
        for query in (admission, provisioning):
            self.assertEqual(re.findall(r"(?<![\w.])(?!pg_catalog\b)(pg_\w+)", query), [])

    def test_the_query_asks_about_the_login_not_the_current_role(self):
        # A superuser login that switched roles at once (PGOPTIONS="-c role=...") is still one.
        query = " ".join(database.GUARD_QUERY.split())
        self.assertIn("WHERE r.rolsuper AND pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')", query)
        self.assertNotIn("current_user", query)
        self.assertNotIn("is_superuser", query)
        self.assertIn("WHERE nspname = 'sentinel_restricted'", query)
        self.assertIn("WHERE rolname IN ('sentinel_owner', 'sentinel_migrate', 'sentinel_app')", query)
        # Nothing that fails in a database without schema public.
        self.assertNotIn("regnamespace", query)
        # Catalogs and functions only from pg_catalog: the session's search_path is the database's.
        self.assertEqual(re.findall(r"(?<![\w.])(?!pg_catalog\b)(pg_\w+)", query), [])


class BackendTests(SimpleTestCase):
    """Django's connections go through sentinel/postgresql."""

    def test_the_settings_use_it(self):
        from django.db import connections

        from sentinel.postgresql.base import DatabaseSchemaEditor, DatabaseWrapper

        self.assertIsInstance(connections["default"], DatabaseWrapper)
        self.assertIs(connections["default"].SchemaEditorClass, DatabaseSchemaEditor)

    def wrapper(self, raw):
        from django.db import connections

        from sentinel.postgresql.base import DatabaseWrapper

        wrapper = DatabaseWrapper({**connections["default"].settings_dict}, alias="guard")
        patch = mock.patch("django.db.backends.postgresql.base.DatabaseWrapper.get_new_connection", return_value=raw)
        return wrapper, patch

    def test_a_refused_connection_is_closed_and_not_returned(self):
        raw = fake_connection(PROVISIONED)
        wrapper, patch = self.wrapper(raw)
        with patch, self.assertRaises(database.SuperuserRefused):
            wrapper.get_new_connection({})
        raw.close.assert_called_once()

    def test_an_allowed_connection_is_returned_open(self):
        for row in (ORDINARY, LEGACY):
            with self.subTest(row=row):
                raw = fake_connection(row)
                wrapper, patch = self.wrapper(raw)
                with patch:
                    self.assertIs(wrapper.get_new_connection({}), raw)
                raw.close.assert_not_called()

    def editor(self, options, *, atomic=True, unsafe=None):
        """The schema editor of a connection with ``options``, and what it would run: Django's
        own CREATE TABLE stands in as one statement."""
        from django.db import connections

        from sentinel.postgresql.base import DatabaseWrapper

        wrapper = DatabaseWrapper({**connections["default"].settings_dict, "OPTIONS": options}, alias="schema")
        wrapper.in_atomic_block = atomic
        executed = []
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.execute.side_effect = executed.append
        cursor.fetchone.return_value = (unsafe,)
        wrapper.cursor = mock.MagicMock(return_value=cursor)
        editor = wrapper.schema_editor()
        editor.execute = lambda statement, params=(): executed.append(statement)
        create = mock.patch("django.db.backends.postgresql.schema.DatabaseSchemaEditor.create_model",
                            lambda _, model: executed.append(f"CREATE TABLE {model._meta.db_table}"))
        return editor, executed, create

    def test_django_migrations_is_created_with_the_runtime_login_reading_it_only(self):
        from django.db.migrations.recorder import MigrationRecorder

        editor, executed, create = self.editor({"assume_role": "sentinel_owner"})
        with create:
            editor.create_model(MigrationRecorder.Migration)
        self.assertEqual(executed, ["CREATE TABLE django_migrations", *database.MIGRATIONS_TABLE_PRIVILEGES,
                                    database.MIGRATIONS_TABLE_UNSAFE])

    def test_a_record_the_runtime_login_could_still_write_is_never_committed(self):
        # Raised inside the transaction that created it: the table goes with it.
        from django.db import DatabaseError
        from django.db.migrations.recorder import MigrationRecorder

        editor, executed, create = self.editor({"assume_role": "sentinel_owner"}, unsafe="UPDATE as sentinel_app")
        with create, self.assertRaisesMessage(
            DatabaseError, "sentinel_app could change django_migrations, which decides what migrate runs, or hand a "
            "privilege on it on (UPDATE as sentinel_app)"
        ):
            editor.create_model(MigrationRecorder.Migration)
        self.assertEqual(executed[-1], database.MIGRATIONS_TABLE_UNSAFE)

    def test_django_migrations_is_never_created_outside_a_transaction(self):
        # It would be committed with the default privileges before they are taken back.
        from django.db.migrations.recorder import MigrationRecorder
        from django.db.transaction import TransactionManagementError

        editor, executed, create = self.editor({"assume_role": "sentinel_owner"}, atomic=False)
        with create, self.assertRaisesMessage(TransactionManagementError, "in a transaction with its privileges"):
            editor.create_model(MigrationRecorder.Migration)
        self.assertEqual(executed, [])

    def test_other_tables_and_the_legacy_login_are_created_as_django_creates_them(self):
        from django.contrib.auth.models import Group
        from django.db.migrations.recorder import MigrationRecorder

        for options, model in (({"assume_role": "sentinel_owner"}, Group), ({}, MigrationRecorder.Migration)):
            with self.subTest(options=options, table=model._meta.db_table):
                editor, executed, create = self.editor(options, atomic=False)
                with create:
                    editor.create_model(model)
                self.assertEqual(executed, [f"CREATE TABLE {model._meta.db_table}"])

    def guard(self, unsafe):
        """The wrapper's prepare_database with a record the query finds ``unsafe`` (None: safe),
        and what it ran, in what transaction."""
        from django.db import connections

        from sentinel.postgresql.base import DatabaseWrapper

        wrapper = DatabaseWrapper({**connections["default"].settings_dict}, alias="guard")
        steps = []
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.execute.side_effect = steps.append
        cursor.fetchone.return_value = (unsafe,)
        wrapper.cursor = mock.MagicMock(return_value=cursor)
        transaction = mock.MagicMock()
        transaction.atomic.return_value.__enter__.side_effect = lambda: steps.append("BEGIN")
        transaction.atomic.return_value.__exit__.side_effect = lambda *_: steps.append("END")
        transaction.set_rollback.side_effect = lambda rollback, using: steps.append(f"ROLLBACK {rollback} {using}")
        return wrapper, steps, transaction

    def test_migrate_reads_the_record_first_in_a_read_only_transaction_it_rolls_back(self):
        wrapper, steps, transaction = self.guard(None)
        with mock.patch("sentinel.postgresql.base.transaction", transaction):
            wrapper.prepare_database()
        transaction.atomic.assert_called_once_with(using="guard")
        self.assertEqual(steps, ["BEGIN", "SET TRANSACTION READ ONLY", database.MIGRATIONS_TABLE_UNSAFE,
                                 "ROLLBACK True guard", "END"])

    def test_migrate_stops_on_a_record_the_runtime_login_could_change(self):
        from django.core.management import CommandError

        wrapper, steps, transaction = self.guard("INSERT as sentinel_app, UPDATE as sentinel_writer")
        with mock.patch("sentinel.postgresql.base.transaction", transaction), self.assertRaisesMessage(
            CommandError, "nothing was migrated: sentinel_app could change django_migrations, which decides what "
            "migrate runs, or hand a privilege on it on (INSERT as sentinel_app, UPDATE as sentinel_writer)"
        ):
            wrapper.prepare_database()
        self.assertEqual(steps[-2:], ["ROLLBACK True guard", "END"])

    def test_django_migrate_runs_the_check_before_anything_else(self):
        # Before it reads which migrations are pending (the executor), prunes, emits
        # pre_migrate, creates a table or records a migration: whatever started it.
        from django.core.management import call_command
        from django.db import connections

        with mock.patch.object(connections["default"], "prepare_database", side_effect=RuntimeError("refused")), \
                mock.patch("django.core.management.commands.migrate.MigrationExecutor") as executor, \
                mock.patch("django.core.management.commands.migrate.emit_pre_migrate_signal") as pre_migrate, \
                self.assertRaisesMessage(RuntimeError, "refused"):
            call_command("migrate", "--noinput", verbosity=0)
        executor.assert_not_called()
        pre_migrate.assert_not_called()

    def test_dbshell_is_disabled_and_starts_nothing(self):
        # psql would connect by itself, as whoever its arguments, environment, service
        # and startup files or \connect choose: no check could follow it.
        from django.core.management import CommandError, call_command
        from django.db import connections

        from sentinel.postgresql.base import DatabaseClient

        self.assertIsInstance(connections["default"].client, DatabaseClient)
        with mock.patch("subprocess.run") as run, mock.patch("subprocess.Popen") as popen, \
                mock.patch.object(connections["default"], "ensure_connection") as connect, \
                self.assertRaisesMessage(CommandError, "dbshell is disabled"):
            call_command("dbshell", "--", "--dbname", "host=elsewhere user=postgres")
        run.assert_not_called()
        popen.assert_not_called()
        connect.assert_not_called()

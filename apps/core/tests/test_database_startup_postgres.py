"""How Sentinel starts with the separate logins: each process holds its own
password only, nothing starts before the operator has provisioned the logins,
and the runtime login is checked after every migration and before web serves
(sentinel/database.py ``verify``).

Run against the disposable cluster SENTINEL_TEST_POSTGRES names (see
test_db_roles_postgres.py, whose conditions apply). scripts/postgres-roles.sh
runs with a stand-in for docker: `docker compose config` prints a configuration
of the test's, and `docker compose exec db` runs its command here, with psql
connected to the test's database as the superuser.
"""

import io
import json
import os
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from apps.core.tests.test_database_guard_postgres import ROOT, STARTED, ApplicationTestCase
from apps.core.tests.test_db_roles_postgres import ROLES, SERVER
from sentinel import database, db_roles

VERIFIED = "entrypoint: verifying the privileges of the runtime login"
AUTHENTICATION_FAILED = "password authentication failed"
ADMISSION = "entrypoint: checking the database roles before anything runs"
APPLYING = "entrypoint: applying database migrations"
REFUSED_AS_IT_IS = "entrypoint: the database roles differ from what Sentinel provisions: "
# What a stolen sentinel_app password lets a client do to Django's record of the migrations,
# connected to PostgreSQL itself, with no Sentinel process running: each write, rolled back.
RECORD_WRITES = {
    "INSERT": "INSERT INTO public.django_migrations (app, name, applied) VALUES ('sentinel_probe', '0001_probe', now())",
    "UPDATE": "UPDATE public.django_migrations SET name = name",
    "DELETE": "DELETE FROM public.django_migrations",
}
ABSENT = dict.fromkeys(RECORD_WRITES, "UndefinedTable")
DENIED = dict.fromkeys(RECORD_WRITES, "InsufficientPrivilege")
# Django creating the record, as the migrate service's login, held open before it commits: it
# prints its backend and what sentinel_app could do as its own transaction sees the table, then
# commits when told to and rolls back otherwise.
CREATION = """\
import sys
from django.db import connection, transaction
from django.db.migrations.recorder import MigrationRecorder
with transaction.atomic():
    MigrationRecorder(connection).ensure_schema()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT pg_catalog.pg_backend_pid(),"
            " pg_catalog.has_any_column_privilege('sentinel_app', 'public.django_migrations', 'INSERT'),"
            " pg_catalog.has_any_column_privilege('sentinel_app', 'public.django_migrations', 'UPDATE'),"
            " pg_catalog.has_table_privilege('sentinel_app', 'public.django_migrations', 'DELETE')")
        print("created", *cursor.fetchone(), flush=True)
    if sys.stdin.readline().strip() != "commit":
        raise SystemExit("rolled back")
print("committed", flush=True)
"""
# The check migrate runs first (sentinel/postgresql prepare_database), its query replaced by a
# write this session, the owner's, could make anywhere else: on its own, then inside a
# transaction already open; and what the session may do afterwards.
GUARD_PROBE = """\
from unittest import mock
from django.db import connection, transaction
from sentinel import database
write = ("WITH probe AS (INSERT INTO public.auth_group (name) VALUES ('sentinel guard probe') RETURNING id)"
         " SELECT NULL FROM probe")
def guard(where):
    with mock.patch.object(database, "MIGRATIONS_TABLE_UNSAFE", write):
        try:
            connection.prepare_database()
            print(where, "written")
        except Exception as exc:
            print(where, "refused", type(exc.__cause__ or exc).__name__)
def afterwards(where):
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO public.auth_group (name) VALUES (%s) RETURNING id", [f"sentinel guard probe {where}"])
        print(where, "writable" if cursor.fetchone() else "?")
guard("alone")
with transaction.atomic():
    afterwards("before")
    guard("nested")
    afterwards("after")
    transaction.set_rollback(True)
"""
# What verify runs, replaced by a write as each login could make it outside the check's
# session: refused by PostgreSQL there, or reported.
VERIFY_PROBE = """\
DO $probe$
BEGIN
  BEGIN
    IF current_user = 'sentinel_migrate' THEN
      SET LOCAL ROLE sentinel_owner;
    END IF;
    INSERT INTO public.auth_group (name) VALUES ('sentinel verify probe');
  EXCEPTION WHEN read_only_sql_transaction THEN
    RETURN;
  END;
  RAISE EXCEPTION 'sentinel-roles: the check ran in a session that could write';
END
$probe$;
"""
DOCKER = """#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
if [ "$1 $2 $3 $4" = "compose config --format json" ]; then
    exec cat "$DOCKER_CONFIG"
fi
if [ "$1 $2 $3 $4 $5 $6" = "compose exec -T db sh -c" ] && [ $# -eq 7 ]; then
    export POSTGRES_USER="$DB_USER" POSTGRES_DB="$DB_NAME"
    if [ -n "${DB_CUT:-}" ]; then
        head -n "$DB_CUT" | sh -c "$7"
        exit
    fi
    exec sh -c "$7"
fi
exit 98
"""


class StartupTests(ApplicationTestCase):
    def privileges(self, table):
        """The privileges sentinel_app holds on ``table``, on the table or on any column."""
        held = set()
        maintain = ("MAINTAIN",) if self.value("SELECT pg_catalog.current_setting('server_version_num')::integer") >= 170000 else ()
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", *maintain):
            function = "has_any_column_privilege" if privilege in ("SELECT", "INSERT", "UPDATE", "REFERENCES") \
                else "has_table_privilege"
            if self.value(f"SELECT pg_catalog.{function}('sentinel_app', %s::regclass, %s)", table, privilege):
                held.add(privilege)
        return held

    def assertRefusedAsItIs(self, result, problem):
        self.assertNoSecret(result)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn(REFUSED_AS_IT_IS, result.stderr)
        self.assertIn(problem, result.stderr)

    def assertNoSecret(self, result):
        """No password in what the process printed: checked before any assertion that would print
        it, and the password with it."""
        for secret in (*self.passwords, self.superuser[1]):
            if secret:
                self.assertFalse(secret in result.stdout + result.stderr, "a password is in the output")

    def test_the_migrate_service_leaves_the_runtime_login_select_only_on_django_migrations(self):
        self.assertSucceeds(self.apply)
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stderr.index(ADMISSION), result.stderr.index(APPLYING))
        self.assertIn(VERIFIED, result.stderr)
        # migrate created django_migrations as the owner, whose default privileges give the
        # runtime INSERT, UPDATE and DELETE; the transaction that created it took them back.
        self.assertEqual(self.privileges("django_migrations"), {"SELECT"})
        self.assertEqual(self.privileges("auth_group"), {"SELECT", "INSERT", "UPDATE", "DELETE"})
        result = self.web()
        self.assertStarted(result)
        self.assertIn(VERIFIED, result.stderr)
        # Every start does the same, and changes nothing more.
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertEqual(self.privileges("django_migrations"), {"SELECT"})

    def as_runtime(self, statement, database=None):
        """Run ``statement`` as sentinel_app and roll it back: None when PostgreSQL
        allows it, else the error."""
        conninfo = make_conninfo(SERVER, dbname=database or self.database, user="sentinel_app",
                                 password=self.passwords[0])
        with psycopg.connect(conninfo) as connection:
            try:
                connection.execute(statement)
            except psycopg.Error as exc:
                return exc
            finally:
                connection.rollback()
        return None

    def test_a_role_that_may_do_more_or_less_stops_both_services(self):
        # Each case: what an administrator could change, what it undoes, what
        # sentinel_app could then do (or no longer do), and the refusal.
        self.restricted_installation()
        database = sql.Identifier(self.database)
        owner = sql.SQL("SET ROLE sentinel_owner; ")
        probe_database = f"sentinel-probe-{secrets.token_hex(4)}"
        cases = (
            # Database CREATE, held directly or through PUBLIC, here or in another database (postgres,
            # the other one a cluster of Sentinel's own has).
            (sql.SQL("GRANT CREATE ON DATABASE {} TO sentinel_app").format(database),
             sql.SQL("REVOKE CREATE ON DATABASE {} FROM sentinel_app").format(database),
             ("CREATE SCHEMA sentinel_probe", None),
             "a managed role may create schemas in database(s) " + self.database),
            (sql.SQL("GRANT CREATE ON DATABASE {} TO PUBLIC").format(database),
             sql.SQL("REVOKE CREATE ON DATABASE {} FROM PUBLIC").format(database),
             ("CREATE SCHEMA sentinel_probe", None),
             "a managed role may create schemas in database(s) " + self.database),
            (sql.SQL("GRANT CONNECT, CREATE ON DATABASE postgres TO PUBLIC"),
             sql.SQL("REVOKE CONNECT, CREATE ON DATABASE postgres FROM PUBLIC"),
             ("CREATE SCHEMA sentinel_probe", "postgres"),
             "a managed role may create schemas in database(s) postgres"),
            # Grant options: the runtime login could hand its privileges on.
            (owner + sql.SQL("GRANT SELECT ON auth_user TO sentinel_app WITH GRANT OPTION"),
             owner + sql.SQL("REVOKE GRANT OPTION FOR SELECT ON auth_user FROM sentinel_app"),
             ("GRANT SELECT ON auth_user TO PUBLIC", None),
             "the runtime role lacks SELECT, or may grant it, on auth_user"),
            (owner + sql.SQL("GRANT UPDATE (username) ON auth_user TO sentinel_app WITH GRANT OPTION"),
             owner + sql.SQL("REVOKE UPDATE (username) ON auth_user FROM sentinel_app"),
             ("GRANT UPDATE (username) ON auth_user TO PUBLIC", None),
             "the runtime role has column privileges in schema public"),
            (sql.SQL("GRANT USAGE ON SCHEMA public TO sentinel_app WITH GRANT OPTION"),
             sql.SQL("REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM sentinel_app"),
             ("GRANT USAGE ON SCHEMA public TO PUBLIC", None),
             "the roles hold other privileges on the database or on schema public"),
            (sql.SQL("GRANT CONNECT ON DATABASE {} TO sentinel_app WITH GRANT OPTION").format(database),
             sql.SQL("REVOKE GRANT OPTION FOR CONNECT ON DATABASE {} FROM sentinel_app").format(database),
             (sql.SQL("GRANT CONNECT ON DATABASE {} TO sentinel_migrate").format(database), None),
             "the roles hold other privileges on the database or on schema public"),
            (owner + sql.SQL("CREATE SEQUENCE public.sentinel_probe; "
                             "GRANT USAGE ON SEQUENCE public.sentinel_probe TO sentinel_app WITH GRANT OPTION"),
             owner + sql.SQL("DROP SEQUENCE public.sentinel_probe"),
             ("GRANT USAGE ON SEQUENCE public.sentinel_probe TO PUBLIC", None),
             "the runtime role has privileges on sequence sentinel_probe"),
            # Schemas, tables and attributes.
            (sql.SQL("GRANT CREATE ON SCHEMA public TO sentinel_app"),
             sql.SQL("REVOKE CREATE ON SCHEMA public FROM sentinel_app"),
             ("CREATE TABLE public.sentinel_probe (id integer)", None),
             "the roles hold other privileges on the database or on schema public"),
            (sql.SQL("CREATE SCHEMA sentinel_elsewhere; GRANT USAGE, CREATE ON SCHEMA sentinel_elsewhere TO sentinel_app"),
             sql.SQL("DROP SCHEMA sentinel_elsewhere"),
             ("CREATE TABLE sentinel_elsewhere.probe (id integer)", None),
             "a managed role may create objects in schema(s) sentinel_elsewhere"),
            (sql.SQL("GRANT TEMPORARY ON DATABASE {} TO sentinel_app").format(database),
             sql.SQL("REVOKE TEMPORARY ON DATABASE {} FROM sentinel_app").format(database),
             ("CREATE TEMPORARY TABLE sentinel_probe (id integer)", None),
             "TEMPORARY"),
            (sql.SQL("GRANT CONNECT, TEMPORARY ON DATABASE postgres TO PUBLIC"),
             sql.SQL("REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC"),
             ("CREATE TEMPORARY TABLE sentinel_probe (id integer)", "postgres"),
             "TEMPORARY"),
            (sql.SQL("GRANT TRUNCATE ON django_session TO sentinel_app"),
             sql.SQL("REVOKE TRUNCATE ON django_session FROM sentinel_app"),
             ("TRUNCATE django_session", None),
             "the runtime role has TRUNCATE on django_session"),
            (sql.SQL("GRANT TRUNCATE ON django_session TO PUBLIC"),
             sql.SQL("REVOKE TRUNCATE ON django_session FROM PUBLIC"),
             ("TRUNCATE django_session", None),
             "the runtime role has TRUNCATE on django_session"),
            (sql.SQL("GRANT TRIGGER ON auth_group TO sentinel_app"),
             sql.SQL("REVOKE TRIGGER ON auth_group FROM sentinel_app"),
             None,
             "the runtime role has TRIGGER on auth_group"),
            (sql.SQL("GRANT REFERENCES (name) ON auth_group TO sentinel_app"),
             sql.SQL("REVOKE REFERENCES (name) ON auth_group FROM sentinel_app"),
             None,
             "the runtime role has REFERENCES on auth_group"),
            (sql.SQL("ALTER ROLE sentinel_app CREATEDB"), sql.SQL("ALTER ROLE sentinel_app NOCREATEDB"),
             (sql.SQL("CREATE DATABASE {}").format(sql.Identifier(probe_database)), "autocommit"),
             "a managed role has an attribute it must not have"),
            (sql.SQL("GRANT pg_read_all_data TO sentinel_app"), sql.SQL("REVOKE pg_read_all_data FROM sentinel_app"),
             ("SELECT FROM pg_catalog.pg_class LIMIT 0", None),
             "role memberships differ"),
            (owner + sql.SQL("REVOKE DELETE ON auth_group FROM sentinel_app"),
             owner + sql.SQL("GRANT DELETE ON auth_group TO sentinel_app"),
             None,
             "the runtime role lacks DELETE, or may grant it, on auth_group"),
            (sql.SQL("ALTER TABLE auth_group OWNER TO CURRENT_USER"),
             sql.SQL("ALTER TABLE auth_group OWNER TO sentinel_owner"),
             None,
             "a relation in schema public does not belong to the owner role"),
        )
        for change, undo, probe, problem in cases:
            with self.subTest(problem=problem, change=change.as_string()):
                with self.connect(self.database) as connection:
                    connection.execute(change)
                try:
                    if probe is not None:
                        statement, where = probe
                        if where == "autocommit":  # CREATE DATABASE runs outside a transaction
                            conninfo = make_conninfo(SERVER, dbname=self.database, user="sentinel_app",
                                                     password=self.passwords[0])
                            with psycopg.connect(conninfo, autocommit=True) as connection:
                                connection.execute(statement)
                            with self.connect() as connection:
                                connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(probe_database)))
                        else:
                            # PostgreSQL itself would let the runtime login do it.
                            self.assertIsNone(self.as_runtime(statement, where))
                    for service in (self.web, self.migrate_service):
                        self.assertRefusedAsItIs(service(), problem)
                finally:
                    with self.connect(self.database) as connection:
                        connection.execute(undo)
                self.assertStarted(self.web())

    def test_a_password_not_its_own_stops_each_service_before_it_connects(self):
        self.restricted_installation()
        bootstrap = self.superuser[1] or "a-password"
        cases = (
            ("web", self.web, {"POSTGRES_PASSWORD": bootstrap}),
            ("web", self.web, {"SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1]}),
            ("migrate", self.migrate_service, {"POSTGRES_PASSWORD": bootstrap}),
            ("migrate", self.migrate_service, {"SENTINEL_DB_PASSWORD": self.passwords[0]}),
            # The migrate service given its file, but not SENTINEL_DB_ROLES=separate.
            ("migrate", lambda **settings: self.entrypoint("apply-migrations", **settings),
             {"SENTINEL_DB_ACCESS": "migrate", "SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1]}),
        )
        for service, run, settings in cases:
            with self.subTest(service=service, settings=sorted(settings)):
                result = run(**settings)
                self.assertNoSecret(result)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("waiting for the database", result.stderr)  # it never connected
                self.assertNotIn("nothing to do here", result.stderr)
                self.assertIn(f"{next(iter(settings.keys() - {'SENTINEL_DB_ACCESS'}))} is set, but ", result.stderr)
        # Management commands in web load the same settings.
        result = self.manage("check", SENTINEL_DB_ROLES="separate", SENTINEL_DB_PASSWORD=self.passwords[0])
        self.assertNoSecret(result)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("POSTGRES_PASSWORD is set, but with SENTINEL_DB_ROLES=separate", result.stderr)

    def test_nothing_starts_before_the_logins_are_provisioned(self):
        if not self.passwords_are_checked():
            self.skipTest("the cluster lets these logins in without checking their passwords")
        for result in (self.migrate_service(), self.web()):
            self.assertNoSecret(result)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertNotIn(STARTED, result.stdout)
            self.assertNotIn("applying database migrations", result.stderr)
            self.assertIn("password authentication failed", result.stderr)
        self.assertEqual(self.tables(), [])
        self.assertFalse(self.marked())


class ProvisioningScriptTests(ApplicationTestCase):
    """scripts/postgres-roles.sh, with the passwords Compose gives the services."""

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        docker = self.directory / "bin" / "docker"
        docker.parent.mkdir()
        docker.write_text(DOCKER)
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
        self.calls = self.directory / "calls"

    def config(self, **web):
        """What `docker compose config --format json` would print, with web's environment changed."""
        environment = {"POSTGRES_DB": self.database, "SENTINEL_DB_ROLES": "separate"}
        return {"services": {
            "db": {"environment": {"POSTGRES_DB": self.database, "POSTGRES_USER": self.superuser[0],
                                   "POSTGRES_PASSWORD": self.superuser[1] or "a-password"}},
            "web": {"environment": {**environment, "SENTINEL_DB_PASSWORD": self.passwords[0],
                                    "SENTINEL_DB_MIGRATE_PASSWORD": "", **web}},
            "migrate": {"environment": {**environment, "SENTINEL_DB_ACCESS": "migrate", "SENTINEL_DB_PASSWORD": "",
                                        "SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1]}},
        }}

    def script(self, *arguments, config=None, cut=None):
        path = self.directory / "config.json"
        path.write_text(json.dumps(config or self.config()))
        environment = {
            "PATH": os.pathsep.join([str(self.directory / "bin"), str(Path(sys.executable).parent),
                                     os.path.dirname(shutil.which("psql")),
                                     "/usr/bin", "/bin"]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DOCKER_CALLS": str(self.calls), "DOCKER_CONFIG": str(path),
            "DB_USER": self.superuser[0], "DB_NAME": self.database,
            "PGHOST": self.server[0], "PGPORT": self.server[1],
        }
        if self.superuser[1]:
            environment["PGPASSWORD"] = self.superuser[1]
        if cut:
            environment["DB_CUT"] = str(cut)
        result = subprocess.run(["bash", str(ROOT / "scripts" / "postgres-roles.sh"), *arguments], cwd=ROOT,
                                env=environment, capture_output=True, text=True, timeout=120, check=False)
        # Nothing secret on a command line, nor in what the script prints.
        calls = self.calls.read_text() if self.calls.exists() else ""
        for secret in (*self.passwords, self.superuser[1]):
            if secret:
                self.assertFalse(secret in calls + result.stdout + result.stderr,
                                 "a password is on a command line or in the output")
        return result

    def managed_roles(self):
        return self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES))

    def test_apply_provisions_the_passwords_the_services_will_use(self):
        result = self.script("apply")
        self.assertEqual((result.returncode, result.stdout), (0, "postgres-roles: apply: committed\n"), result.stderr)
        self.assertEqual(self.calls.read_text().splitlines()[0], "compose config --format json")
        self.assertTrue(self.marked())
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())
        result = self.script("status")
        self.assertEqual((result.returncode, result.stdout), (0, "postgres-roles: status: verified\n"), result.stderr)

    def test_a_configuration_that_gives_web_another_password_is_refused(self):
        for name, value in (("POSTGRES_PASSWORD", self.superuser[1] or "a-password"),
                            ("SENTINEL_DB_MIGRATE_PASSWORD", self.passwords[1])):
            with self.subTest(name=name):
                result = self.script("apply", config=self.config(**{name: value}))
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"sentinel-roles: the web service would get {name}", result.stderr)
                self.assertIn("postgres-roles: apply did not finish", result.stderr)
                self.assertIn("postgres-roles: nothing was committed", result.stderr)
                self.assertEqual(self.managed_roles(), 0)
                self.assertFalse(self.marked())

    def test_a_program_cut_short_before_commit_changes_nothing_and_says_so(self):
        program = db_roles.apply_program(self.database, *self.passwords, ())
        cut = program.sql.splitlines().index("$sentinel_grants$;") + 1
        result = self.script("apply", cut=cut)
        self.assertEqual(result.returncode, 1)
        self.assertIn("postgres-roles: apply did not finish (status 0)", result.stderr)
        self.assertIn("postgres-roles: nothing was committed", result.stderr)
        self.assertEqual(self.managed_roles(), 0)
        self.assertFalse(self.marked())

    def test_a_program_cut_short_after_commit_says_it_is_provisioned(self):
        # The connection breaks between COMMIT and the last line: no confirmation,
        # yet everything was committed. apply again converges.
        program = db_roles.apply_program(self.database, *self.passwords, ())
        cut = program.sql.splitlines().index("COMMIT;") + 1
        result = self.script("apply", cut=cut)
        self.assertEqual(result.returncode, 1)
        self.assertIn("postgres-roles: the database is provisioned (schema sentinel_restricted exists)", result.stderr)
        self.assertNotIn("nothing was committed", result.stderr)
        self.assertEqual(self.managed_roles(), 3)
        result = self.script("apply")
        self.assertEqual((result.returncode, result.stdout), (0, "postgres-roles: apply: committed\n"), result.stderr)
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_usage_and_a_configuration_compose_cannot_resolve(self):
        for arguments in ((), ("drop",)):
            with self.subTest(arguments=arguments):
                result = self.script(*arguments)
                self.assertEqual(result.returncode, 2)
                self.assertIn("scripts/postgres-roles.sh apply", result.stderr)
        result = self.script("apply", config={"services": {}})
        self.assertEqual(result.returncode, 1)
        self.assertIn("has no db, web and migrate services", result.stderr)
        self.assertEqual(self.managed_roles(), 0)
        (self.directory / "bin" / "docker").write_text("#!/bin/sh\nexit 1\n")
        result = self.script("apply")
        self.assertEqual(result.returncode, 1)
        self.assertIn("postgres-roles: docker compose cannot resolve the configuration", result.stderr)
        self.assertEqual(result.stdout, "")


class RehearsalHelperTests(ApplicationTestCase):
    """.github/scripts/web_sql.py, which the Compose rehearsal (separate-roles-e2e.sh) runs in
    web: the statement is data in its environment, never part of the code."""

    def web_sql(self, statement):
        program = (ROOT / ".github" / "scripts" / "web_sql.py").read_text()
        settings = {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "runtime", "POSTGRES_PASSWORD": None,
                    "SENTINEL_DB_PASSWORD": self.passwords[0], "WEB_SQL": statement}
        return self.run_process([sys.executable, "manage.py", "shell", "--no-imports", "-v", "0", "-c", program],
                                settings)

    def test_statements_with_quotes_reach_postgresql_as_written(self):
        self.restricted_installation()
        self.assertEqual(self.migrate_service().returncode, 0)
        for statement, expected in (
            # What the rehearsal asks, quotes included.
            ("SELECT current_user", "sentinel_app"),
            ("SELECT has_table_privilege('django_migrations', 'INSERT')", "False"),
            ("SELECT has_table_privilege('django_migrations', 'SELECT')", "True"),
            # Quoting Python and the shell would have taken apart.
            ("SELECT 'it''s', 1", "it's"),
            ('SELECT \'"\'\'); print("injected"); (\'\'"\'', "\"'); print(\"injected\"); ('\""),
            ("SELECT $$x'y\\n$$ || '%s %%'", "x'y\\n%s %%"),
        ):
            with self.subTest(statement=statement):
                result = self.web_sql(statement)
                self.assertEqual((result.returncode, result.stdout), (0, expected + "\n"), result.stderr)


class RoleCheckTestCase(ApplicationTestCase):
    """A restricted installation, and how web, the migrate service and the operator's status
    judge what an administrator changed in it."""

    def setUp(self):
        super().setUp()
        self.restricted_installation()

    def as_runtime(self, *statements, database=None):
        """Run ``statements`` as sentinel_app, in a transaction rolled back: what PostgreSQL lets it do."""
        conninfo = make_conninfo(SERVER, dbname=database or self.database, user="sentinel_app", password=self.passwords[0])
        with psycopg.connect(conninfo) as connection:
            try:
                cursors = [connection.execute(statement) for statement in statements]
                return [cursor.fetchall() for cursor in cursors if cursor.description]
            finally:
                connection.rollback()

    def assertRefusedEverywhere(self, *problems):
        for name, run in (("web", self.web), ("migrate", self.migrate_service)):
            with self.subTest(service=name):
                result = run()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertNotIn(STARTED, result.stdout)
                self.assertIn(REFUSED_AS_IT_IS, result.stderr)
                for problem in problems:
                    self.assertIn(problem, result.stderr)
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        for problem in problems:
            self.assertIn(problem, stderr)

    def assertAccepted(self):
        self.assertStarted(self.web())
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertSucceeds(self.status)

    def unexpected(self, items):
        return f"in database {self.database}, the managed roles may use what the application does not: {items}"


class UnexpectedAccessTests(RoleCheckTestCase):
    """Nothing outside what the application uses is open to its roles: not by a grant to
    them, not through PUBLIC, not through a role they belong to (sentinel/db_roles.py
    UNEXPECTED_ACCESS, CONNECT_ELSEWHERE). Web, the migrate service and the operator's
    status refuse alike, and accept again once it is revoked."""

    def test_public_usage_and_privileges_outside_schema_public(self):
        # A schema and a table of someone else's, opened to PUBLIC.
        self.execute(
            "CREATE SCHEMA extra_schema;"
            " CREATE TABLE extra_schema.unexpected_data (value text);"
            " INSERT INTO extra_schema.unexpected_data VALUES ('fixture');"
            " GRANT USAGE ON SCHEMA extra_schema TO PUBLIC;"
            " GRANT SELECT, UPDATE ON extra_schema.unexpected_data TO PUBLIC"
        )
        self.addCleanup(self.execute, "DROP SCHEMA IF EXISTS extra_schema CASCADE")
        # PostgreSQL lets the runtime login read and change it.
        self.assertEqual(self.as_runtime("SELECT value FROM extra_schema.unexpected_data",
                                         "UPDATE extra_schema.unexpected_data SET value = 'changed' RETURNING value"),
                         [[("fixture",)], [("changed",)]])
        self.assertRefusedEverywhere(self.unexpected(
            "schema extra_schema: USAGE for PUBLIC; table extra_schema.unexpected_data: SELECT, UPDATE for PUBLIC"))
        self.execute("REVOKE SELECT, UPDATE ON extra_schema.unexpected_data FROM PUBLIC")
        self.assertRefusedEverywhere(self.unexpected("schema extra_schema: USAGE for PUBLIC;"))
        self.execute("REVOKE USAGE ON SCHEMA extra_schema FROM PUBLIC")
        self.assertAccepted()
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.as_runtime("SELECT value FROM extra_schema.unexpected_data")

    def test_each_kind_of_object_and_each_way_to_hold_it(self):
        cases = (
            ("a schema to PUBLIC, whose functions PUBLIC may run by default",
             "CREATE SCHEMA extra_schema; CREATE FUNCTION extra_schema.f() RETURNS integer LANGUAGE sql AS 'SELECT 1';"
             " GRANT USAGE ON SCHEMA extra_schema TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             ["SELECT extra_schema.f()"], "schema extra_schema: USAGE for PUBLIC"),
            ("a table to PUBLIC, in a schema it may not use",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text);"
             " GRANT SELECT, UPDATE ON extra_schema.t TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             None, "table extra_schema.t: SELECT, UPDATE for PUBLIC"),
            ("a sequence to PUBLIC",
             "CREATE SCHEMA extra_schema; CREATE SEQUENCE extra_schema.s; GRANT USAGE ON SCHEMA extra_schema TO PUBLIC;"
             " GRANT USAGE, SELECT ON SEQUENCE extra_schema.s TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             ["SELECT pg_catalog.nextval('extra_schema.s')"], "sequence extra_schema.s: SELECT, USAGE for PUBLIC"),
            ("a view to PUBLIC",
             "CREATE SCHEMA extra_schema; CREATE VIEW extra_schema.v AS SELECT rolname FROM pg_catalog.pg_roles;"
             " GRANT USAGE ON SCHEMA extra_schema TO PUBLIC; GRANT SELECT ON extra_schema.v TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             ["SELECT * FROM extra_schema.v"], "view extra_schema.v: SELECT for PUBLIC"),
            ("a column to PUBLIC",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text, secret text);"
             " GRANT USAGE ON SCHEMA extra_schema TO PUBLIC; GRANT SELECT (value) ON extra_schema.t TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             ["SELECT value FROM extra_schema.t"], "table extra_schema.t: SELECT for PUBLIC"),
            ("the same to the runtime login itself",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text);"
             " GRANT USAGE ON SCHEMA extra_schema TO sentinel_app; GRANT SELECT ON extra_schema.t TO sentinel_app",
             "DROP SCHEMA extra_schema CASCADE",
             ["SELECT value FROM extra_schema.t"],
             "schema extra_schema: USAGE for sentinel_app; table extra_schema.t: SELECT for sentinel_app"),
            ("a schema to the migration login, which the owner would use",
             "CREATE SCHEMA extra_schema; GRANT USAGE ON SCHEMA extra_schema TO sentinel_migrate",
             "DROP SCHEMA extra_schema CASCADE",
             None, "schema extra_schema: USAGE for sentinel_migrate"),
            ("with a grant option, which it could hand on",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text);"
             " GRANT USAGE ON SCHEMA extra_schema TO sentinel_app; GRANT SELECT ON extra_schema.t TO sentinel_app WITH GRANT OPTION",
             "DROP SCHEMA extra_schema CASCADE",
             ["GRANT SELECT ON extra_schema.t TO PUBLIC"], "table extra_schema.t: SELECT for sentinel_app"),
            # A predefined role: the only others a cluster of Sentinel's own holds.
            ("through a role the runtime login belongs to",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text);"
             " GRANT pg_read_all_data TO sentinel_app WITH INHERIT TRUE",
             "REVOKE pg_read_all_data FROM sentinel_app; DROP SCHEMA extra_schema CASCADE",
             ["SELECT value FROM extra_schema.t"], "role memberships differ"),
            ("a system function PUBLIC may not run after initdb",
             "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM PUBLIC",
             ["SELECT pg_catalog.pg_read_file('PG_VERSION')"], "function pg_read_file(text): EXECUTE for PUBLIC"),
            ("a system catalog PUBLIC may not read after initdb",
             "GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC",
             "REVOKE SELECT ON pg_catalog.pg_authid FROM PUBLIC",
             ["SELECT rolpassword FROM pg_catalog.pg_authid"], "table pg_authid: SELECT for PUBLIC"),
            ("a column of a system catalog",
             "GRANT SELECT (rolname, rolpassword) ON pg_catalog.pg_authid TO PUBLIC",
             "REVOKE SELECT (rolname, rolpassword) ON pg_catalog.pg_authid FROM PUBLIC",
             ["SELECT rolpassword FROM pg_catalog.pg_authid"], "column pg_authid.rolpassword: SELECT for PUBLIC"),
            ("information_schema beyond reading it",
             "GRANT INSERT ON information_schema.sql_features TO PUBLIC",
             "REVOKE INSERT ON information_schema.sql_features FROM PUBLIC",
             None, "table information_schema.sql_features: INSERT for PUBLIC"),
            ("a large object to PUBLIC",
             "SELECT pg_catalog.lo_from_bytea(424242, 'secret'::bytea); GRANT SELECT ON LARGE OBJECT 424242 TO PUBLIC",
             "SELECT pg_catalog.lo_unlink(424242)",
             ["SELECT pg_catalog.lo_get(424242)"], "large object 424242: SELECT for PUBLIC"),
            ("a foreign-data wrapper to PUBLIC",
             "CREATE FOREIGN DATA WRAPPER sentinel_probe_fdw; GRANT USAGE ON FOREIGN DATA WRAPPER sentinel_probe_fdw TO PUBLIC",
             "DROP FOREIGN DATA WRAPPER sentinel_probe_fdw CASCADE",
             ["CREATE SERVER sentinel_probe_server FOREIGN DATA WRAPPER sentinel_probe_fdw"],
             "foreign-data wrapper sentinel_probe_fdw: USAGE for PUBLIC"),
            ("a foreign server to PUBLIC",
             "CREATE FOREIGN DATA WRAPPER sentinel_probe_fdw; CREATE SERVER sentinel_probe_server FOREIGN DATA WRAPPER sentinel_probe_fdw;"
             " GRANT USAGE ON FOREIGN SERVER sentinel_probe_server TO PUBLIC",
             "DROP FOREIGN DATA WRAPPER sentinel_probe_fdw CASCADE",
             ["CREATE USER MAPPING FOR CURRENT_USER SERVER sentinel_probe_server"],
             "server sentinel_probe_server: USAGE for PUBLIC"),
            ("large objects open to every role",
             "SELECT pg_catalog.lo_from_bytea(424243, 'secret'::bytea);"
             f" ALTER DATABASE \"{self.database}\" SET lo_compat_privileges = on",
             f"ALTER DATABASE \"{self.database}\" RESET lo_compat_privileges; SELECT pg_catalog.lo_unlink(424243)",
             ["SELECT pg_catalog.lo_get(424243)"], "setting lo_compat_privileges: on for every role"),
            ("a parameter PUBLIC may set",
             "GRANT SET ON PARAMETER log_statement TO PUBLIC",
             "REVOKE SET ON PARAMETER log_statement FROM PUBLIC",
             ["SET log_statement = 'none'"], "parameter log_statement: SET for PUBLIC"),
        )
        for name, change, undo, probe, problem in cases:
            with self.subTest(name):
                self.execute(change)
                try:
                    if probe is not None:
                        self.as_runtime(*probe)  # PostgreSQL itself lets the runtime login do it
                    self.assertRefusedEverywhere(problem)
                finally:
                    self.execute(undo)
                self.assertAccepted()

    def test_other_databases_are_out_of_reach(self):
        # postgres: the other database a cluster of Sentinel's own has (template1 alike).
        other = "postgres"
        for grantee in ("PUBLIC", "sentinel_app", "sentinel_migrate"):
            with self.subTest(grantee=grantee):
                self.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(other), sql.SQL(grantee)))
                try:
                    if grantee != "sentinel_migrate":
                        self.as_runtime("SELECT 1", database=other)  # it could connect
                    if grantee == "PUBLIC":
                        self.assertRefusedEverywhere(
                            "the login roles could connect to other databases of the cluster",
                            f"REVOKE CONNECT ON DATABASE {other} FROM PUBLIC")
                    else:
                        # A grant to a managed role is found before: the roles serve that database too.
                        self.assertRefusedEverywhere(f"the roles also serve database(s) {other}")
                finally:
                    self.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(sql.Identifier(other), sql.SQL(grantee)))
                self.assertAccepted()
        with self.assertRaises(psycopg.OperationalError):
            self.as_runtime("SELECT 1", database=other)
        # apply refuses before it changes anything.
        self.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO PUBLIC").format(sql.Identifier(other)))
        status, stderr, finished, block = self.apply()
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertIn(f"REVOKE CONNECT ON DATABASE {other} FROM PUBLIC", stderr)
        self.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM PUBLIC").format(sql.Identifier(other)))
        self.assertSucceeds(self.apply)

    def test_a_tablespace_of_the_cluster(self):
        # Shared by the cluster: visible from here. Needs a directory the server can use.
        directory = tempfile.mkdtemp(prefix="sentinel-tablespace-")
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        name = f"sentinel_probe_{secrets.token_hex(4)}"
        try:
            with self.connect() as connection:
                connection.execute(sql.SQL("CREATE TABLESPACE {} LOCATION {}").format(sql.Identifier(name), sql.Literal(directory)))
        except psycopg.Error as exc:
            self.skipTest(f"the server cannot create a tablespace here: {exc}")
        self.addCleanup(lambda: self.connect().execute(sql.SQL("DROP TABLESPACE IF EXISTS {}").format(sql.Identifier(name))))
        self.execute(sql.SQL("GRANT CREATE ON TABLESPACE {} TO PUBLIC").format(sql.Identifier(name)))
        self.assertRefusedEverywhere(f"tablespace {name}: CREATE for PUBLIC")
        self.execute(sql.SQL("REVOKE CREATE ON TABLESPACE {} FROM PUBLIC").format(sql.Identifier(name)))
        self.assertAccepted()

    def test_the_system_catalogs_stay_readable(self):
        # What every role may do in PostgreSQL is no finding: the application relies on it.
        self.assertEqual(
            self.as_runtime("SELECT count(*) > 0 FROM pg_catalog.pg_class",
                            "SELECT count(*) > 0 FROM information_schema.tables",
                            "SELECT pg_catalog.now() IS NOT NULL",
                            "SELECT count(*) >= 0 FROM auth_group"),
            [[(True,)]] * 4)
        self.assertAccepted()

    def test_maintain_on_a_table_of_the_application_where_the_server_has_it(self):
        # MAINTAIN (PostgreSQL 17) would let the runtime login vacuum, reindex, cluster and lock
        # the tables it may otherwise only read and write. PostgreSQL 16 has no such privilege:
        # nothing to grant, and the checks must not ask about it.
        if self.value("SELECT pg_catalog.current_setting('server_version_num')::integer") < 170000:
            with self.assertRaisesRegex(psycopg.errors.SyntaxError, 'unrecognized privilege type "maintain"'):
                self.execute("GRANT MAINTAIN ON auth_group TO sentinel_app")
            self.assertAccepted()
        else:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.as_runtime("REINDEX TABLE auth_group")
            self.execute("GRANT MAINTAIN ON auth_group TO sentinel_app")
            self.addCleanup(self.execute, "REVOKE MAINTAIN ON auth_group FROM sentinel_app")
            # PostgreSQL lets the runtime login do it.
            self.assertEqual(self.as_runtime("REINDEX TABLE auth_group"), [])
            self.assertRefusedEverywhere("the runtime role has MAINTAIN on auth_group")
            status, stderr, finished, block = self.apply()
            self.assertEqual((status, finished, block), (3, False, "sentinel_reapply"), stderr)
            self.assertIn("the runtime role has MAINTAIN on auth_group", stderr)
            self.execute("REVOKE MAINTAIN ON auth_group FROM sentinel_app")
            self.assertAccepted()
            self.assertSucceeds(self.apply)


class DriftTests(RoleCheckTestCase):
    """What an administrator could change in an activated installation, each refused by the check
    that comes first for it, against the server: web, the migrate service and the operator's status
    refuse alike, apply refuses before it changes anything, and all accept again once it is undone."""

    def assertApplyRefuses(self, block, *problems):
        status, stderr, finished, refused = self.apply()
        self.assertEqual((status, finished, refused), (3, False, block), stderr)
        for problem in problems:
            self.assertIn(problem, stderr)

    def test_what_other_sessions_could_be_made_to_run_is_refused(self):
        # sentinel/db_roles.py TRIPWIRE. A rule runs its action with the privileges of its table's
        # owner: through one on a table the runtime login writes, it writes the record of the
        # migrations, which it may not.
        refused = "the database holds objects the application never creates, which other sessions could be made to run"
        self.execute("CREATE RULE sentinel_probe AS ON INSERT TO auth_group"
                     " DO ALSO INSERT INTO django_migrations (app, name, applied) VALUES ('sentinel', 'probe', now())")
        self.addCleanup(self.execute, "DROP RULE IF EXISTS sentinel_probe ON auth_group")
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.as_runtime("INSERT INTO django_migrations (app, name, applied) VALUES ('sentinel', 'probe', now())")
        self.assertEqual(self.as_runtime("INSERT INTO auth_group (name) VALUES ('sentinel probe')",
                                         "SELECT count(*) FROM django_migrations WHERE app = 'sentinel'"), [[(1,)]])
        self.assertRefusedEverywhere(refused, "rule sentinel_probe on public.auth_group")
        self.assertApplyRefuses("sentinel_preflight", refused, "rule sentinel_probe on public.auth_group")
        self.execute("DROP RULE sentinel_probe ON auth_group")
        self.assertAccepted()
        # Each other kind no earlier check refuses: what it runs initdb made (FOREIGN_OBJECTS refuses
        # the rest), and no managed role may use it (UNEXPECTED_ACCESS).
        for change, undo, item in (
            ("CREATE TRIGGER sentinel_probe BEFORE UPDATE ON auth_group FOR EACH ROW"
             " EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()",
             "DROP TRIGGER sentinel_probe ON auth_group", "trigger sentinel_probe on public.auth_group"),
            ("CREATE POLICY sentinel_probe ON auth_group USING (true)", "DROP POLICY sentinel_probe ON auth_group",
             "policy sentinel_probe on public.auth_group"),
            ("CREATE TYPE public.sentinel_probe AS ENUM ('probe')", "DROP TYPE public.sentinel_probe",
             "type public.sentinel_probe"),
        ):
            with self.subTest(item):
                self.execute(change)
                try:
                    self.assertRefusedEverywhere(refused, item)
                    self.assertApplyRefuses("sentinel_preflight", refused, item)
                finally:
                    self.execute(undo)
                self.assertSucceeds(self.status)
        self.assertAccepted()

    def test_an_owner_role_made_superuser(self):
        self.execute("ALTER ROLE sentinel_owner SUPERUSER")
        self.addCleanup(self.execute, "ALTER ROLE sentinel_owner NOSUPERUSER")
        # The migration login may become the owner role: a superuser login now, which the guard refuses.
        result = self.migrate_service()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn("sentinel_migrate, a superuser login, may not be used", result.stderr)
        result = self.web()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn(REFUSED_AS_IT_IS + "a managed role has an attribute it must not have", result.stderr)
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        self.assertIn("a managed role has an attribute it must not have", stderr)
        self.assertApplyRefuses("sentinel_preflight", "refusing to change superuser role(s) sentinel_owner")
        self.execute("ALTER ROLE sentinel_owner NOSUPERUSER")
        self.assertAccepted()

    def test_each_check_that_no_other_refuses_first(self):
        database = sql.Identifier(self.database)
        for change, undo, everywhere, block, by_apply in (
            (sql.SQL("ALTER ROLE sentinel_owner LOGIN"), sql.SQL("ALTER ROLE sentinel_owner NOLOGIN"),
             "the owner role must not log in, the others must", "sentinel_reapply", None),
            (sql.SQL("ALTER DATABASE {} OWNER TO sentinel_owner").format(database),
             sql.SQL("ALTER DATABASE {} OWNER TO CURRENT_USER").format(database),
             f"a managed role may create schemas in database(s) {self.database}", "sentinel_preflight",
             "the database belongs to sentinel_owner, a role this program manages"),
            (sql.SQL("GRANT CREATE ON SCHEMA public TO PUBLIC"), sql.SQL("REVOKE CREATE ON SCHEMA public FROM PUBLIC"),
             "a managed role may create objects in schema(s) public", "sentinel_preflight",
             "every role may create objects in schema public (a database from PostgreSQL 14 or older)"),
            (sql.SQL("CREATE TABLE public.sentinel_probe (id integer); ALTER TABLE public.sentinel_probe OWNER TO sentinel_app"),
             sql.SQL("DROP TABLE public.sentinel_probe"),
             "a login role owns objects (in some database of the cluster)", "sentinel_preflight",
             "relations in schema public belong to other roles; this program never takes them: public.sentinel_probe (sentinel_app)"),
            (sql.SQL("REVOKE CREATE ON SCHEMA public FROM sentinel_owner"),
             sql.SQL("GRANT CREATE ON SCHEMA public TO sentinel_owner"),
             "the owner role must use and create in schema public, the runtime role use it", "sentinel_reapply", None),
            (sql.SQL("ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner GRANT EXECUTE ON FUNCTIONS TO sentinel_app"),
             sql.SQL("ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner REVOKE EXECUTE ON FUNCTIONS FROM sentinel_app"),
             "the roles hold privileges or objects this program neither gives nor takes back", "sentinel_reapply", None),
        ):
            with self.subTest(change=change.as_string()):
                self.execute(change)
                try:
                    self.assertRefusedEverywhere(everywhere)
                    self.assertApplyRefuses(block, by_apply or everywhere)
                finally:
                    self.execute(undo)
                self.assertSucceeds(self.status)
        self.assertAccepted()


class ProvenanceTests(RoleCheckTestCase):
    """What initdb made is the system's; what anyone made after it is not, wherever it sits
    (sentinel/db_roles.py FIRST_NORMAL_OID, FOREIGN_OBJECTS)."""

    def code(self, items):
        return (f"database {self.database} holds what runs code, which the application never creates and initdb did"
                f" not make, so nothing here can vouch for it: {items}")

    def test_new_objects_in_the_system_schemas_are_not_the_system(self):
        cases = (
            ("a SECURITY DEFINER function in pg_catalog, run by PUBLIC",
             "CREATE FUNCTION pg_catalog.sentinel_read() RETURNS text LANGUAGE sql SECURITY DEFINER"
             " AS $$SELECT pg_catalog.pg_read_file('PG_VERSION')$$",
             "DROP FUNCTION pg_catalog.sentinel_read()",
             "SELECT pg_catalog.sentinel_read()",
             ["security definer function sentinel_read(): EXECUTE for PUBLIC"]),
            ("an ordinary function in pg_catalog",
             "CREATE FUNCTION pg_catalog.sentinel_helper() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
             "DROP FUNCTION pg_catalog.sentinel_helper()",
             "SELECT pg_catalog.sentinel_helper()",
             ["function sentinel_helper(): EXECUTE for PUBLIC"]),
            ("a table in information_schema",
             "CREATE TABLE information_schema.sentinel_probe (secret text);"
             " INSERT INTO information_schema.sentinel_probe VALUES ('fixture');"
             " GRANT SELECT ON information_schema.sentinel_probe TO PUBLIC",
             "DROP TABLE information_schema.sentinel_probe",
             "SELECT secret FROM information_schema.sentinel_probe",
             ["table information_schema.sentinel_probe: SELECT for PUBLIC"]),
            ("a view in information_schema",
             "CREATE VIEW information_schema.sentinel_view AS SELECT rolname, rolpassword FROM pg_catalog.pg_authid;"
             " GRANT SELECT ON information_schema.sentinel_view TO PUBLIC",
             "DROP VIEW information_schema.sentinel_view",
             "SELECT rolpassword FROM information_schema.sentinel_view",
             ["view information_schema.sentinel_view: SELECT for PUBLIC"]),
            ("a function named like a system one",
             "CREATE FUNCTION pg_catalog.pg_read_file(text, integer) RETURNS text LANGUAGE sql SECURITY DEFINER"
             " AS $$SELECT pg_catalog.pg_read_file($1)$$",
             "DROP FUNCTION pg_catalog.pg_read_file(text, integer)",
             "SELECT pg_catalog.pg_read_file('PG_VERSION', 0)",
             ["security definer function pg_read_file(text,integer): EXECUTE for PUBLIC"]),
            ("a view named like a system one",
             "CREATE VIEW information_schema.role_table_grant AS SELECT rolname, rolpassword FROM pg_catalog.pg_authid;"
             " GRANT SELECT ON information_schema.role_table_grant TO PUBLIC",
             "DROP VIEW information_schema.role_table_grant",
             "SELECT rolpassword FROM information_schema.role_table_grant",
             ["view information_schema.role_table_grant: SELECT for PUBLIC"]),
        )
        for name, change, undo, probe, problems in cases:
            with self.subTest(name):
                self.execute(change)
                try:
                    self.as_runtime(probe)  # PostgreSQL itself lets the runtime login do it
                    self.assertRefusedEverywhere(*problems)
                finally:
                    self.execute(undo)
                self.assertAccepted()
        # Not granted to anyone, made after initdb: refused for being there.
        self.execute("CREATE FUNCTION pg_catalog.sentinel_read() RETURNS text LANGUAGE sql SECURITY DEFINER"
                     " AS $$SELECT pg_catalog.pg_read_file('PG_VERSION')$$;"
                     " REVOKE EXECUTE ON FUNCTION pg_catalog.sentinel_read() FROM PUBLIC")
        try:
            self.assertRefusedEverywhere(self.code("security definer function sentinel_read()"))
        finally:
            self.execute("DROP FUNCTION pg_catalog.sentinel_read()")
        self.assertAccepted()

    def test_code_made_after_initdb_is_refused_even_where_nobody_may_use_it(self):
        # A cast between two built-in types calls its function for anyone PostgreSQL lets run
        # it (PUBLIC, by default), without the schema the function is in being usable.
        self.execute(
            "CREATE SCHEMA hidden;"
            " CREATE FUNCTION hidden.f(point) RETURNS text LANGUAGE sql SECURITY DEFINER"
            " AS $$SELECT 'ran as ' || current_user || ': ' || pg_catalog.pg_read_file('PG_VERSION')$$;"
            " CREATE CAST (point AS text) WITH FUNCTION hidden.f(point)"
        )
        self.addCleanup(self.execute, "DROP SCHEMA IF EXISTS hidden CASCADE")
        (((ran,),),) = self.as_runtime("SELECT pg_catalog.point(1, 2)::text")
        self.assertTrue(ran.startswith(f"ran as {self.superuser[0]}: "), ran)
        self.assertRefusedEverywhere(self.code("cast (point AS text), security definer function hidden.f(point)"))
        # Revoked from PUBLIC, it is still not the system's: refused all the same.
        self.execute("REVOKE EXECUTE ON FUNCTION hidden.f(point) FROM PUBLIC")
        self.assertRefusedEverywhere(self.code("cast (point AS text), security definer function hidden.f(point)"))
        for objects, change in (
            ("operator ###(text,text)", "CREATE OPERATOR pg_catalog.### (LEFTARG = text, RIGHTARG = text, FUNCTION = pg_catalog.textcat)"),
            ("type hidden.mood", "CREATE TYPE hidden.mood AS ENUM ('calm')"),
        ):
            with self.subTest(objects):
                self.execute("DROP SCHEMA hidden CASCADE; CREATE SCHEMA hidden")
                self.execute(change)
                self.assertRefusedEverywhere(self.code(objects))
                if objects.startswith("operator"):
                    self.execute("DROP OPERATOR pg_catalog.### (text, text)")
        self.execute("DROP SCHEMA hidden CASCADE")
        self.assertAccepted()

    def test_the_system_schemas_are_judged_by_what_initdb_gave_them(self):
        # pg_toast holds every table's out-of-line data: opened to PUBLIC with one TOAST table,
        # it gives the chunks of a table nobody may read.
        toast = self.value("SELECT reltoastrelid::regclass::text FROM pg_catalog.pg_class WHERE oid = 'django_session'::regclass")
        self.execute("INSERT INTO django_session SELECT 'probe', string_agg(md5(i::text), ''), now() + interval '1 day'"
                     f" FROM generate_series(1, 400) i; GRANT USAGE ON SCHEMA pg_toast TO PUBLIC; GRANT SELECT ON {toast} TO PUBLIC")
        try:
            (((chunks,),),) = self.as_runtime(f"SELECT count(*) FROM {toast}")
            self.assertGreater(chunks, 0)
            self.assertRefusedEverywhere(f"TOAST table {toast}: SELECT for PUBLIC; schema pg_toast: USAGE for PUBLIC")
        finally:
            self.execute(f"REVOKE SELECT ON {toast} FROM PUBLIC; REVOKE USAGE ON SCHEMA pg_toast FROM PUBLIC;"
                         " DELETE FROM django_session WHERE session_key = 'probe'")
        self.assertAccepted()

    def test_an_extension_installed_into_pg_catalog_is_not_the_system(self):
        if not self.value("SELECT count(*) FROM pg_catalog.pg_available_extensions WHERE name = 'citext'"):
            self.skipTest("citext is not available on this server")
        # Its functions sit in pg_catalog, run by PUBLIC as PostgreSQL defaults to, and were
        # made after initdb: not the system's, whatever the schema.
        self.execute("CREATE EXTENSION citext SCHEMA pg_catalog")
        try:
            self.as_runtime("SELECT 'A'::pg_catalog.citext = 'a'::pg_catalog.citext")
            self.assertRefusedEverywhere("function citext_eq(citext,citext): EXECUTE for PUBLIC")
        finally:
            self.execute("DROP EXTENSION citext")
        self.assertAccepted()

    def test_what_initdb_made_passes(self):
        self.assertEqual(self.value(f"SELECT count(*) FROM pg_catalog.pg_proc WHERE oid >= {db_roles.FIRST_NORMAL_OID}"), 0)
        self.assertGreater(self.value("SELECT count(*) FROM pg_catalog.pg_class"
                                      " WHERE relnamespace = 'information_schema'::regnamespace"), 0)
        self.assertEqual(self.as_runtime("SELECT count(*) > 0 FROM information_schema.columns",
                                         "SELECT pg_catalog.pg_get_userbyid(10) IS NOT NULL",
                                         "SELECT 'a' || 'b'"),
                         [[(True,)], [(True,)], [("ab",)]])
        self.assertAccepted()


class SessionDrainTests(RoleCheckTestCase):
    """REVOKE CONNECT keeps new sessions out of another database; the ones open there stay,
    and the checks refuse while they do (sentinel/db_roles.py CONNECT_ELSEWHERE)."""

    def setUp(self):
        super().setUp()
        self.other = "postgres"  # the other database of a cluster of Sentinel's own

    def open(self, user, password, database):
        connection = psycopg.connect(make_conninfo(SERVER, dbname=database, user=user, password=password), autocommit=True)
        self.addCleanup(connection.close)
        return connection

    def retained(self, user, password):
        """A session of ``user`` opened in the other database while PUBLIC could connect, and
        CONNECT revoked afterwards."""
        self.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO PUBLIC").format(sql.Identifier(self.other)))
        session = self.open(user, password, self.other)
        self.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM PUBLIC").format(sql.Identifier(self.other)))
        with self.assertRaises(psycopg.OperationalError):  # no new session
            self.open(user, password, self.other)
        return session

    def wait_until_gone(self, pid):
        for _ in range(300):
            if not self.value("SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid = %s", pid):
                return
            time.sleep(0.1)
        self.fail(f"backend {pid} did not end")

    def test_a_session_left_open_elsewhere_stops_everything_until_it_ends(self):
        for user, password in (("sentinel_app", self.passwords[0]), ("sentinel_migrate", self.passwords[1])):
            with self.subTest(user=user):
                session = self.retained(user, password)
                pid = session.info.backend_pid
                # It is still there.
                self.assertEqual(session.execute("SELECT current_database()").fetchall(), [(self.other,)])
                self.assertRefusedEverywhere(
                    "sessions of the login roles are open in other databases, which revoking CONNECT does not end",
                    f"pid {pid} ({user} in database {self.other}, ",
                    f"SELECT pg_catalog.pg_terminate_backend({pid})")
                status, stderr, finished, block = self.apply()
                self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                self.assertIn(f"pid {pid} ({user} in database {self.other}", stderr)
                self.assertTrue(self.value("SELECT count(*) = 1 FROM pg_catalog.pg_stat_activity WHERE pid = %s", pid))
                session.close()
                self.wait_until_gone(pid)
                self.assertAccepted()

    def test_the_operator_ends_them_deliberately(self):
        session = self.retained("sentinel_app", self.passwords[0])
        pid = session.info.backend_pid
        self.assertRefusedEverywhere(f"pid {pid} (sentinel_app in database {self.other}, ")
        # As docs/server-deployment.md says: the statement the refusal printed, as a superuser.
        self.assertTrue(self.value("SELECT pg_catalog.pg_terminate_backend(%s)", pid))
        self.wait_until_gone(pid)
        with self.assertRaises(psycopg.OperationalError):
            session.execute("SELECT 1")
        self.assertAccepted()

    def test_other_sessions_are_none_of_its_business(self):
        # The superuser's own, in the other database.
        others = [self.connect(self.other)]
        self.addCleanup(others[0].close)
        # Sessions of the logins in the application's own database are what Sentinel runs on.
        mine = self.open("sentinel_app", self.passwords[0], self.database)
        self.assertAccepted()
        for connection in (*others, mine):
            self.assertEqual(connection.execute("SELECT 1").fetchone(), (1,))


class PreflightTests(ApplicationTestCase):
    """apply refuses before it creates or changes any role: PUBLIC's privileges are every
    role's, those to come included, so they are checked before the roles exist."""

    def test_large_objects_are_closed_to_public_before_the_first_activation(self):
        # PostgreSQL's default, as a new database has it: every role may create large objects.
        self.execute("GRANT EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),"
                     " pg_catalog.lo_from_bytea(oid, bytea) TO PUBLIC")
        status, stderr, finished, block = self.apply()
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)
        # The operator runs what the refusal names, each as the role named (here the bootstrap superuser).
        remedies = stderr.split("each as the role named: ", 1)[1].splitlines()[0].split("; ")
        self.assertEqual(len(remedies), 3)
        for remedy in remedies:
            role, statement = remedy.split(": ", 1)
            self.assertEqual(role, f"as {self.superuser[0]}")
            self.execute(statement)
        self.assertSucceeds(self.apply)
        self.assertFalse(self.value("SELECT pg_catalog.bool_or(pg_catalog.has_function_privilege('public', oid, 'EXECUTE'))"
                                    " FROM pg_catalog.pg_proc WHERE prosrc = ANY (%s)", list(db_roles.LARGE_OBJECT_CREATORS)))

    def test_refused_before_any_role_exists(self):
        for name, change, undo, problem in (
            ("a schema and a table opened to PUBLIC",
             "CREATE SCHEMA extra_schema; CREATE TABLE extra_schema.t (value text);"
             " GRANT USAGE ON SCHEMA extra_schema TO PUBLIC; GRANT SELECT ON extra_schema.t TO PUBLIC",
             "DROP SCHEMA extra_schema CASCADE",
             "schema extra_schema: USAGE for PUBLIC; table extra_schema.t: SELECT for PUBLIC"),
            ("code made after initdb",
             "CREATE FUNCTION pg_catalog.sentinel_helper() RETURNS integer LANGUAGE sql AS 'SELECT 1';"
             " REVOKE EXECUTE ON FUNCTION pg_catalog.sentinel_helper() FROM PUBLIC",
             "DROP FUNCTION pg_catalog.sentinel_helper()",
             "nothing here can vouch for it: function sentinel_helper()"),
        ):
            with self.subTest(name):
                self.execute(change)
                try:
                    status, stderr, finished, block = self.apply()
                    self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                    self.assertIn(problem, stderr)
                    self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)",
                                                list(ROLES)), 0)
                finally:
                    self.execute(undo)
        self.assertSucceeds(self.apply)


class TopologyTests(ApplicationTestCase):
    """The separate logins run on a cluster of Sentinel's own: another database or another role
    in it stops provisioning, status and every start, and they name it (sentinel/db_roles.py
    DEDICATED_CLUSTER). A compatibility check only."""

    TOPOLOGY = ("the separate logins are supported on a PostgreSQL cluster of their own only (the db service of"
                " this Compose project), and this cluster also has ")

    def extras(self):
        """What an operator could add to the cluster: (name in the refusal, its creation, its removal)."""
        database, role = f"sentinel-extra-{secrets.token_hex(4)}", f"sentinel_extra_{secrets.token_hex(4)}"
        return (
            (f'database "{database}"', sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)),
             sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(database))),
            (f"role {role}", sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)),
             sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role))),
            # One that may not even log in counts the same: the roles are the cluster's.
            (f"role {role}_nologin", sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(f"{role}_nologin")),
             sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(f"{role}_nologin"))),
        )

    def run_as_superuser(self, statement):
        with self.connect() as connection:
            connection.execute(statement)

    def add(self, create, drop):
        self.run_as_superuser(create)
        self.addCleanup(self.run_as_superuser, drop)

    def test_apply_refuses_before_it_creates_anything(self):
        for found, create, drop in self.extras():
            with self.subTest(found):
                self.add(create, drop)
                status, stderr, finished, block = self.apply()
                self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                self.assertIn(self.TOPOLOGY + found, stderr)
                self.assertUnprovisioned()
                self.run_as_superuser(drop)
        self.assertSucceeds(self.apply)

    def test_after_activation_it_stops_everything_until_it_is_gone(self):
        self.restricted_installation()
        for found, create, drop in self.extras():
            with self.subTest(found):
                self.add(create, drop)
                for service in (self.migrate_service, self.web):
                    result = service()
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn(REFUSED_AS_IT_IS + self.TOPOLOGY + found, result.stderr)
                    self.assertNotIn(APPLYING, result.stderr)
                    self.assertNotIn(STARTED, result.stdout)
                for run, block in ((self.status, "sentinel_verify"), (self.apply, "sentinel_preflight")):
                    status, stderr, finished, failed = run()
                    self.assertEqual((status, finished, failed), (3, False, block), stderr)
                    self.assertIn(self.TOPOLOGY + found, stderr)
                self.run_as_superuser(drop)
                self.assertStarted(self.web())
                self.assertEqual(self.migrate_service().returncode, 0)
                self.assertSucceeds(self.status)

    def test_what_a_cluster_of_sentinel_s_own_holds(self):
        self.restricted_installation()
        # Besides Sentinel's database and roles: what initdb made, the bootstrap superuser and the
        # predefined roles, whose prefix PostgreSQL reserves (no one may take it).
        self.assertEqual(self.execute("SELECT datname FROM pg_catalog.pg_database ORDER BY 1"),
                         sorted([(self.database,), ("postgres",), ("template0",), ("template1",)]))
        self.assertEqual(self.execute("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname !~ '^pg_' ORDER BY oid"),
                         [(self.superuser[0],), ("sentinel_owner",), ("sentinel_migrate",), ("sentinel_app",)])
        for statement in ("CREATE ROLE pg_sentinel_probe", "ALTER ROLE sentinel_app RENAME TO pg_sentinel_probe"):
            with self.subTest(statement), self.assertRaises(psycopg.errors.ReservedName):
                self.execute(statement)
        self.assertSucceeds(self.status)
        self.assertStarted(self.web())


class LifecycleTests(ApplicationTestCase):
    """The provisioning history (sentinel/db_roles.py LIFECYCLE): A, the first activation, all at
    once; B, an activation as apply left it, which apply only sets the passwords of; C, anything
    else, which apply, status and every start refuse, changing nothing."""

    UNKNOWN = "the cluster holds a partial or unknown provisioning history (state C): "

    def provisioned(self):
        """All apply provisions but the passwords, OIDs included: what only a first activation
        creates, and a reapplication leaves as it was."""
        return self.execute(
            "SELECT 'role', rolname, concat_ws(' ', oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication,"
            "  rolbypassrls, rolinherit, rolcanlogin, rolvaliduntil) FROM pg_catalog.pg_authid WHERE rolname = ANY (%s)"
            " UNION ALL SELECT 'member', m.roleid::regrole::text || ' ' || m.member::regrole::text,"
            "  concat_ws(' ', m.admin_option, m.inherit_option, m.set_option, m.grantor::regrole)"
            "  FROM pg_catalog.pg_auth_members m WHERE m.member::regrole::text = ANY (%s) OR m.roleid::regrole::text = ANY (%s)"
            " UNION ALL SELECT 'database', datname, concat_ws(' ', oid, datdba, datacl) FROM pg_catalog.pg_database"
            " UNION ALL SELECT 'schema', nspname, concat_ws(' ', oid, nspowner, nspacl, obj_description(oid, 'pg_namespace'))"
            "  FROM pg_catalog.pg_namespace"
            " UNION ALL SELECT 'relation', relname, concat_ws(' ', relowner::regrole, relacl) FROM pg_catalog.pg_class"
            "  WHERE relnamespace = 'public'::regnamespace"
            " UNION ALL SELECT 'column', attrelid::regclass::text || '.' || attname, attacl::text FROM pg_catalog.pg_attribute"
            "  WHERE attacl IS NOT NULL AND attrelid IN (SELECT oid FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace)"
            " UNION ALL SELECT 'default', defaclrole::regrole::text, coalesce(defaclacl::text, '') FROM pg_catalog.pg_default_acl"
            " UNION ALL SELECT 'setting', setrole::text || ' ' || setdatabase::text, coalesce(setconfig::text, '')"
            "  FROM pg_catalog.pg_db_role_setting"
            " ORDER BY 1, 2, 3", list(ROLES), list(ROLES), list(ROLES))

    def verifiers(self):
        """Which stored SCRAM verifier each login has, as digests: never the verifiers themselves."""
        return dict(self.execute(
            "SELECT rolname, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(rolpassword, 'UTF8')), 'hex')"
            " FROM pg_catalog.pg_authid WHERE rolname IN ('sentinel_app', 'sentinel_migrate')"))

    def logs_in(self, user, password):
        try:
            with psycopg.connect(make_conninfo(SERVER, dbname=self.database, user=user, password=password)):
                return True
        except psycopg.OperationalError:
            return False

    def record(self):
        """Owner, ACL and comment of schema sentinel_restricted, or None."""
        rows = self.execute("SELECT nspowner, nspacl::text, obj_description(oid, 'pg_namespace')"
                            " FROM pg_catalog.pg_namespace WHERE nspname = 'sentinel_restricted'")
        return rows[0] if rows else None

    def identity(self):
        """The record of an activation this database and the three roles call for."""
        return db_roles.ACTIVATION % tuple(self.value(statement, name) for statement, name in (
            ("SELECT oid FROM pg_catalog.pg_database WHERE datname = %s", self.database),
            *(("SELECT oid FROM pg_catalog.pg_roles WHERE rolname = %s", role)
              for role in ("sentinel_owner", "sentinel_migrate", "sentinel_app"))))

    def assertRefusedEverywhere(self, problem):
        """apply (with other passwords, which it must not set), status, the migrate service and web
        refuse, name the problem, and change nothing."""
        provisioned, verifiers, old = self.provisioned(), self.verifiers(), self.passwords
        self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
        try:
            status, stderr, finished, block = self.apply()
        finally:
            self.passwords = old
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertIn(self.UNKNOWN + problem, stderr)
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        self.assertIn(problem, stderr)
        for service, user, password in ((self.migrate_service, "sentinel_migrate", self.passwords[1]),
                                        (self.web, "sentinel_app", self.passwords[0])):
            # A login that exists as apply left it is refused by the check, naming the history; one
            # that does not (or not with its password) by PostgreSQL, at login, as it should be.
            expected = REFUSED_AS_IT_IS + self.UNKNOWN + problem if self.logs_in(user, password) else AUTHENTICATION_FAILED
            result = service()
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(expected, result.stderr)
            self.assertNotIn(APPLYING, result.stderr)
            self.assertNotIn(STARTED, result.stdout)
            self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.provisioned(), provisioned)
        self.assertEqual(self.verifiers(), verifiers)

    def test_a_first_activation_creates_and_records_everything_at_once(self):
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        self.assertIn("the roles are not provisioned in this cluster (state A: run apply)", stderr)
        self.assertSucceeds(self.apply)
        # The record: the bootstrap superuser's, open to no one, of this database and these roles.
        self.assertEqual(self.record(), (10, None, self.identity()))
        self.assertSucceeds(self.status)
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_neither_login_may_alter_the_record(self):
        self.restricted_installation()
        record = self.record()
        for user, password, prefix in (("sentinel_app", self.passwords[0], ""),
                                       ("sentinel_migrate", self.passwords[1], "SET ROLE sentinel_owner; ")):
            for statement in ("COMMENT ON SCHEMA sentinel_restricted IS 'sentinel-roles activation 1: forged'",
                              "DROP SCHEMA sentinel_restricted",
                              "ALTER SCHEMA sentinel_restricted RENAME TO sentinel_elsewhere",
                              "ALTER SCHEMA sentinel_restricted OWNER TO sentinel_owner",
                              "GRANT USAGE ON SCHEMA sentinel_restricted TO PUBLIC"):
                with self.subTest(user=user, statement=statement):
                    conninfo = make_conninfo(SERVER, dbname=self.database, user=user, password=password)
                    with psycopg.connect(conninfo) as connection, self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        connection.execute(prefix + statement)
        self.assertEqual(self.record(), record)
        self.assertSucceeds(self.status)

    def test_a_reapplication_with_the_same_passwords_changes_nothing_but_the_salts(self):
        self.restricted_installation()
        provisioned, verifiers = self.provisioned(), self.verifiers()
        for _ in range(2):
            self.assertSucceeds(self.apply)
            self.assertEqual(self.provisioned(), provisioned)
            changed = self.verifiers()
            self.assertEqual(changed.keys(), verifiers.keys())
            self.assertTrue(all(changed[name] != verifiers[name] for name in verifiers))  # new salts
            verifiers = changed
        self.assertTrue(self.logs_in("sentinel_app", self.passwords[0]))
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_a_rotation_sets_the_new_passwords_only(self):
        self.restricted_installation()
        provisioned, old = self.provisioned(), self.passwords
        self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
        self.assertSucceeds(self.apply)
        self.assertEqual(self.provisioned(), provisioned)
        for (user, new), previous in zip((("sentinel_app", self.passwords[0]), ("sentinel_migrate", self.passwords[1])), old):
            self.assertTrue(self.logs_in(user, new))
            if self.passwords_are_checked():
                self.assertFalse(self.logs_in(user, previous))
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_a_rotation_cut_short_keeps_the_old_passwords(self):
        self.restricted_installation()
        provisioned, verifiers, old = self.provisioned(), self.verifiers(), self.passwords
        new = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
        program = db_roles.apply_program(self.database, *new, ())
        lines = program.sql.splitlines(keepends=True)
        for cut in ("$sentinel_create$;\n", "$sentinel_marker$;\n"):  # passwords set, no COMMIT
            with self.subTest(cut=cut):
                status, stderr, finished, _ = self.run_program(
                    db_roles.Program("".join(lines[:lines.index(cut) + 1]), program.nonce))
                self.assertEqual((status, finished), (0, False), stderr)
                self.assertEqual((self.provisioned(), self.verifiers()), (provisioned, verifiers))
                self.assertTrue(self.logs_in("sentinel_app", old[0]))
        self.passwords = new
        self.assertSucceeds(self.apply)
        self.assertTrue(self.logs_in("sentinel_app", new[0]))

    def test_what_differs_in_an_activated_installation_is_refused_and_left_as_it_is(self):
        # apply repairs nothing it cannot explain: it refuses before any change, the passwords
        # included, and the operator undoes the difference by hand.
        self.restricted_installation()
        for change, undo, problem in (
            ("ALTER ROLE sentinel_app CREATEDB", "ALTER ROLE sentinel_app NOCREATEDB",
             "a managed role has an attribute it must not have"),
            (f'ALTER ROLE sentinel_app IN DATABASE "{self.database}" SET work_mem = \'64MB\'',
             f'ALTER ROLE sentinel_app IN DATABASE "{self.database}" RESET work_mem',
             "the settings of the managed roles differ"),
            ("GRANT TRUNCATE ON auth_group TO sentinel_app", "REVOKE TRUNCATE ON auth_group FROM sentinel_app",
             "the runtime role has TRUNCATE on auth_group"),
            ("ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public GRANT TRUNCATE ON TABLES TO sentinel_app",
             "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM sentinel_app",
             "the default privileges of the owner role differ"),
            ("GRANT SELECT ON auth_user TO sentinel_app WITH GRANT OPTION",
             "REVOKE GRANT OPTION FOR SELECT ON auth_user FROM sentinel_app",
             "the runtime role lacks SELECT, or may grant it, on auth_user"),
        ):
            with self.subTest(change):
                self.execute(change)
                provisioned, verifiers, old = self.provisioned(), self.verifiers(), self.passwords
                self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
                try:
                    status, stderr, finished, block = self.apply()
                finally:
                    self.passwords = old
                self.assertEqual((status, finished, block), (3, False, "sentinel_reapply"), stderr)
                self.assertIn(problem, stderr)
                self.assertEqual((self.provisioned(), self.verifiers()), (provisioned, verifiers))
                self.assertTrue(self.logs_in("sentinel_app", old[0]))
                self.execute(undo)
                self.assertSucceeds(self.apply)

    def stored_passwords(self):
        """Digests of what pg_authid stores for each of the three roles (None: no password)."""
        return dict(self.execute(
            "SELECT rolname, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(rolpassword, 'UTF8')), 'hex')"
            " FROM pg_catalog.pg_authid WHERE rolname = ANY (%s)", list(ROLES)))

    def test_a_password_given_to_the_owner_is_refused_before_any_password_changes(self):
        self.restricted_installation()
        self.execute(sql.SQL("ALTER ROLE sentinel_owner PASSWORD {}").format(sql.Literal(secrets.token_urlsafe(48))))
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        self.assertIn("the owner role has a password", stderr)
        stored, provisioned, old = self.stored_passwords(), self.provisioned(), self.passwords
        self.assertIsNotNone(stored["sentinel_owner"])
        # A rotation is refused before it sets anything: apply repairs nothing it finds.
        self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
        try:
            status, stderr, finished, block = self.apply()
        finally:
            new, self.passwords = self.passwords, old
        self.assertEqual((status, finished, block), (3, False, "sentinel_reapply"), stderr)
        self.assertIn("the owner role has a password", stderr)
        self.assertEqual(self.stored_passwords(), stored)  # all three, the owner's included
        self.assertEqual(self.provisioned(), provisioned)
        self.assertTrue(self.logs_in("sentinel_app", old[0]))
        if self.passwords_are_checked():
            self.assertFalse(self.logs_in("sentinel_app", new[0]))
        # Undone by hand, a rotation goes through again.
        self.execute("ALTER ROLE sentinel_owner PASSWORD NULL")
        self.assertSucceeds(self.status)
        self.passwords = new
        self.assertSucceeds(self.apply)
        self.assertTrue(self.logs_in("sentinel_app", new[0]))
        self.assertIsNone(self.stored_passwords()["sentinel_owner"])

    def test_nothing_is_adopted_once_activated(self):
        self.restricted_installation()
        provisioned = self.provisioned()
        status, stderr, finished, block = self.apply("auth_user")
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertIn("activated already (state B): there is nothing to adopt", stderr)
        self.assertEqual(self.provisioned(), provisioned)

    def test_a_partial_history_before_any_activation_is_refused(self):
        for name, change, problem in (
            ("the record alone", "CREATE SCHEMA sentinel_restricted",
             "schema sentinel_restricted, the record of an activation, exists without the roles"),
            ("one of the roles", "CREATE ROLE sentinel_owner NOLOGIN",
             "only 1 of the roles sentinel_owner, sentinel_migrate and sentinel_app exist"),
            ("two of the roles", "CREATE ROLE sentinel_app NOLOGIN; CREATE ROLE sentinel_migrate NOLOGIN",
             "only 2 of the roles sentinel_owner, sentinel_migrate and sentinel_app exist"),
            ("the roles alone",
             "CREATE ROLE sentinel_owner NOLOGIN; CREATE ROLE sentinel_migrate NOLOGIN; CREATE ROLE sentinel_app NOLOGIN",
             "the roles exist, but schema sentinel_restricted, the record of their activation, does not"),
        ):
            with self.subTest(name):
                self.execute(change)
                try:
                    self.assertRefusedEverywhere(problem)
                finally:
                    self.execute("DROP SCHEMA IF EXISTS sentinel_restricted; DROP ROLE IF EXISTS sentinel_app;"
                                 " DROP ROLE IF EXISTS sentinel_migrate; DROP ROLE IF EXISTS sentinel_owner")
                self.assertUnprovisioned()
        self.assertSucceeds(self.apply)

    def test_an_activation_record_that_differs_is_refused(self):
        self.restricted_installation()
        identity = self.identity()
        superuser = self.superuser[0]
        for name, change, undo, problem in (
            ("removed", "DROP SCHEMA sentinel_restricted",
             f"CREATE SCHEMA sentinel_restricted; COMMENT ON SCHEMA sentinel_restricted IS '{identity}'",
             "the roles exist, but schema sentinel_restricted, the record of their activation, does not"),
            ("of another database", "COMMENT ON SCHEMA sentinel_restricted IS "
             f"'{identity.replace('database=', 'database=9')}'",
             f"COMMENT ON SCHEMA sentinel_restricted IS '{identity}'",
             f"schema sentinel_restricted records \"{identity.replace('database=', 'database=9')}\", not this"
             f" database and these roles ({identity})"),
            ("without its comment", "COMMENT ON SCHEMA sentinel_restricted IS NULL",
             f"COMMENT ON SCHEMA sentinel_restricted IS '{identity}'",
             f"schema sentinel_restricted records no activation, not this database and these roles ({identity})"),
            ("given to another role", "ALTER SCHEMA sentinel_restricted OWNER TO sentinel_owner",
             f'ALTER SCHEMA sentinel_restricted OWNER TO "{superuser}"',
             "schema sentinel_restricted belongs to sentinel_owner, not to the bootstrap superuser"),
            ("opened to a login", "GRANT USAGE ON SCHEMA sentinel_restricted TO sentinel_app",
             "REVOKE USAGE ON SCHEMA sentinel_restricted FROM sentinel_app",
             "schema sentinel_restricted is open to other roles than its owner"),
            ("opened to PUBLIC", "GRANT USAGE ON SCHEMA sentinel_restricted TO PUBLIC",
             "REVOKE USAGE ON SCHEMA sentinel_restricted FROM PUBLIC",
             "schema sentinel_restricted is open to other roles than its owner"),
        ):
            with self.subTest(name):
                self.execute(change)
                try:
                    self.assertRefusedEverywhere(problem)
                finally:
                    self.execute(undo)
                # Undone by hand, exactly: it is the same activation again.
                self.assertSucceeds(self.status)
                self.assertStarted(self.web())

    def test_a_role_made_again_under_the_same_name_is_not_the_activated_one(self):
        self.restricted_installation()
        recorded = self.identity()
        # What an administrator could do to a lost login: drop it and create it again.
        self.execute("DROP OWNED BY sentinel_app; DROP ROLE sentinel_app;"
                     " CREATE ROLE sentinel_app LOGIN NOINHERIT")
        self.assertNotEqual(self.identity(), recorded)
        self.assertRefusedEverywhere(f'schema sentinel_restricted records "{recorded}", not this database and'
                                     f" these roles ({self.identity()})")


def child_conninfo(server, **settings):
    """``server`` with ``settings``, as a process of the tests connects: without the password
    ``server`` may hold, the bootstrap superuser's, which would outrank PGPASSWORD (libpq takes the
    connection string's first) and have the process log in as no one it means to."""
    parameters = conninfo_to_dict(server)
    parameters.pop("password", None)
    parameters.update(settings)
    return make_conninfo(**parameters)


def psql_import_command(server, database, user, password, role, path):
    """psql running \\lo_import of ``path`` as ``user`` (switched to ``role`` at login): its arguments,
    which hold no password, and its environment, whose PGPASSWORD is ``user``'s. It says first which
    login it is, so that a refusal is told from a failed login."""
    environment = {name: value for name, value in os.environ.items()
                   if name not in ("PGPASSWORD", "PGOPTIONS", "SENTINEL_TEST_POSTGRES")}
    environment["PGPASSWORD"] = password
    if role:
        environment["PGOPTIONS"] = f"-c role={role}"
    return (["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", child_conninfo(server, dbname=database, user=user),
             "-c", "SELECT session_user || ' as ' || current_user", "-c", f"\\lo_import {path}"], environment)


class LargeObjectTests(RoleCheckTestCase):
    """Neither login may create a large object, by any of PostgreSQL's ways to, as itself or as the
    owner role (sentinel/db_roles.py LARGE_OBJECTS). Whatever would let one is refused everywhere,
    apply included, and left for the operator to revoke."""

    # Every SQL function that creates one; psql's \lo_import goes through libpq's lo_creat.
    CREATIONS = (
        "SELECT pg_catalog.lo_creat(-1)",
        "SELECT pg_catalog.lo_create(0)",
        "SELECT pg_catalog.lo_create(434343)",
        "SELECT pg_catalog.lo_from_bytea(0, 'sentinel probe')",
        "SELECT pg_catalog.lo_import('/etc/hosts')",  # a file of the server's
        "SELECT pg_catalog.lo_import('/etc/hosts', 434344)",
    )

    def logins(self):
        """Each way a login could act: the runtime login, the migration login, and the latter as the owner."""
        return (("sentinel_app", self.passwords[0], ""), ("sentinel_migrate", self.passwords[1], ""),
                ("sentinel_migrate", self.passwords[1], "SET ROLE sentinel_owner"))

    def attempt(self, user, password, prefix, statement):
        """``statement`` as ``user`` (after ``prefix``), rolled back: None when PostgreSQL allows it, else the error."""
        with psycopg.connect(make_conninfo(SERVER, dbname=self.database, user=user, password=password)) as connection:
            try:
                if prefix:
                    connection.execute(prefix)
                connection.execute(statement)
            except psycopg.Error as exc:
                return exc
            finally:
                connection.rollback()
        return None

    def psql_import(self, user, password, role=None):
        """psql's \\lo_import as ``user`` (switched to ``role`` at login): its exit status, the
        login it says it is, and its errors."""
        with tempfile.NamedTemporaryFile("w", suffix=".txt") as source:
            source.write("sentinel probe\n")
            source.flush()
            command, environment = psql_import_command(SERVER, self.database, user, password, role, source.name)
            result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=60, check=False)
        return result.returncode, result.stdout.strip(), result.stderr

    def large_objects(self):
        return self.value("SELECT count(*) FROM pg_catalog.pg_largeobject_metadata")

    def assertRefusal(self, refusal, *texts):
        """``refusal`` is a refusal (not None: the check let it pass), saying each of ``texts``."""
        self.assertIsNotNone(refusal, "the check refused nothing")
        for text in texts:
            self.assertIn(text, refusal)

    def large_object_check(self, fragment=db_roles.LARGE_OBJECTS):
        """The large-object check on its own, as the final checks run it: its refusal, or None."""
        block = "DO $check$\n" + db_roles.DECLARE + "BEGIN\n" + db_roles.ROLE_OIDS + fragment + "END\n$check$"
        with self.connect(self.database) as connection:
            connection.execute("SET search_path = pg_catalog, pg_temp")
            try:
                connection.execute(block)
            except psycopg.errors.RaiseException as exc:
                return str(exc)
        return None

    def test_neither_login_may_create_one_by_any_path(self):
        before = self.large_objects()
        for user, password, prefix in self.logins():
            for statement in self.CREATIONS:
                with self.subTest(user=user, owner=bool(prefix), statement=statement):
                    error = self.attempt(user, password, prefix, statement)
                    self.assertIsInstance(error, psycopg.errors.InsufficientPrivilege)
                    self.assertIn("permission denied for function lo_", str(error))
            with self.subTest(user=user, owner=bool(prefix), statement="\\lo_import"):
                role = "sentinel_owner" if prefix else None
                status, login, errors = self.psql_import(user, password, role)
                # Logged in as the login meant (not refused at login), then refused the import.
                self.assertNotIn(AUTHENTICATION_FAILED, errors)
                self.assertEqual(login, f"{user} as {role or user}", errors)
                self.assertNotEqual(status, 0, errors)
                self.assertIn("permission denied for function lo_creat", errors)
        self.assertEqual(self.large_objects(), before)
        self.assertIsNone(self.large_object_check())
        # What the application does, it still may; the migrations ran (setUp), and run again.
        self.assertEqual(
            self.as_runtime("INSERT INTO auth_group (name) VALUES ('sentinel probe') RETURNING name",
                            "UPDATE auth_group SET name = 'sentinel probe 2' WHERE name = 'sentinel probe' RETURNING name",
                            "DELETE FROM auth_group WHERE name = 'sentinel probe 2' RETURNING name"),
            [[("sentinel probe",)], [("sentinel probe 2",)], [("sentinel probe 2",)]])
        self.assertSucceeds(self.apply)  # a reapplication of what holds
        self.assertAccepted()

    def test_each_way_to_hold_execute_is_refused_and_left_for_the_operator(self):
        superuser = self.superuser[0]
        all_three = "pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid), pg_catalog.lo_from_bytea(oid, bytea)"
        cases = (
            # What an administrator changed, its undoing, which login (logins()) PostgreSQL then lets
            # create one and how, and what the refusal says to run.
            ("PUBLIC given one back", "GRANT EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) TO PUBLIC",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC",
             0, "SELECT pg_catalog.lo_from_bytea(0, 'x')",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_from_bytea(oid,bytea) FROM PUBLIC",)),
            ("PUBLIC given all of them back", f"GRANT EXECUTE ON FUNCTION {all_three} TO PUBLIC",
             f"REVOKE EXECUTE ON FUNCTION {all_three} FROM PUBLIC", 1, "SELECT pg_catalog.lo_creat(-1)",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_creat(integer) FROM PUBLIC; "
              f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_create(oid) FROM PUBLIC; "
              f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_from_bytea(oid,bytea) FROM PUBLIC",)),
            ("the runtime login", "GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO sentinel_app",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM sentinel_app", 0, "SELECT pg_catalog.lo_create(0)",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_create(oid) FROM sentinel_app",)),
            ("the migration login", "GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO sentinel_migrate",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM sentinel_migrate", 1, "SELECT pg_catalog.lo_create(0)",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_create(oid) FROM sentinel_migrate",)),
            ("the owner role", "GRANT EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) TO sentinel_owner",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) FROM sentinel_owner", 2, "SELECT pg_catalog.lo_creat(-1)",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_creat(integer) FROM sentinel_owner",)),
            ("the server-side import", "GRANT EXECUTE ON FUNCTION pg_catalog.lo_import(text) TO PUBLIC",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text) FROM PUBLIC", 0,
             "SELECT pg_catalog.lo_import('/etc/hosts')",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_import(text) FROM PUBLIC",)),
            # Another name for a creating function: known by the C function it calls, wherever it is.
            ("a function of the same kind",
             "CREATE FUNCTION pg_catalog.sentinel_lo_new(oid) RETURNS oid LANGUAGE internal STRICT AS 'be_lo_create'",
             "DROP FUNCTION pg_catalog.sentinel_lo_new(oid)", 0, "SELECT pg_catalog.sentinel_lo_new(0)",
             (f"as {superuser}: REVOKE EXECUTE ON FUNCTION sentinel_lo_new(oid) FROM PUBLIC",)),
        )
        for name, change, undo, login, probe, problems in cases:
            with self.subTest(name):
                self.execute(change)
                try:
                    user, password, prefix = self.logins()[login]
                    self.assertIsNone(self.attempt(user, password, prefix, probe))  # PostgreSQL itself would let it
                    self.assertRefusedEverywhere("the managed roles could create large objects", *problems)
                    status, stderr, finished, block = self.apply()
                    self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                    for problem in problems:
                        self.assertIn(problem, stderr)
                    self.assertIsNone(self.attempt(user, password, prefix, probe))  # nothing was revoked for the operator
                finally:
                    self.execute(undo)
                self.assertAccepted()
                self.assertSucceeds(self.apply)

    def test_a_role_the_logins_belong_to_counts(self):
        superuser = self.superuser[0]
        for options, prefix in (("INHERIT TRUE", ""), ("INHERIT FALSE, SET TRUE", "SET ROLE pg_read_all_data")):
            with self.subTest(options=options):
                self.execute("GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO pg_read_all_data;"
                             f" GRANT pg_read_all_data TO sentinel_app WITH {options}")
                try:
                    self.assertIsNone(self.attempt("sentinel_app", self.passwords[0], prefix, "SELECT pg_catalog.lo_create(0)"))
                    self.assertRefusedEverywhere("role memberships differ")
                    status, stderr, finished, block = self.apply()
                    self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                    # The large-object check on its own finds the path too, and says whom to revoke it from.
                    self.assertRefusal(self.large_object_check(),
                                       f"as {superuser}: REVOKE EXECUTE ON FUNCTION lo_create(oid) FROM pg_read_all_data")
                finally:
                    self.execute("REVOKE pg_read_all_data FROM sentinel_app;"
                                 " REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM pg_read_all_data")
                self.assertAccepted()

    def test_a_superuser_holds_it_through_the_owner_of_the_functions(self):
        # No grant names a managed role made a superuser: it is a member of every role, the owner of
        # the functions included, whose entry their ACL holds (every check refuses the attribute
        # first; here the large-object check runs alone).
        self.execute("ALTER ROLE sentinel_app SUPERUSER")
        try:
            self.assertRefusal(self.large_object_check(), "the managed roles could create large objects",
                               f"as {self.superuser[0]}: REVOKE EXECUTE ON FUNCTION lo_creat(integer) FROM {self.superuser[0]}")
        finally:
            self.execute("ALTER ROLE sentinel_app NOSUPERUSER")
        self.assertIsNone(self.large_object_check())

    def test_a_large_object_function_it_does_not_know_is_refused(self):
        # This server's large-object functions are the ones classified (CI runs it on PostgreSQL 16 and 18).
        self.assertEqual(
            {name for (name,) in self.execute("SELECT p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language g"
                                              " ON g.oid = p.prolang WHERE g.lanname = 'internal' AND p.prosrc LIKE 'be\\_lo%'")},
            set(db_roles.LARGE_OBJECT_CREATORS) | set(db_roles.LARGE_OBJECT_OTHERS))
        # What a later PostgreSQL could add, here one of today's left out of the classification.
        others = tuple(name for name in db_roles.LARGE_OBJECT_OTHERS if name != "be_lo_tell64")
        self.assertRefusal(self.large_object_check(db_roles._large_objects(others=others)),
                           "PostgreSQL has large-object functions this program does not know, which may create large"
                           " objects: lo_tell64(integer) (be_lo_tell64)")
        self.assertIsNone(self.large_object_check())

    def test_a_large_object_of_a_managed_role_is_refused(self):
        oid = self.value("SELECT pg_catalog.lo_from_bytea(0, 'left behind')")
        self.execute(f"ALTER LARGE OBJECT {oid} OWNER TO sentinel_app")
        try:
            self.assertRefusedEverywhere(f"large objects belong to a managed role: {oid} (sentinel_app)")
        finally:
            self.execute(f"SELECT pg_catalog.lo_unlink({oid})")
        self.assertAccepted()


class RecordProbes:
    """Django's record of the migrations (django_migrations), as sentinel_app and the
    migrate service's login meet it."""

    def migrate_settings(self):
        return {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate", "POSTGRES_PASSWORD": None,
                "SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1]}

    def runtime_writes(self, *preamble):
        """What PostgreSQL answers each write of the record by sentinel_app, connected with its
        password and no Sentinel process in between: "allowed", or the error. Rolled back."""
        conninfo = make_conninfo(SERVER, dbname=self.database, user="sentinel_app", password=self.passwords[0])
        outcomes = {}
        with psycopg.connect(conninfo, autocommit=True) as connection:
            for verb, statement in RECORD_WRITES.items():
                try:
                    with connection.transaction(force_rollback=True):
                        for line in preamble:
                            connection.execute(line)
                        connection.execute(statement)
                    outcomes[verb] = "allowed"
                except psycopg.Error as exc:
                    outcomes[verb] = type(exc).__name__
        return outcomes

    def record_privileges(self):
        """What sentinel_app may do to the record, as PostgreSQL decides it: by itself, through
        PUBLIC, the roles it inherits from and those it may SET ROLE to, on a column too."""
        return {privilege for (privilege,) in self.execute(
            "SELECT p FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',"
            " 'TRIGGER']) p WHERE EXISTS (SELECT FROM pg_catalog.pg_roles r"
            " WHERE pg_catalog.pg_has_role('sentinel_app', r.oid, 'SET')"
            " AND CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')"
            " THEN pg_catalog.has_any_column_privilege(r.oid, 'public.django_migrations', p)"
            " ELSE pg_catalog.has_table_privilege(r.oid, 'public.django_migrations', p) END)")}

    def record(self):
        """The record as it stands, or None when there is none."""
        if not self.value("SELECT pg_catalog.to_regclass('public.django_migrations') IS NOT NULL"):
            return None
        return self.execute("SELECT id, app, name, applied FROM public.django_migrations ORDER BY id")

    def creation(self):
        """Django creating the record as the migrate service's login, paused before its commit
        (CREATION); returns the process and its backend, once the table exists in its transaction,
        with what sentinel_app could do as that transaction sees it."""
        process = subprocess.Popen(
            [sys.executable, "manage.py", "shell", "--no-imports", "-v", "0", "-c", CREATION], cwd=ROOT,
            env=self.environment(self.migrate_settings()), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and os.killpg(process.pid, signal.SIGKILL))
        line = process.stdout.readline().split()
        if not line or line[0] != "created":
            process.kill()
            self.fail(f"the creation did not pause: {line} {process.communicate()[1]}")
        return process, int(line[1]), {"INSERT": line[2], "UPDATE": line[3], "DELETE": line[4]}

    def gone(self, pid):
        for _ in range(300):
            if not self.value("SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid = %s", pid):
                return
            time.sleep(0.1)
        self.fail(f"backend {pid} did not end")

    def run_migrate_service(self, *arguments):
        """A command of the migrate service: its entrypoint, checks included."""
        return self.entrypoint(*arguments, **self.migrate_settings())

    def direct_migrate(self, *arguments):
        """manage.py migrate as the migrate service's login, past its entrypoint (docker compose
        run --entrypoint, a shell in the container)."""
        return self.manage("migrate", "--noinput", *arguments, **self.migrate_settings())

    def record_acl(self):
        """The record's ACL and the state of its identity sequence."""
        return self.execute("SELECT c.relacl::text, s.last_value, s.is_called FROM pg_catalog.pg_class c,"
                            " LATERAL (SELECT last_value, is_called FROM public.django_migrations_id_seq) s"
                            " WHERE c.oid = 'public.django_migrations'::pg_catalog.regclass")


class MigrationRecordTests(RecordProbes, ApplicationTestCase):
    """sentinel_app never writes django_migrations, which decides the DDL the owner runs, in
    any state another session can see: before it exists, while Django creates it, after the
    migrations, after an interruption and after a restart (sentinel/postgresql)."""

    def test_from_before_the_record_exists_to_every_restart(self):
        self.assertSucceeds(self.apply)
        self.assertIsNone(self.record())
        self.assertEqual(self.runtime_writes(), ABSENT)
        # Django creates it: no other session sees it, and the transaction that will commit it
        # already lets sentinel_app only read it.
        process, _, inside = self.creation()
        self.assertEqual(inside, {"INSERT": "False", "UPDATE": "False", "DELETE": "False"})
        self.assertIsNone(self.record())
        self.assertEqual(self.runtime_writes(), ABSENT)
        out, err = process.communicate("commit\n", timeout=120)
        self.assertEqual((process.returncode, out), (0, "committed\n"), err)
        self.assertEqual(self.record(), [])
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})
        # The migrations, then restarts of both services.
        for run in (self.migrate_service, self.web, self.migrate_service, self.web):
            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.runtime_writes(), DENIED)
            self.assertEqual(self.record_privileges(), {"SELECT"})
        self.assertIn(("sessions", "0001_initial"), [(app, name) for _, app, name, _ in self.record()])

    def test_a_creation_cut_short_leaves_no_record_and_the_retry_makes_it_read_only(self):
        self.assertSucceeds(self.apply)
        for how in ("rolled back", "killed"):
            with self.subTest(how):
                process, pid, _ = self.creation()
                if how == "killed":
                    # The container dies with the transaction open: PostgreSQL rolls it back.
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                else:
                    out, _ = process.communicate("stop\n", timeout=120)
                    self.assertNotIn("committed", out)
                self.gone(pid)
                self.assertIsNone(self.record())
                self.assertEqual(self.runtime_writes(), ABSENT)
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})

    def test_a_migration_cut_short_leaves_the_record_read_only_and_the_retry_finishes(self):
        self.assertSucceeds(self.apply)
        result = self.run_migrate_service("python", "manage.py", "migrate", "--noinput", "contenttypes", "0001")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.runtime_writes(), DENIED)
        # The next migration of contenttypes alters django_content_type: held inside its
        # transaction by a lock, then the service is killed and its backend ended.
        blocker = psycopg.connect(make_conninfo(SERVER, dbname=self.database))
        self.addCleanup(blocker.close)
        blocker.execute("LOCK TABLE public.django_content_type IN ACCESS SHARE MODE")
        service = subprocess.Popen([shutil.which("dash") or "sh", "./entrypoint.sh", "apply-migrations"], cwd=ROOT,
                                   env=self.environment(self.migrate_settings()), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.addCleanup(lambda: service.poll() is None and os.killpg(service.pid, signal.SIGKILL))
        for _ in range(600):
            waiting = self.execute("SELECT pid FROM pg_catalog.pg_stat_activity"
                                   " WHERE usename = 'sentinel_migrate' AND wait_event_type = 'Lock'")
            if waiting or service.poll() is not None:
                break
            time.sleep(0.1)
        self.assertTrue(waiting, service.communicate()[1] if service.poll() is not None else "no migration waited")
        ((pid,),) = waiting
        self.assertEqual(self.runtime_writes(), DENIED)  # a migration open
        os.killpg(service.pid, signal.SIGKILL)
        service.wait()
        self.assertTrue(self.value("SELECT pg_catalog.pg_terminate_backend(%s)", pid))
        blocker.rollback()
        self.gone(pid)
        recorded = [(app, name) for _, app, name, _ in self.record()]
        self.assertIn(("contenttypes", "0001_initial"), recorded)
        self.assertNotIn(("contenttypes", "0002_remove_content_type_name"), recorded)
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})
        # Run again, it finishes.
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(("contenttypes", "0002_remove_content_type_name"),
                      [(app, name) for _, app, name, _ in self.record()])
        self.assertStarted(self.web())
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})

    def test_past_the_entrypoint_a_record_writable_another_way_is_never_committed(self):
        # manage.py migrate run without the entrypoint's check (docker compose run --entrypoint):
        # default privileges that would give PUBLIC a write on every new table, or a role
        # sentinel_app may become that writes every table. The transaction that creates the
        # record refuses to commit it.
        self.assertSucceeds(self.apply)
        for name, change, undo, found in (
            ("INSERT to PUBLIC", "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public GRANT INSERT ON TABLES TO PUBLIC",
             "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public REVOKE INSERT ON TABLES FROM PUBLIC",
             "INSERT as sentinel_app"),
            ("UPDATE alone to PUBLIC",
             "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public GRANT UPDATE ON TABLES TO PUBLIC",
             "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public REVOKE UPDATE ON TABLES FROM PUBLIC",
             "UPDATE as sentinel_app"),
            ("to a role it may switch to", "GRANT pg_write_all_data TO sentinel_app WITH INHERIT FALSE, SET TRUE",
             "REVOKE pg_write_all_data FROM sentinel_app",
             "DELETE as pg_write_all_data, INSERT as pg_write_all_data, UPDATE as pg_write_all_data"),
        ):
            with self.subTest(name):
                self.execute(change)
                try:
                    result = self.manage("migrate", "--noinput", **self.migrate_settings())
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Unable to create the django_migrations table (sentinel_app could change "
                                  "django_migrations, which decides what migrate runs, or hand a privilege on it on ("
                                  + found + ")", result.stderr)
                    self.assertIsNone(self.record())
                    self.assertEqual(self.tables(), [])  # no migration ran either
                    self.assertEqual(self.runtime_writes(), ABSENT)
                finally:
                    self.execute(undo)
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.runtime_writes(), DENIED)

    def test_a_direct_migrate_without_a_record_creates_it_read_only(self):
        # The first activation: no record yet, nothing to refuse.
        self.assertSucceeds(self.apply)
        self.assertIsNone(self.record())
        result = self.direct_migrate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(("sessions", "0001_initial"), [(app, name) for _, app, name, _ in self.record()])
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})

    def test_the_check_before_the_migrations_cannot_write(self):
        # The session verify opens: PostgreSQL refuses every write in it, as the owner too.
        self.assertSucceeds(self.apply)
        conninfo = make_conninfo(SERVER, dbname=self.database, user="sentinel_migrate", password=self.passwords[1],
                                 options=database.READ_ONLY)
        with psycopg.connect(conninfo) as connection:
            connection.execute("SET ROLE sentinel_owner")
            with self.assertRaises(psycopg.errors.ReadOnlySqlTransaction):
                connection.execute("CREATE TABLE public.django_migrations (id integer)")
        self.assertIsNone(self.record())

    def test_an_existing_installation_is_read_only_for_it_before_its_first_separate_migration(self):
        tables = self.legacy_installation()
        self.assertIn("django_migrations", tables)
        self.assertSucceeds(lambda: self.apply(*tables))
        self.assertEqual(self.runtime_writes(), DENIED)
        self.assertEqual(self.record_privileges(), {"SELECT"})
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.runtime_writes(), DENIED)


class UnsafeMigrationRecordTests(RecordProbes, RoleCheckTestCase):
    """A django_migrations sentinel_app may write, by any path, stops both services before any
    migration runs, and nothing takes it back but the operator, by hand: apply refuses, and
    changes nothing, while the roles differ from what it provisioned (state C)."""

    def sessions(self):
        """Whether the migration of sessions is recorded, and whether its table exists."""
        return (self.value("SELECT EXISTS (SELECT FROM public.django_migrations WHERE app = 'sessions')"),
                self.value("SELECT pg_catalog.to_regclass('public.django_session') IS NOT NULL"))

    def unapply_sessions(self):
        """A migration waiting to run: the one of sessions, taken back by the migrate service."""
        result = self.run_migrate_service("python", "manage.py", "migrate", "--noinput", "sessions", "zero")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sessions(), (False, False))

    def test_a_direct_migrate_never_runs_while_the_runtime_login_may_write_the_record(self):
        # Stopped before anything ran, and nothing repaired behind the operator's back.
        self.unapply_sessions()
        self.execute("GRANT INSERT, UPDATE, DELETE ON django_migrations TO sentinel_app")
        record, acl = self.record(), self.record_acl()
        result = self.direct_migrate()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("CommandError: nothing was migrated: sentinel_app could change django_migrations, which decides"
                      " what migrate runs, or hand a privilege on it on (DELETE as sentinel_app, INSERT as sentinel_app,"
                      " UPDATE as sentinel_app)", result.stderr)
        self.assertNotIn("Applying", result.stdout)
        self.assertEqual(self.sessions(), (False, False))
        self.assertEqual(self.record(), record)  # no migration recorded, none removed
        self.assertEqual(self.record_acl(), acl)  # the grants and the identity sequence as they were
        self.assertEqual(self.runtime_writes(), dict.fromkeys(RECORD_WRITES, "allowed"))

    def test_a_direct_migrate_with_a_read_only_record_runs(self):
        self.unapply_sessions()
        result = self.direct_migrate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Applying sessions.0001_initial", result.stdout)
        self.assertEqual(self.sessions(), (True, True))
        self.assertEqual(self.runtime_writes(), DENIED)

    def test_the_check_of_migrate_cannot_write_and_leaves_the_session_as_it_was(self):
        result = self.run_process([sys.executable, "manage.py", "shell", "--no-imports", "-v", "0", "-c", GUARD_PROBE],
                                  self.migrate_settings())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "alone refused ReadOnlySqlTransaction",
            "before writable",
            "nested refused ReadOnlySqlTransaction",
            "after writable",
        ])
        self.assertFalse(self.value("SELECT EXISTS (SELECT FROM public.auth_group WHERE name LIKE 'sentinel guard probe%')"))

    def test_verify_checks_in_a_session_that_cannot_write(self):
        # The connection verify itself opens, as each login: a write the login could make
        # anywhere else is refused by PostgreSQL in it.
        for access, setting, password in (("migrate", "SENTINEL_DB_MIGRATE_PASSWORD", self.passwords[1]),
                                          ("runtime", "SENTINEL_DB_PASSWORD", self.passwords[0])):
            with self.subTest(access=access):
                environ = {"POSTGRES_HOST": self.server[0], "POSTGRES_PORT": self.server[1],
                           "POSTGRES_DB": self.database, "SENTINEL_DB_ROLES": "separate",
                           "SENTINEL_DB_ACCESS": access, setting: password}
                err = io.StringIO()
                with mock.patch.object(db_roles, "startup_check", return_value=VERIFY_PROBE), redirect_stderr(err):
                    status = database.verify(environ)
                self.assertEqual((status, err.getvalue()), (0, ""))
                with redirect_stderr(err):
                    self.assertEqual(database.verify(environ), 0, err.getvalue())
        self.assertFalse(self.value("SELECT EXISTS (SELECT FROM public.auth_group WHERE name = 'sentinel verify probe')"))

    def test_every_path_to_a_write_stops_everything_until_the_operator_corrects_it(self):
        cases = (
            # What an administrator changed, what sentinel_app runs first to write with it (None:
            # it may not write), the refusal, and the operator's correction, with the block of
            # apply that refuses, changing nothing, until then.
            ("a grant to the runtime login", "GRANT INSERT, UPDATE, DELETE ON django_migrations TO sentinel_app",
             (), "the runtime role has INSERT on django_migrations",
             ("REVOKE INSERT, UPDATE, DELETE ON django_migrations FROM sentinel_app", "sentinel_reapply")),
            ("a grant to PUBLIC", "GRANT DELETE ON django_migrations TO PUBLIC",
             (), "the runtime role has DELETE on django_migrations",
             ("REVOKE DELETE ON django_migrations FROM PUBLIC", "sentinel_reapply")),
            ("UPDATE alone to PUBLIC", "GRANT UPDATE ON django_migrations TO PUBLIC",
             (), "the runtime role has UPDATE on django_migrations",
             ("REVOKE UPDATE ON django_migrations FROM PUBLIC", "sentinel_reapply")),
            ("a column grant to the runtime login", "GRANT UPDATE (name) ON django_migrations TO sentinel_app",
             (), "the runtime role has UPDATE on django_migrations",
             ("REVOKE UPDATE (name) ON django_migrations FROM sentinel_app", "sentinel_reapply")),
            ("a column grant to PUBLIC", "GRANT INSERT (app, name, applied) ON django_migrations TO PUBLIC",
             (), "the runtime role has INSERT on django_migrations",
             ("REVOKE INSERT (app, name, applied) ON django_migrations FROM PUBLIC", "sentinel_reapply")),
            # pg_write_all_data, predefined: the roles a cluster of Sentinel's own holds besides.
            ("inherited from a role", "GRANT pg_write_all_data TO sentinel_app WITH INHERIT TRUE",
             (), "role memberships differ",
             ("REVOKE pg_write_all_data FROM sentinel_app", "sentinel_preflight",
              "unexpected role memberships, revoke them first: sentinel_app in pg_write_all_data")),
            ("a role it may switch to", "GRANT pg_write_all_data TO sentinel_app WITH INHERIT FALSE, SET TRUE",
             ("SET ROLE pg_write_all_data",), "role memberships differ",
             ("REVOKE pg_write_all_data FROM sentinel_app", "sentinel_preflight",
              "unexpected role memberships, revoke them first: sentinel_app in pg_write_all_data")),
            # Not a write, but more than reading: refused and corrected alike.
            ("a grant option on a column", "GRANT SELECT (id) ON django_migrations TO sentinel_app WITH GRANT OPTION",
             None, "the runtime role has column privileges in schema public",
             ("REVOKE SELECT (id) ON django_migrations FROM sentinel_app", "sentinel_reapply")),
            ("a grant option on the table", "GRANT SELECT ON django_migrations TO sentinel_app WITH GRANT OPTION",
             None, "the runtime role lacks SELECT, or may grant it, on django_migrations",
             ("REVOKE GRANT OPTION FOR SELECT ON django_migrations FROM sentinel_app", "sentinel_reapply")),
        )
        self.unapply_sessions()
        for name, change, preamble, problem, correction in cases:
            with self.subTest(name):
                self.execute(change)
                writes = self.runtime_writes(*preamble or ())
                if preamble is None:
                    self.assertEqual(writes, DENIED)
                else:
                    self.assertIn("allowed", writes.values())  # PostgreSQL itself lets sentinel_app write it
                record = self.record()
                for service in (self.migrate_service, self.web):
                    result = service()
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn(REFUSED_AS_IT_IS + problem, result.stderr)
                    self.assertNotIn(APPLYING, result.stderr)
                    self.assertNotIn(STARTED, result.stdout)
                # manage.py migrate past the entrypoint stops as well.
                result = self.direct_migrate()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("CommandError: nothing was migrated: sentinel_app could change django_migrations",
                              result.stderr)
                self.assertNotIn("Applying", result.stdout)
                self.assertEqual(self.record(), record)  # nothing written: the migration still waits
                self.assertEqual(self.sessions(), (False, False))
                status, stderr, finished, block = self.status()
                self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
                self.assertIn(problem, stderr)
                # apply repairs nothing: it refuses, as it is, and the operator revokes by hand.
                statement, refusing, *refusal = correction
                acl = self.record_acl()
                status, stderr, finished, block = self.apply()
                self.assertEqual((status, finished, block), (3, False, refusing), stderr)
                self.assertIn(refusal[0] if refusal else problem, stderr)
                self.assertEqual(self.record_acl(), acl)
                self.execute(statement)
                self.assertEqual(self.runtime_writes(), DENIED)
                self.assertEqual(self.record_privileges(), {"SELECT"})
                result = self.migrate_service()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.sessions(), (True, True))
                self.assertStarted(self.web())
                self.assertEqual(self.runtime_writes(), DENIED)
                self.unapply_sessions()


# The privilege model, kind by kind: the test that refuses each, with PostgreSQL itself
# showing the access it would give. PrivilegeModelTests (test_db_roles.py) keeps this
# complete and pointing at tests that exist.
PRIVILEGE_MODEL = {
    "database privileges": ("StartupTests.test_a_role_that_may_do_more_or_less_stops_both_services",
                            "GRANT CREATE ON DATABASE"),
    "schema privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                          "a schema to PUBLIC, whose functions PUBLIC may run by default"),
    "table and view privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it", "a view to PUBLIC"),
    "column privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it", "a column to PUBLIC"),
    "sequence privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it", "a sequence to PUBLIC"),
    "function privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                            "a system function PUBLIC may not run after initdb"),
    "large-object privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                                "a large object to PUBLIC"),
    "foreign-data wrapper and server privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                                                   "a foreign server to PUBLIC"),
    "tablespace privileges": ("UnexpectedAccessTests.test_a_tablespace_of_the_cluster", "CREATE ON TABLESPACE"),
    "parameter privileges": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                             "a parameter PUBLIC may set"),
    "role memberships": ("UnexpectedAccessTests.test_each_kind_of_object_and_each_way_to_hold_it",
                         "through a role the runtime login belongs to"),
    "PUBLIC-derived privileges": ("UnexpectedAccessTests.test_public_usage_and_privileges_outside_schema_public",
                                  "GRANT USAGE ON SCHEMA extra_schema TO PUBLIC"),
    "cross-database CONNECT": ("UnexpectedAccessTests.test_other_databases_are_out_of_reach", "GRANT CONNECT"),
    "retained cross-database sessions": ("SessionDrainTests.test_a_session_left_open_elsewhere_stops_everything_until_it_ends",
                                         "pg_terminate_backend"),
    "system-object provenance": ("ProvenanceTests.test_new_objects_in_the_system_schemas_are_not_the_system",
                                 "a SECURITY DEFINER function in pg_catalog, run by PUBLIC"),
    "code made after initdb": ("ProvenanceTests.test_code_made_after_initdb_is_refused_even_where_nobody_may_use_it",
                               "CREATE CAST (point AS text)"),
    "temporary tables": ("StartupTests.test_a_role_that_may_do_more_or_less_stops_both_services", "TEMPORARY"),
    "large-object creation": ("LargeObjectTests.test_each_way_to_hold_execute_is_refused_and_left_for_the_operator",
                              "GRANT EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) TO PUBLIC"),
    "what other sessions could be made to run": ("DriftTests.test_what_other_sessions_could_be_made_to_run_is_refused",
                                                 "CREATE RULE sentinel_probe AS ON INSERT TO auth_group"),
    "writes to the record of the migrations": (
        "UnsafeMigrationRecordTests.test_every_path_to_a_write_stops_everything_until_the_operator_corrects_it",
        "GRANT INSERT (app, name, applied) ON django_migrations TO PUBLIC"),
}

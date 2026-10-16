"""No Sentinel process runs as a superuser once the separate logins exist.

The container entrypoint and manage.py, run for real against a database of
the test's own on the disposable cluster SENTINEL_TEST_POSTGRES names (see
test_db_roles_postgres.py, whose conditions apply), as the bootstrap
superuser that connection string logs in as. pg_dump and pg_restore, like
psql, must be on PATH; so must initdb and pg_ctl for the way back to one
superuser login, which starts a cluster of its own for it.
"""

import os
import random
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import psycopg
from django.db.backends.postgresql.client import DatabaseClient
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from apps.core.tests.test_db_roles_postgres import ROLES, SERVER, DisposableClusterTestCase
from sentinel import database, db_roles

ROOT = Path(__file__).resolve().parents[3]
STARTED = "the command started"
REFUSED = "the separate logins are provisioned"
PROVISIONING = "python -m sentinel.db_roles apply is provisioning the separate logins"
PAUSED = "sentinel-test: apply paused after its preflight"
# How the processes find the server and its password, besides POSTGRES_*.
LIBPQ = ("PGPASSWORD", "PGPASSFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY")
# A Django process that keeps its connection: it says whether the connection was
# admitted, then runs each line of its input as a statement and says how that went.
SESSION = """\
import sys
from django.db import connections
connection = connections["default"]
try:
    connection.ensure_connection()
    print("admitted", connection.connection.info.backend_pid, flush=True)
except Exception as exc:
    print("refused", " ".join(str(exc).split()), flush=True)
for statement in sys.stdin:
    try:
        with connection.cursor() as cursor:
            cursor.execute(statement)
        print("ran", flush=True)
    except Exception as exc:
        print("failed", type(exc).__name__, " ".join(str(exc).split()), flush=True)
"""
# What a superuser could do, and the separate logins cannot: DDL, DML on a table
# the runtime may not write as such, and role administration.
PROBES = (
    "CREATE TABLE sentinel_probe (id integer)",
    "INSERT INTO auth_group (name) VALUES ('sentinel probe')",
    f"ALTER ROLE {db_roles.RUNTIME_ROLE} SUPERUSER",
)


class ApplicationTestCase(DisposableClusterTestCase):
    """Sentinel's processes, run against the test's database."""

    def setUp(self):
        super().setUp()
        settings = conninfo_to_dict(SERVER) if SERVER else {}
        if not settings.get("user"):
            self.fail("SENTINEL_TEST_POSTGRES must name the superuser (user=...)")
        self.superuser = (str(settings["user"]), str(settings.get("password", os.environ.get("PGPASSWORD", ""))))
        self.server = (str(settings.get("host", "localhost")), str(settings.get("port", "5432")))

    def environment(self, settings):
        """The environment a container would give a process of the application."""
        environment = {
            **{name: os.environ[name] for name in LIBPQ if name in os.environ},
            "PATH": f"{Path(sys.executable).parent}:/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "DJANGO_SECRET_KEY": secrets.token_urlsafe(48),
            "AGENT_TOKEN_PEPPER": secrets.token_urlsafe(48),
            "POSTGRES_HOST": self.server[0],
            "POSTGRES_PORT": self.server[1],
            "POSTGRES_DB": self.database,
            "POSTGRES_USER": self.superuser[0],
            "POSTGRES_PASSWORD": self.superuser[1],
        }
        environment.update(settings)
        return {name: value for name, value in environment.items() if value is not None}

    def run_process(self, arguments, settings):
        return subprocess.run(arguments, cwd=ROOT, env=self.environment(settings), capture_output=True, text=True,
                              timeout=300, check=False)

    def entrypoint(self, *arguments, **settings):
        """The entrypoint, as a container runs it; the command it starts prints STARTED."""
        command = arguments or ("python", "-c", f"print({STARTED!r})")
        return self.run_process([shutil.which("dash") or "sh", "./entrypoint.sh", *command], settings)

    def manage(self, *arguments, **settings):
        """manage.py without the entrypoint, as `docker compose exec web` runs it."""
        return self.run_process([sys.executable, "manage.py", *arguments], settings)

    def web(self, *arguments, password=None, **settings):
        """The web service with the separate logins: its own password, and not the
        bootstrap superuser's (compose.yml)."""
        return self.entrypoint(*arguments, **{
            "SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "runtime", "POSTGRES_PASSWORD": None,
            "SENTINEL_DB_PASSWORD": self.passwords[0] if password is None else password, **settings,
        })

    def migrate_service(self, **settings):
        return self.entrypoint("apply-migrations", **{
            "SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": "migrate", "POSTGRES_PASSWORD": None,
            "SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1], **settings,
        })

    def tables(self):
        """How many tables public holds, and how many of them each role owns."""
        return self.execute(
            "SELECT relowner::regrole::text, count(*) FROM pg_catalog.pg_class"
            " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' GROUP BY 1 ORDER BY 1"
        )

    def marked(self):
        return self.value("SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = %s)", db_roles.RESTRICTED_SCHEMA)

    def passwords_are_checked(self):
        """Whether the cluster refuses a login with a wrong password (not with trust)."""
        return self.web(password=secrets.token_urlsafe(48)).returncode != 0

    def assertStarted(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(STARTED, result.stdout)

    def assertRefusedToTheSuperuser(self, result, *, by_the_entrypoint=False):
        # The secrets first: what follows prints the output when it fails.
        for secret in (*self.passwords, self.superuser[1]):
            if secret:
                self.assertFalse(secret in result.stdout + result.stderr, "a password is in the output")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn(REFUSED, result.stderr)
        if by_the_entrypoint:
            # The wait refuses: no migration ran, no traceback from Django's own check.
            self.assertIn(f"entrypoint: {REFUSED}", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertNotIn("Operations to perform", result.stdout)
        self.assertIn(f"{self.superuser[0]}, a superuser login, may not be used", result.stderr)

    def restricted_installation(self):
        """apply, then the migrate service: a new installation with separate logins."""
        self.assertSucceeds(self.apply)
        result = self.migrate_service()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([owner for owner, _ in self.tables()], ["sentinel_owner"])

    def legacy_installation(self):
        """An existing installation, migrated by its superuser login: the tables apply adopts."""
        if self.value("SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user") != 10:
            self.skipTest("adopting tables needs them to belong to the bootstrap superuser")
        self.assertStarted(self.entrypoint())
        return [name for (name,) in self.execute(
            "SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'")]

    def assertUnprovisioned(self):
        self.assertFalse(self.marked())
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)

    @staticmethod
    def counts(connection):
        """The rows of every table in schema public."""
        names = [name for (name,) in connection.execute(
            "SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace"
            " AND relkind IN ('r', 'p') ORDER BY 1")]
        return {name: connection.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(name))).fetchone()[0]
                for name in names}


class SuperuserFallbackTests(ApplicationTestCase):
    def test_a_fresh_legacy_installation_migrates_as_its_one_login_and_starts(self):
        self.assertStarted(self.entrypoint())
        self.assertEqual([owner for owner, _ in self.tables()], [self.superuser[0]])
        self.assertFalse(self.marked())
        self.assertStarted(self.entrypoint())  # and again: nothing records separate logins

    def test_a_fresh_restricted_installation_migrates_and_starts_with_its_logins(self):
        self.restricted_installation()
        self.assertTrue(self.marked())
        self.assertStarted(self.web())
        result = self.web("python", "manage.py", "migrate", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_restarted_with_the_legacy_settings_it_never_runs_as_the_superuser(self):
        self.restricted_installation()
        tables = self.tables()
        # The web service: the wait refuses before migrations and the command.
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)
        # The migrate service with the legacy settings connects to nothing.
        result = self.entrypoint("apply-migrations", SENTINEL_DB_ACCESS="migrate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nothing to do here", result.stderr)
        # manage.py without the entrypoint: every connection Django opens is checked.
        self.assertRefusedToTheSuperuser(self.manage("migrate", "--noinput"))
        self.assertRefusedToTheSuperuser(self.manage("shell", "-c", "from django.db import connection; connection.ensure_connection()"))
        # A superuser login that switches roles at once is still a superuser login.
        self.assertRefusedToTheSuperuser(self.entrypoint(PGOPTIONS=f"-c role={db_roles.OWNER_ROLE}"), by_the_entrypoint=True)
        self.assertRefusedToTheSuperuser(self.manage("migrate", "--noinput", PGOPTIONS=f"-c role={db_roles.OWNER_ROLE}"))
        self.assertEqual(self.tables(), tables)
        self.assertStarted(self.web())

    def test_missing_restricted_credentials_never_fall_back_to_the_superuser(self):
        self.restricted_installation()
        for password in ("", None):
            with self.subTest(password=password):
                result = self.entrypoint(SENTINEL_DB_ROLES="separate", SENTINEL_DB_PASSWORD=password, POSTGRES_PASSWORD=None)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn(STARTED, result.stdout)
                self.assertIn("Required environment variable SENTINEL_DB_PASSWORD is", result.stderr)
        result = self.entrypoint("apply-migrations", SENTINEL_DB_ROLES="separate", SENTINEL_DB_ACCESS="migrate",
                                 POSTGRES_PASSWORD=None)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Required environment variable SENTINEL_DB_MIGRATE_PASSWORD is not set", result.stderr)

    def test_incorrect_restricted_credentials_never_fall_back_to_the_superuser(self):
        self.restricted_installation()
        if not self.passwords_are_checked():
            self.skipTest("the cluster lets these logins in without checking their passwords")
        wrong = secrets.token_urlsafe(48)
        result = self.web(password=wrong)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn("password authentication failed", result.stderr)
        self.assertIn("check SENTINEL_DB_PASSWORD for sentinel_app; python -m sentinel.db_roles apply", result.stderr)
        self.assertNotIn(wrong, result.stdout + result.stderr)

    def test_recovery_sets_new_passwords_and_keeps_the_superuser_out(self):
        self.restricted_installation()
        lost = self.passwords
        self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))
        self.assertSucceeds(self.apply)
        self.assertStarted(self.web())
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)
        if self.passwords_are_checked():
            self.assertNotIn(STARTED, self.web(password=lost[0]).stdout)

    def test_interrupted_provisioning_of_an_existing_installation_changes_nothing(self):
        if self.value("SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user") != 10:
            self.skipTest("adopting tables needs them to belong to the bootstrap superuser")
        self.assertStarted(self.entrypoint())  # an existing installation, migrated by the superuser
        tables = self.tables()
        names = [name for (name,) in self.execute(
            "SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'")]
        program = db_roles.apply_program(self.database, *self.passwords, names)
        # The stream stops after the grants: no schema, no final check, no COMMIT.
        lines = program.sql.splitlines(keepends=True)
        cut = lines.index("$sentinel_grants$;\n") + 1
        status, stderr, finished, _ = self.run_program(db_roles.Program("".join(lines[:cut]), program.nonce))
        self.assertEqual((status, finished), (0, False), stderr)  # psql reports success: only the nonce tells
        self.assertEqual(self.tables(), tables)
        self.assertFalse(self.marked())
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)
        self.assertStarted(self.entrypoint())  # provisioning never happened
        self.assertNotIn(STARTED, self.web().stdout)  # and the separate logins do not exist
        # Run again, in full.
        self.assertSucceeds(lambda: self.apply(*names))
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_the_roles_alone_still_refuse_the_superuser(self):
        # Dropping the schema by hand (not a supported recovery) leaves the cluster's roles.
        self.restricted_installation()
        self.execute("DROP SCHEMA sentinel_restricted")
        result = self.entrypoint()
        self.assertRefusedToTheSuperuser(result, by_the_entrypoint=True)
        self.assertIn("the cluster has the roles sentinel_app, sentinel_migrate, sentinel_owner", result.stderr)

    def test_the_schema_alone_refuses_the_superuser_before_any_migration(self):
        self.assertSucceeds(self.apply)
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)
        self.assertEqual(self.tables(), [])  # the superuser created nothing
        self.assertStarted(self.web())  # the logins do not need the tables to start

    def test_another_database_of_the_cluster_is_refused_too(self):
        # The roles are the cluster's: a legacy environment pointed at postgres, the other
        # database a cluster of Sentinel's own has, is no way around.
        self.restricted_installation()
        provisioned, self.database = self.database, "postgres"
        try:
            result = self.entrypoint()
            self.assertRefusedToTheSuperuser(result, by_the_entrypoint=True)
            self.assertIn("the cluster has the roles", result.stderr)
            self.assertEqual(self.tables(), [])
        finally:
            self.database = provisioned

    def test_dbshell_starts_no_psql_whatever_it_is_told_to_connect_to(self):
        # With the separate settings Django's own connection would be admitted; psql would then
        # connect as whoever its arguments or a \connect name. Django gives psql the runtime login's
        # password in PGPASSWORD; a service file's outranks it (libpq), and keeps the superuser's off
        # any command line. (A service file cannot name the login: Django's -U outranks it.)
        self.restricted_installation()
        superuser = make_conninfo(host=self.server[0], port=self.server[1], dbname=self.database, user=self.superuser[0],
                                  service="superuser")
        with tempfile.TemporaryDirectory() as directory:
            services, unknown = Path(directory) / "services", Path(directory) / "no-password"
            services.touch(mode=0o600)
            services.write_text(f"[superuser]\npassword={self.superuser[1]}\n")
            unknown.write_text("[superuser]\n")
            script = Path(directory) / "reconnect.sql"
            settings = {"PATH": os.environ["PATH"], "SENTINEL_DB_ROLES": "separate",
                        "SENTINEL_DB_PASSWORD": self.passwords[0], "POSTGRES_PASSWORD": None, "PGSERVICEFILE": str(services)}
            for name, arguments, statement in (
                ("connection string", ("--dbname", superuser), ("-c", "{}")),
                ("reconnect", (), ("-f", str(script))),
            ):
                with self.subTest(name):
                    # What dbshell would start: Django's arguments, manage.py's environment and Django's.
                    script.write_text(f"\\connect '{superuser}'\nSELECT session_user;\n")
                    command, environment = DatabaseClient.settings_to_cmd_args_env(
                        {"NAME": self.database, "USER": db_roles.RUNTIME_ROLE, "PASSWORD": self.passwords[0],
                         "HOST": self.server[0], "PORT": self.server[1], "OPTIONS": {}},
                        ["-X", "-q", "-At", "-w", *arguments, *(part.format("SELECT session_user") for part in statement)])
                    for secret in (*self.passwords, self.superuser[1]):
                        if secret:
                            self.assertFalse(secret in " ".join(command), "a password is on a command line")
                    # Without the service file's password, it would have the runtime login's: refused.
                    control = subprocess.run(command, env={**self.environment({**settings, "PGSERVICEFILE": str(unknown)}),
                                                           **environment},
                                             capture_output=True, text=True, timeout=60, check=False)
                    if control.stdout.strip() == self.superuser[0]:
                        self.skipTest("the cluster lets the superuser in without checking its password")
                    self.assertIn("password authentication failed", control.stderr)
                    # With it, the superuser.
                    psql = subprocess.run(command, env={**self.environment(settings), **environment},
                                          capture_output=True, text=True, timeout=60, check=False)
                    self.assertEqual((psql.returncode, psql.stdout.strip()), (0, self.superuser[0]), psql.stderr)
                    # dbshell starts none.
                    created = f"CREATE TABLE sentinel_dbshell_{name.replace(' ', '_')} (id integer)"
                    script.write_text(f"\\connect '{superuser}'\n{created};\n")
                    arguments = (*arguments, *(part.format(created) for part in statement))
                    result = self.manage("dbshell", "--", *arguments, **settings)
                    for secret in (*self.passwords, self.superuser[1]):
                        if secret:
                            self.assertFalse(secret in " ".join(arguments), "a password is on a command line")
                            self.assertFalse(secret in result.stdout + result.stderr, "a password is in the output")
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("dbshell is disabled", result.stderr)
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_class WHERE relname LIKE 'sentinel_dbshell_%'"), 0)

    def test_apply_refuses_while_a_superuser_session_uses_the_database(self):
        # A superuser session that took no lock (psql by hand) would outlive the commit unchecked.
        self.assertStarted(self.entrypoint())
        names = [name for (name,) in self.execute(
            "SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'")]
        with self.connect(self.database) as session:
            session.execute("SELECT 1")
            pid = session.info.backend_pid
            status, stderr, finished, block = self.apply(*names)
            self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
            self.assertIn(f"other superuser sessions use this database: {self.superuser[0]} (pid {pid})", stderr)
        self.assertSucceeds(lambda: self.apply(*names))

    def replacement_cluster(self):
        """A new cluster of the same PostgreSQL, with the test's database, on a socket of its
        own (host, port); stopped and deleted at the end."""
        if not (shutil.which("initdb") and shutil.which("pg_ctl")):
            self.skipTest("initdb and pg_ctl are not installed")
        directory = tempfile.mkdtemp(prefix="sentinel-")
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        data, port = Path(directory) / "data", str(random.randint(20000, 29999))
        # A locale the server can use whatever the host's (macOS refuses to start without one).
        environment = {**os.environ, "LC_ALL": "C"}
        subprocess.run(["initdb", "-D", str(data), "-U", self.superuser[0], "--auth=trust", "--no-locale",
                        "--encoding=UTF8", "--no-sync"], check=True, capture_output=True, env=environment)
        # Registered first: a start that times out may still leave a server running.
        self.addCleanup(subprocess.run, ["pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop"],
                        capture_output=True, check=False)
        started = subprocess.run(["pg_ctl", "-D", str(data), "-l", str(Path(directory) / "log"), "-w", "-o",
                                  f"-p {port} -c listen_addresses= -c unix_socket_directories={directory}", "start"],
                                 capture_output=True, env=environment, check=False)
        if started.returncode:
            self.fail("the new cluster did not start: " + (Path(directory) / "log").read_text())
        with psycopg.connect(host=directory, port=port, user=self.superuser[0], dbname="postgres", autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(self.database)))
        return directory, port

    def test_going_back_to_one_superuser_login_in_a_new_cluster_as_documented(self):
        # sentinel/database.py: the data only, into a new cluster that the superuser
        # migrated itself, checked before use, while the old one stays as it was.
        if not (shutil.which("pg_dump") and shutil.which("pg_restore")):
            self.skipTest("pg_dump and pg_restore are not installed")
        self.restricted_installation()
        with self.connect(self.database) as connection:
            connection.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(db_roles.OWNER_ROLE)))
            connection.execute("INSERT INTO auth_group (name) VALUES ('survives the way back')")
            before = self.counts(connection)
        self.assertIn("auth_group", before)
        client = ["-h", self.server[0], "-p", self.server[1], "-U", self.superuser[0], "-d", self.database]
        environment = {**os.environ, "PGPASSWORD": self.superuser[1]} if self.superuser[1] else dict(os.environ)
        with tempfile.TemporaryDirectory() as directory:
            full, data = Path(directory) / "full.dump", Path(directory) / "data.dump"
            # 1. The way back, and the data.
            subprocess.run(["pg_dump", *client, "--format=custom", "-f", str(full)], env=environment, check=True)
            subprocess.run(["pg_restore", "--list", str(full)], check=True, capture_output=True)
            subprocess.run(["pg_dump", *client, "--format=custom", "--data-only",
                            "--exclude-table-data=django_migrations", "-f", str(data)], env=environment, check=True)
            # 2. A new cluster, which has never had the roles.
            host, port = self.replacement_cluster()
            replacement = {"POSTGRES_HOST": host, "POSTGRES_PORT": port, "POSTGRES_PASSWORD": ""}
            # 3. Migrated by the superuser login, emptied, and the data restored.
            self.assertStarted(self.entrypoint(**replacement))
            with psycopg.connect(host=host, port=port, user=self.superuser[0], dbname=self.database, autocommit=True) as connection:
                tables = connection.execute(
                    "SELECT pg_catalog.string_agg(oid::regclass::text, ', ') FROM pg_catalog.pg_class"
                    " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'django_migrations'"
                ).fetchone()[0]
                connection.execute(f"TRUNCATE {tables} RESTART IDENTITY CASCADE")
                subprocess.run(["pg_restore", "-h", host, "-p", port, "-U", self.superuser[0], "-d", self.database,
                                "--data-only", "--disable-triggers", "--single-transaction", "--exit-on-error", str(data)],
                               check=True)
                # 4. Checked before anything else runs.
                self.assertEqual(self.counts(connection), before)
                self.assertIsNone(connection.execute(
                    "SELECT FROM pg_catalog.pg_namespace WHERE nspname = %s", [db_roles.RESTRICTED_SCHEMA]).fetchone())
                self.assertEqual(connection.execute(
                    "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", [list(ROLES)]).fetchone()[0], 0)
                self.assertEqual(
                    [owner for (owner,) in connection.execute(
                        "SELECT DISTINCT relowner::regrole::text FROM pg_catalog.pg_class"
                        " WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'")],
                    [self.superuser[0]])
            result = self.manage("migrate", "--check", **replacement)
            self.assertEqual(result.returncode, 0, result.stderr)
            # 5. Started with the superuser login.
            self.assertStarted(self.entrypoint(**replacement))
        # The old cluster is still the way back, as it was.
        with self.connect(self.database) as connection:
            self.assertEqual(self.counts(connection), before)
        self.assertTrue(self.marked())
        self.assertStarted(self.web())
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)

    def test_a_restored_dump_keeps_the_superuser_out_without_the_roles(self):
        # The schema travels with a dump, to a cluster that never had the roles.
        if not (shutil.which("pg_dump") and shutil.which("pg_restore")):
            self.skipTest("pg_dump and pg_restore are not installed")
        self.restricted_installation()
        client = ["-h", self.server[0], "-p", self.server[1], "-U", self.superuser[0]]
        environment = {**os.environ, "PGPASSWORD": self.superuser[1]} if self.superuser[1] else dict(os.environ)
        with tempfile.TemporaryDirectory() as directory:
            dump = Path(directory) / "sentinel.dump"
            subprocess.run(["pg_dump", *client, "-d", self.database, "--format=custom", "-f", str(dump)], env=environment, check=True)
            with self.connect() as connection:
                connection.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(self.database)))
                connection.execute(sql.SQL("DROP ROLE {}, {}, {}").format(*(sql.Identifier(role) for role in ROLES)))
            self.database = self.create_database(self.database, application=True)
            subprocess.run(["pg_restore", *client, "-d", self.database, "--no-owner", "--no-privileges", str(dump)],
                           env=environment, check=True)
        self.assertTrue(self.marked())
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)
        result = self.entrypoint()
        self.assertRefusedToTheSuperuser(result, by_the_entrypoint=True)
        self.assertIn("schema sentinel_restricted exists in this database", result.stderr)


class ProvisioningRaceTests(ApplicationTestCase):
    """No superuser connection of Sentinel stays open across apply (sentinel/database.py)."""

    def session(self, **settings):
        """A Django process with the legacy settings that opens its connection now, and
        what it said about it."""
        process = subprocess.Popen(
            [sys.executable, "manage.py", "shell", "--verbosity", "0", "-c", SESSION], cwd=ROOT, env=self.environment(settings),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        self.addCleanup(self.close, process)
        return process, process.stdout.readline().strip()

    @staticmethod
    def statement(process, statement):
        process.stdin.write(statement + "\n")
        process.stdin.flush()
        return process.stdout.readline().strip()

    @staticmethod
    def close(process):
        if process.poll() is None:
            process.stdin.close()
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for stream in (process.stdin, process.stdout):
            stream.close()

    def backend_ended(self, pid):
        """Wait until PostgreSQL has noticed that the client of ``pid`` is gone."""
        for _ in range(300):
            if not self.value("SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid = %s", pid):
                return
            time.sleep(0.1)
        self.fail(f"backend {pid} did not end")

    def paused_apply(self, *tables):
        """psql running apply, stopped after the preflight: before the roles, the ownership,
        the grants and the schema. Returns psql and what finishes the program."""
        program = db_roles.apply_program(self.database, *self.passwords, tables)
        lines = program.sql.splitlines(keepends=True)
        cut = lines.index("$sentinel_preflight$;\n") + 1
        command, environment = self.psql()
        process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and (process.kill(), process.communicate()))
        process.stdin.write("".join(lines[:cut]) + f"\\warn {PAUSED}\n")
        process.stdin.flush()
        said = []
        while line := process.stderr.readline():
            said.append(line)
            if line.strip() == PAUSED:
                break
        else:
            self.fail("apply stopped before the pause: " + "".join(said))

        def finish():
            stdout, stderr = process.communicate("".join(lines[cut:]), timeout=120)
            return self.outcome(program, process.returncode, stdout, "".join(said) + stderr)

        return process, finish

    def apply_backend(self):
        """The pid of the session that holds the lock exclusively."""
        return self.value(
            "SELECT pid FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock'"
            " AND classid = %s AND objid = %s AND objsubid = 1",
            database.PROVISIONING_LOCK >> 32, database.PROVISIONING_LOCK & 0xFFFFFFFF,
        )

    def assertProbesHadNoEffect(self):
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_class WHERE relname = 'sentinel_probe'"), 0)
        self.assertEqual(self.value("SELECT count(*) FROM auth_group WHERE name = 'sentinel probe'"), 0)
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolsuper AND rolname = ANY (%s)", list(ROLES)), 0)

    def assertAdmitted(self, admission):
        self.assertRegex(admission, r"^admitted \d+$")
        return int(admission.split()[1])

    def assertRefusedWhileProvisioning(self, admission):
        self.assertTrue(admission.startswith("refused "), admission)
        self.assertIn(PROVISIONING, admission)

    def assertRefusedAfterProvisioning(self, admission):
        self.assertTrue(admission.startswith("refused "), admission)
        self.assertIn(REFUSED, admission)

    def test_a_connection_opened_while_apply_runs_never_gets_superuser_authority(self):
        # Apply past its preflight, a Django connection with the bootstrap login, apply
        # commits, and the connection is used again.
        names = self.legacy_installation()
        _, finish = self.paused_apply(*names)
        session, admission = self.session()
        waited = self.entrypoint()  # the web service, starting meanwhile
        status, stderr, finished, _ = finish()
        probes = [self.statement(session, probe) for probe in PROBES]
        self.assertEqual((status, finished), (0, True), stderr)
        self.assertRefusedWhileProvisioning(admission)
        self.assertNotEqual(waited.returncode, 0)
        self.assertNotIn(STARTED, waited.stdout)
        self.assertIn(f"entrypoint: {PROVISIONING}", waited.stderr)
        for probe, outcome in zip(PROBES, probes):
            with self.subTest(probe):
                self.assertTrue(outcome.startswith("failed SuperuserRefused "), outcome)
                self.assertIn(REFUSED, outcome)
        self.assertProbesHadNoEffect()
        self.assertTrue(self.marked())
        self.assertRefusedToTheSuperuser(self.entrypoint(), by_the_entrypoint=True)
        self.assertEqual(self.migrate_service().returncode, 0)
        self.assertStarted(self.web())

    def test_a_superuser_connection_already_open_keeps_apply_from_committing(self):
        names = self.legacy_installation()
        session, admission = self.session()
        pid = self.assertAdmitted(admission)
        status, stderr, finished, block = self.apply(*names)
        self.assertEqual((status, finished, block), (3, False, "sentinel_lock"), stderr)
        self.assertIn(f"{self.superuser[0]} (pid {pid}, database {self.database}, a Sentinel superuser login)", stderr)
        self.assertUnprovisioned()
        # Nothing changed under the connection: the installation is still a legacy one.
        self.assertEqual(self.statement(session, "SELECT 1"), "ran")
        self.close(session)
        self.backend_ended(pid)
        self.assertSucceeds(lambda: self.apply(*names))
        self.assertRefusedAfterProvisioning(self.session()[1])

    def test_every_superuser_connection_of_the_cluster_counts_and_a_killed_one_lets_go(self):
        names = self.legacy_installation()
        other = "postgres"  # the other database of a cluster of Sentinel's own
        sessions = [self.session(), self.session(), self.session(POSTGRES_DB=other)]
        pids = [self.assertAdmitted(admission) for _, admission in sessions]

        status, stderr, finished, block = self.apply(*names)
        self.assertEqual((status, finished, block), (3, False, "sentinel_lock"), stderr)
        for pid in pids:
            self.assertIn(f"(pid {pid}, database ", stderr)
        self.assertIn(f"(pid {pids[2]}, database {other}, a Sentinel superuser login)", stderr)

        # A process that dies without closing its connection: PostgreSQL ends the session.
        sessions[0][0].kill()
        sessions[0][0].wait()
        self.backend_ended(pids[0])
        status, stderr, finished, block = self.apply(*names)
        self.assertEqual((status, finished, block), (3, False, "sentinel_lock"), stderr)
        self.assertNotIn(f"(pid {pids[0]},", stderr)
        self.assertIn(f"(pid {pids[1]},", stderr)

        # The last one is in another database, where its lock is: still refused.
        self.close(sessions[1][0])
        self.backend_ended(pids[1])
        status, stderr, finished, block = self.apply(*names)
        self.assertEqual((status, finished, block), (3, False, "sentinel_lock"), stderr)
        self.assertIn(f"(pid {pids[2]}, database {other},", stderr)
        self.assertUnprovisioned()

        self.close(sessions[2][0])
        self.backend_ended(pids[2])
        self.assertSucceeds(lambda: self.apply(*names))
        self.assertRefusedAfterProvisioning(self.session()[1])
        self.assertRefusedAfterProvisioning(self.session(POSTGRES_DB=other)[1])

    def test_an_apply_killed_while_it_runs_leaves_no_lock_and_runs_again(self):
        names = self.legacy_installation()
        other = "postgres"  # the other database of a cluster of Sentinel's own
        process, _ = self.paused_apply(*names)
        backend = self.apply_backend()
        # Another database of the cluster cannot see the lock as a conflict: it reads it.
        self.assertRefusedWhileProvisioning(self.session(POSTGRES_DB=other)[1])
        self.assertRefusedWhileProvisioning(self.session()[1])

        process.kill()
        process.communicate()
        self.backend_ended(backend)
        self.assertUnprovisioned()
        session, admission = self.session()  # nothing was provisioned: the legacy login works
        pid = self.assertAdmitted(admission)
        self.close(session)
        self.backend_ended(pid)

        self.assertSucceeds(lambda: self.apply(*names))
        self.assertRefusedAfterProvisioning(self.session()[1])

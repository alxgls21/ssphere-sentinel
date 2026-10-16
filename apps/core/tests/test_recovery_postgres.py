"""The recovery of the data of an existing installation into a new, least-privilege cluster
(sentinel/recovery.py), against real PostgreSQL: a legacy cluster of its own that holds the
installation (Sentinel migrated by its superuser login, with data), and the cluster of the test
(SENTINEL_TEST_POSTGRES, see test_db_roles_postgres.py), provisioned as every installation is.

Every test checks that the old database is untouched: its data, its sequences, its schema and
its privileges as they were, and no row in it inserted, updated or deleted.
"""

import dataclasses
import hashlib
import json
import os
import random
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from apps.core.tests.test_database_guard_postgres import ROOT, STARTED, ApplicationTestCase
from apps.core.tests.test_db_roles_postgres import ROLES, SERVER
from sentinel import db_roles, recovery

DATABASE_TEMPLATE = "sentinel_recovery_template"
SEED = ROOT / ".github" / "scripts" / "rehearsal_data.py"
LIBPQ_SETTINGS = ("PGPASSWORD", "PGPASSFILE", "PGOPTIONS", "PGUSER", "PGDATABASE", "PGHOST", "PGPORT", "PGSERVICE")
INTEGER_MAXIMUM = 2147483647


class LegacyCluster:
    """A cluster of its own that holds an installation as it was before the separate logins: the one superuser
    login, no roles, Sentinel migrated by it. One for all the tests of a class; each test has a database made
    from a template that was migrated and given data once."""

    def __init__(self, superuser):
        self.superuser = superuser
        self.directory = tempfile.mkdtemp(prefix="sentinel-legacy-")
        # Only the socket's name: nothing listens on TCP.
        self.port = str(random.randint(30000, 39999))
        self.data = Path(self.directory) / "data"
        self.environment = {**os.environ, "LC_ALL": "C"}

    def start(self):
        data, environment = self.data, self.environment
        subprocess.run(["initdb", "-D", str(data), "-U", self.superuser, "--auth=trust", "--no-locale", "--encoding=UTF8",
                        "--no-sync"], check=True, capture_output=True, env=environment)
        started = subprocess.run(
            ["pg_ctl", "-D", str(data), "-l", str(Path(self.directory) / "log"), "-w", "-o",
             f"-p {self.port} -c listen_addresses= -c unix_socket_directories={self.directory}", "start"],
            capture_output=True, env=environment, check=False)
        if started.returncode:
            raise AssertionError("the legacy cluster did not start: " + (Path(self.directory) / "log").read_text())

    def stop(self):
        subprocess.run(["pg_ctl", "-D", str(self.data), "-m", "immediate", "-w", "stop"], capture_output=True, check=False)
        shutil.rmtree(self.directory, ignore_errors=True)

    def connect(self, database="postgres"):
        return psycopg.connect(host=self.directory, port=self.port, user=self.superuser, dbname=database, autocommit=True)

    def settings(self, database):
        """What the application is given to reach it (POSTGRES_*)."""
        return {"POSTGRES_HOST": self.directory, "POSTGRES_PORT": self.port, "POSTGRES_DB": database,
                "POSTGRES_USER": self.superuser, "POSTGRES_PASSWORD": ""}

    def libpq(self, database):
        """What PostgreSQL's programs are given to reach it."""
        return {"PGHOST": self.directory, "PGPORT": self.port, "PGUSER": self.superuser, "PGDATABASE": database}

    def endpoint(self, database):
        return recovery.Endpoint(read_only=True, environment=self.libpq(database))


class RecoveryTestCase(ApplicationTestCase):
    """The test's own database as the destination, the legacy cluster's as the old installation."""

    legacy = None
    template_ready = False

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for program in ("initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"):
            if not shutil.which(program):
                raise AssertionError(f"{program} is not installed")
        cls.legacy = LegacyCluster(str(conninfo_to_dict(SERVER)["user"]))
        cls.addClassCleanup(cls.legacy.stop)
        cls.legacy.start()
        cls.template_ready = False

    # --- the old installation

    def prepare_template(self):
        """The database every test's old installation is made from: migrated by the superuser login, with data."""
        if type(self).template_ready:
            return
        legacy = self.legacy
        with legacy.connect() as connection:
            connection.execute(f'CREATE DATABASE "{DATABASE_TEMPLATE}"')
        settings = legacy.settings(DATABASE_TEMPLATE)
        self.assertStarted(self.entrypoint(**settings))
        seeded = self.manage("shell", "--no-imports", "-v", "0", "-c", SEED.read_text(), REHEARSAL_ACTION="seed", **settings)
        self.assertEqual(seeded.returncode, 0, seeded.stderr)
        self.legacy_sql(DATABASE_TEMPLATE, OPERATOR_DATA)
        type(self).template_ready = True

    def copy_of_template(self, *statements):
        """A database of the legacy cluster of its own, a copy of the template, with ``statements`` run in one
        session (a superuser's, which may do what the application's logins may not). Returns its name."""
        self.prepare_template()
        name = f"sentinel_old_{random.randint(0, 10 ** 8)}"
        with self.legacy.connect() as connection:
            connection.execute(f'CREATE DATABASE "{name}" TEMPLATE "{DATABASE_TEMPLATE}"')
        if statements:
            self.legacy_sql(name, *statements)
        return name

    def old_installation(self):
        """The old installation of the test: a copy of the template. Returns its name."""
        self.old = self.copy_of_template()
        return self.old

    def legacy_sql(self, database, *statements):
        with self.legacy.connect(database) as connection:
            for statement in statements:
                connection.execute(statement)

    def old_sql(self, *statements):
        self.legacy_sql(self.old, *statements)

    def old_value(self, statement):
        with self.legacy.connect(self.old) as connection:
            return connection.execute(statement).fetchone()[0]

    def source(self):
        return self.legacy.endpoint(self.old)

    def dump_of(self, database, *arguments):
        """A data-only dump, as export takes it, of a database of the legacy cluster; ``arguments`` change it."""
        path = self.directory() / "forged.dump"
        subprocess.run(
            ["pg_dump", "--format=custom", f"--file={path}", "--schema=public", "--exclude-table=django_migrations",
             "--exclude-table=django_migrations_id_seq", *(arguments or ("--data-only",))],
            capture_output=True, check=True, env={**os.environ, **self.legacy.libpq(database)})
        return path

    # --- the new installation

    def destination(self):
        """The two endpoints to the destination, the cluster of the test: the runtime login, and the migration login as
        the owner role; each one's password in the environment."""
        host, port = self.server
        settings = {"PGHOST": host, "PGPORT": port, "PGDATABASE": self.database, "LC_MESSAGES": "C"}
        runtime = recovery.Endpoint(user=db_roles.RUNTIME_ROLE, environment={**settings, "PGPASSWORD": self.passwords[0]})
        owner = recovery.Endpoint(user=db_roles.MIGRATION_ROLE, role=db_roles.OWNER_ROLE,
                                  environment={**settings, "PGPASSWORD": self.passwords[1]})
        return runtime, owner

    def new_installation(self):
        """The destination: provisioned by apply, migrated by the migrate service, the application never started."""
        self.restricted_installation()
        return self.destination()

    def rebuild_destination(self):
        """Throw the destination away and make a new one, as docs/server-deployment.md says: a database and roles that
        are not the ones of the attempt that was rejected."""
        with self.connect() as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{self.database}" WITH (FORCE)')
            for name in ROLES:
                connection.execute(f'DROP ROLE IF EXISTS "{name}"')
        self.database = self.create_database(f"sentinel-roles-{random.randint(0, 10 ** 8)}", application=True)
        self.passwords = tuple(password + "x" for password in self.passwords)
        return self.new_installation()

    @staticmethod
    def reader(destination):
        return dataclasses.replace(destination[1], read_only=True)

    def destination_state(self, destination):
        return recovery.read_manifest(self.reader(destination))

    def rows(self, destination):
        """The rows of each table of the destination that has any."""
        manifest = self.destination_state(destination)
        return {name: info["rows"] for name, info in manifest["tables"].items() if info["rows"]}

    # --- what must not change

    def old_state(self):
        """Everything that shows in the old database whether it was changed: its data, sequences and constraints (the
        manifest), its schema, who owns what and may do what, and the rows inserted, updated and deleted since the
        cluster began."""
        manifest = recovery.read_manifest(self.source())
        schema = subprocess.run(
            ["pg_dump", "--schema-only", "--no-comments"], capture_output=True, check=True,
            env={**os.environ, **self.legacy.libpq(self.old)}).stdout
        # What pg_dump says of the rows and of the sequences, which the tool's manifest does not feed.
        rows = subprocess.run(
            ["pg_dump", "--data-only", "--no-comments"], capture_output=True, check=True,
            env={**os.environ, **self.legacy.libpq(self.old)}).stdout
        with self.legacy.connect(self.old) as connection:
            privileges = connection.execute(
                "SELECT md5(string_agg(format('%s %s %s', oid::regclass, relowner::regrole, relacl), ',' ORDER BY oid::regclass::text))"
                " FROM pg_class WHERE relnamespace = 'public'::regnamespace").fetchone()[0]
            cluster = connection.execute(ORACLE).fetchone()[0]
            modified = connection.execute(
                "SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_stat_user_tables").fetchone()[0]
        return {"manifest": manifest, "schema": hashlib.sha256(without_restrict(schema)).hexdigest(), "privileges": privileges,
                "rows": hashlib.sha256(without_restrict(rows)).hexdigest(), "cluster": cluster, "modified": int(modified)}

    def assertOldUntouched(self, before):
        self.assertEqual(self.old_state(), before, "the old database changed")

    # --- the files

    def directory(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Path(directory.name)

    def export(self):
        bundle = self.directory() / "bundle"
        recovery.export_bundle(self.source(), bundle, log=lambda message: None)
        return bundle

    def attempt(self, destination, bundle):
        work = self.directory() / "work"
        recovery.import_bundle(*destination, bundle, work, log=lambda message: None)
        return work

    def state(self, work):
        return json.loads((work / recovery.STATE).read_text())

    def assertRejected(self, destination, bundle, check):
        """The import stops at ``check`` (or at one of them, if several are named), the work says so, and neither
        names a password. Returns the error and the work directory."""
        work = self.directory() / "work"
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.import_bundle(*destination, bundle, work, log=lambda message: None)
        error = caught.exception
        self.assertIn(error.check, (check,) if isinstance(check, str) else check, str(error))
        record = self.state(work)
        self.assertEqual((record["state"], record["failed"]["check"]), ("rejected", error.check))
        for secret in self.passwords:
            self.assertNotIn(secret, str(error) + json.dumps(record))
        return error, work

    def assertRefusedToStart(self, result):
        """web or migrate, started the normal way, refuse a database whose recovery has not been admitted."""
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(STARTED, result.stdout)
        self.assertIn("recovery into this database has not been admitted", result.stderr)

    def source_unchanged(self, bundle, work):
        """The old database found unchanged since the export, recorded in ``work`` as ``verify-source --work`` does."""
        recovery.verify_source(self.source(), bundle, log=lambda message: None, work=work)

    def activate(self, destination, bundle, work, start=None):
        """Verified, the old installation found unchanged: activated. Returns what ``start`` was asked."""
        started = []
        self.source_unchanged(bundle, work)
        recovery.activate(*destination, work, start or (lambda: started.append("start")), log=lambda message: None)
        return started

    def assertNotActivated(self, destination, work):
        """A destination that was rejected is not started, whatever is asked."""
        started = []
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.assertEqual((caught.exception.check, started), ("activate", []))

    def forge(self, bundle, *, dump=None, truncate=None, change=None):
        """Alter a bundle as someone who had it could: another dump (and its SHA-256, so that the bundle is
        consistent), a part of it only, or the record of the old database."""
        data = json.loads((bundle / recovery.BUNDLE).read_text())
        if dump is not None:
            shutil.copyfile(dump, bundle / recovery.DUMP)
        if truncate is not None:
            content = (bundle / recovery.DUMP).read_bytes()
            (bundle / recovery.DUMP).write_bytes(content[:truncate])
        if dump is not None or truncate is not None:
            data["dump"]["sha256"] = recovery.sha256(bundle / recovery.DUMP)
        if change is not None:
            change(data)
        (bundle / recovery.BUNDLE).write_text(json.dumps(data))
        return bundle

    # --- processes that keep their own pace

    def wait_until(self, condition, what, seconds=60):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.2)
        self.fail(f"timed out waiting for {what}")

    def passfile(self):
        """The passwords of the two logins in a libpq password file: the way to give two logins' passwords to a
        program that is run once, never on a command line."""
        path = self.directory() / "passfile"
        path.write_text("".join(f"*:*:*:{user}:{password}\n"
                                for user, password in zip((db_roles.RUNTIME_ROLE, db_roles.MIGRATION_ROLE), self.passwords,
                                                          strict=True)))
        path.chmod(0o600)
        return path

    @staticmethod
    def cli_environment(**settings):
        environment = {name: value for name, value in os.environ.items() if name not in LIBPQ_SETTINGS}
        environment.update(settings)
        return environment

    def destination_environment(self):
        host, port = self.server
        return self.cli_environment(PGHOST=host, PGPORT=port, PGDATABASE=self.database, PGPASSFILE=str(self.passfile()))

    @staticmethod
    def command(arguments, environment):
        return subprocess.run([sys.executable, "-m", "sentinel.recovery", *arguments], cwd=ROOT, env=environment,
                              capture_output=True, text=True, timeout=300, check=False)

    def app_sessions(self):
        return self.value("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = %s",
                          db_roles.RUNTIME_ROLE)


# Who exists and what they may, which databases and schemas hold, and the extensions: all of it as the catalogs say it.
ORACLE = """
SELECT md5(string_agg(item, E'\\n' ORDER BY item)) FROM (
  SELECT format('role %s %s %s %s %s %s %s %s', rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                rolreplication, rolbypassrls) AS item FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL SELECT format('member %s %s %s', roleid::regrole, member::regrole, admin_option) FROM pg_auth_members
  UNION ALL SELECT format('database %s %s %s', datname, datdba::regrole, datacl) FROM pg_database
    WHERE datname = current_database()
  UNION ALL SELECT format('schema %s %s %s', nspname, nspowner::regrole, nspacl) FROM pg_namespace WHERE nspname !~ '^pg_'
  UNION ALL SELECT format('extension %s %s', extname, extversion) FROM pg_extension
) items
"""


def without_restrict(dump: bytes) -> bytes:
    """A dump of PostgreSQL's recent minor releases opens and closes with a ``\\restrict`` line that has a key chosen at
    random for each run: it says nothing of the schema."""
    return b"\n".join(line for line in dump.split(b"\n") if not line.startswith((b"\\restrict ", b"\\unrestrict ")))


def documented_checks():
    """The checks docs/server-deployment.md lists for ``import``, in its order."""
    text = (ROOT / "docs" / "server-deployment.md").read_text()
    table = text[text.index("| Check | Fails when |"):]
    table = table[:table.index("\n\n")]
    return [name for row in re.findall(r"^\| ((?:`[a-z.]+`(?:, )?)+) \|", table, re.MULTILINE)
            for name in re.findall(r"`([a-z.]+)`", row)]


# What an operator of the old installation did that a new installation does not have: a group of their own with a
# permission, a user in it, and a session.
OPERATOR_DATA = """
INSERT INTO auth_group (name) VALUES ('Operators');
INSERT INTO auth_group_permissions (group_id, permission_id)
    SELECT g.id, p.id FROM auth_group g, auth_permission p WHERE g.name = 'Operators' AND p.codename = 'view_server';
INSERT INTO auth_user_groups (user_id, group_id) SELECT u.id, g.id FROM auth_user u, auth_group g WHERE g.name = 'Operators';
INSERT INTO django_session (session_key, session_data, expire_date) VALUES ('0123456789abcdef', 'e30:1a', now() + interval '1 day');
"""


class RecoveryTests(RecoveryTestCase):
    def test_the_data_of_an_old_installation_arrives_exactly_and_the_old_one_is_untouched(self):
        destination = self.new_installation()
        self.old_installation()
        before = self.old_state()
        self.assertGreater(sum(item["rows"] for item in before["manifest"]["tables"].values()), 20)

        bundle = self.export()
        self.assertEqual(stat.S_IMODE((bundle / recovery.DUMP).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o700)
        work = self.attempt(destination, bundle)

        record = self.state(work)
        self.assertEqual(record["state"], "verified")
        self.assertEqual(record["checks"], documented_checks())
        # The new database holds what the old one did, table by table.
        reader = self.reader(destination)
        after = recovery.read_manifest(reader)
        recovery.check_data(before["manifest"], after)
        recovery.check_sequences_match(before["manifest"], after)
        self.assertEqual(recovery.soundness(reader, after), [])
        # Nothing about the old installation changed.
        self.assertOldUntouched(before)
        # Verified is not admitted: web and migrate refuse it, and the runtime login cannot change the record.
        self.assertRefusedToStart(self.web())
        self.assertRefusedToStart(self.migrate_service())
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.RUNTIME_ROLE, password=self.passwords[0])
        with psycopg.connect(conninfo) as runtime, self.assertRaises(psycopg.errors.InsufficientPrivilege):
            runtime.execute("COMMENT ON TABLE public.django_migrations IS NULL")
        # Admitted by activate: the application runs on it, as the runtime login, and nothing is left to migrate.
        self.activate(destination, bundle, work)
        self.assertStarted(self.web())
        result = self.manage("migrate", "--check", SENTINEL_DB_ROLES="separate", POSTGRES_PASSWORD=None,
                             SENTINEL_DB_PASSWORD=self.passwords[0])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_what_a_new_installation_holds_is_what_the_recovery_replaces(self):
        # recovery.SEEDED is what the migrations insert: when a migration seeds another table, a destination would be
        # refused as holding data of its own; this says it first.
        destination = self.new_installation()
        manifest = self.destination_state(destination)
        seeded = {name for name, info in manifest["tables"].items() if info["rows"]}
        self.assertEqual(seeded, set(recovery.SEEDED))
        self.assertLessEqual(set(recovery.ALWAYS_SEEDED), seeded)
        recovery.check_fresh(manifest)


class MigrationHistoryTests(RecoveryTestCase):
    def test_a_history_the_new_installation_does_not_have_is_rejected(self):
        destination = self.new_installation()
        self.old_installation()
        self.old_sql("INSERT INTO django_migrations (app, name, applied) VALUES ('core', '9999_from_the_future', now())")
        before, untouched = self.old_state(), self.destination_state(destination)
        error, _ = self.assertRejected(destination, self.export(), "migrations")
        self.assertIn("only the old database has core.9999_from_the_future", error.detail)
        self.assertEqual(self.destination_state(destination), untouched)
        self.assertOldUntouched(before)

    def test_a_history_the_old_installation_does_not_have_is_rejected(self):
        destination = self.new_installation()
        self.old_installation()
        self.old_sql("DELETE FROM django_migrations WHERE app = 'sessions'")
        before, untouched = self.old_state(), self.destination_state(destination)
        error, _ = self.assertRejected(destination, self.export(), "migrations")
        self.assertIn("only the new one has sessions.0001_initial", error.detail)
        self.assertEqual(self.destination_state(destination), untouched)
        self.assertOldUntouched(before)

    def test_histories_are_compared_by_app_and_name_and_not_by_ids_or_times(self):
        destination = self.new_installation()
        self.old_installation()
        # The same migrations, in other rows: other ids (reversed, far from the destination's) and other times.
        self.old_sql("UPDATE django_migrations SET id = 100000 - id, applied = applied - interval '3 years'",
                     "SELECT setval('django_migrations_id_seq', 200000)")
        self.assertGreater(self.old_value("SELECT min(id) FROM django_migrations"), 60000)
        before = self.old_state()
        work = self.attempt(destination, self.export())
        self.assertEqual(self.state(work)["state"], "verified")
        self.assertEqual({tuple(pair) for pair in self.destination_state(destination)["migrations"]},
                         {tuple(pair) for pair in before["manifest"]["migrations"]})
        self.assertOldUntouched(before)

    def test_another_schema_is_rejected(self):
        destination = self.new_installation()
        untouched = self.destination_state(destination)
        for statements, check, mention in (
            (("CREATE TABLE public.stray (id integer PRIMARY KEY)",), "tables", "only the old database has stray"),
            (("ALTER TABLE public.auth_group ADD COLUMN note text",), "schema", "columns of auth_group"),
            (("ALTER TABLE public.auth_group DROP CONSTRAINT auth_group_name_key",), "schema", "constraint UNIQUE (name) of auth_group"),
        ):
            with self.subTest(check=check, mention=mention):
                self.old = self.copy_of_template(*statements)
                before = self.old_state()
                error, _ = self.assertRejected(destination, self.export(), check)
                self.assertIn(mention, error.detail)
                self.assertEqual(self.destination_state(destination), untouched)
                self.assertOldUntouched(before)


class DumpTests(RecoveryTestCase):
    def setUp(self):
        super().setUp()
        self.target = self.new_installation()
        self.old_installation()
        self.before = self.old_state()
        self.untouched = self.destination_state(self.target)
        self.bundle = self.export()
        self.sessions = self.before["manifest"]["tables"]["django_session"]["rows"]

    def assertRefused(self, check, mention=None):
        """Stopped by a check before the destination changed."""
        error, _ = self.assertRejected(self.target, self.bundle, check)
        if mention:
            self.assertIn(mention, error.detail)
        self.assertEqual(self.destination_state(self.target), self.untouched, "the destination changed")
        self.assertOldUntouched(self.before)

    def test_a_dump_that_is_not_the_exported_one_is_rejected(self):
        content = bytearray((self.bundle / recovery.DUMP).read_bytes())
        content[len(content) // 2] ^= 0xFF
        (self.bundle / recovery.DUMP).write_bytes(bytes(content))
        self.assertRefused("bundle", "SHA-256")

    def test_a_missing_dump_is_rejected(self):
        (self.bundle / recovery.DUMP).unlink()
        self.assertRefused("bundle", "the dump is missing")

    def test_a_record_that_is_not_one_is_rejected(self):
        (self.bundle / recovery.BUNDLE).write_text("{not json")
        self.assertRefused("bundle")

    def test_a_dump_that_cannot_be_read_is_rejected(self):
        self.forge(self.bundle, truncate=100)
        self.assertRefused("dump.toc", "cannot be read")

    def test_a_dump_cut_short_is_rejected_by_whichever_check_finds_it_and_leaves_nothing(self):
        size = (self.bundle / recovery.DUMP).stat().st_size
        # Its SHA-256 is made to agree: only its content can tell. Half of it: the last bytes of an archive may be
        # nothing but the ends of tables without rows, and a dump that lacks only those is complete.
        self.forge(self.bundle, truncate=size // 2)
        error, work = self.assertRejected(self.target, self.bundle, ("dump.toc", "restore.data", "verify.data"))
        if error.check == "restore.data":
            self.assertEqual(self.rows(self.target), {})
        elif error.check == "dump.toc":
            self.assertEqual(self.destination_state(self.target), self.untouched)
        self.assertNotActivated(self.target, work)
        self.assertOldUntouched(self.before)

    def test_a_dump_without_the_data_of_a_table_is_rejected(self):
        copy = self.copy_of_template()
        self.forge(self.bundle, dump=self.dump_of(copy, "--data-only", "--exclude-table=django_session"))
        self.assertRefused("dump.toc", "no data of django_session")

    def test_a_dump_with_the_data_of_another_table_is_rejected(self):
        copy = self.copy_of_template("CREATE TABLE public.stray (id integer PRIMARY KEY)", "INSERT INTO public.stray VALUES (1)")
        self.forge(self.bundle, dump=self.dump_of(copy))
        self.assertRefused("dump.toc", "data of stray")

    def test_a_dump_that_holds_more_than_data_is_rejected(self):
        self.forge(self.bundle, dump=self.dump_of(self.old, "--format=custom"))
        self.assertRefused("dump.toc", "holds more than data")

    def test_data_that_is_missing_is_found_after_the_restore_and_nothing_is_accepted(self):
        copy = self.copy_of_template("DELETE FROM django_session")
        self.forge(self.bundle, dump=self.dump_of(copy))
        error, work = self.assertRejected(self.target, self.bundle, "verify.data")
        self.assertIn(f"django_session has 0 rows, the old one {self.sessions}", error.detail)
        self.assertNotActivated(self.target, work)
        self.assertOldUntouched(self.before)

    def test_data_that_is_changed_is_found_after_the_restore_and_nothing_is_accepted(self):
        copy = self.copy_of_template("UPDATE django_session SET session_data = 'e30:other'")
        self.forge(self.bundle, dump=self.dump_of(copy))
        error, work = self.assertRejected(self.target, self.bundle, "verify.data")
        self.assertIn("django_session has other content than the old one", error.detail)
        self.assertNotIn("e30", error.detail)
        self.assertNotActivated(self.target, work)
        self.assertOldUntouched(self.before)

    def test_a_record_that_says_otherwise_than_the_dump_is_found(self):
        def claim(data):
            data["source"]["manifest"]["tables"]["django_session"]["rows"] += 1
        self.forge(self.bundle, change=claim)
        error, work = self.assertRejected(self.target, self.bundle, "verify.data")
        self.assertIn(f"django_session has {self.sessions} rows, the old one {self.sessions + 1}", error.detail)
        self.assertNotActivated(self.target, work)
        self.assertOldUntouched(self.before)

    def test_rows_with_no_parent_make_the_restore_fail_and_leave_nothing_of_the_data(self):
        copy = self.copy_of_template("SET session_replication_role = replica", "DELETE FROM auth_group WHERE name = 'Operators'")
        self.forge(self.bundle, dump=self.dump_of(copy))
        error, work = self.assertRejected(self.target, self.bundle, "restore.data")
        self.assertIn("left nothing of the data", error.detail)
        self.assertIn("violates foreign key constraint", error.detail)  # and not, say, a privilege the restore lacks
        self.assertEqual(self.rows(self.target), {})  # the restore was one transaction: rolled back as a whole
        self.assertRefusedToStart(self.web())  # rejected: the normal entrypoint does not start it either
        self.assertNotActivated(self.target, work)
        self.assertOldUntouched(self.before)
        # The destination was used: it is not offered the data again.
        self.assertRejected(self.target, self.bundle, "destination.fresh")

    def test_a_constraint_the_dump_violates_makes_the_restore_fail_and_leave_nothing_of_the_data(self):
        target = self.target
        for name, statements, cause in (
            ("unique", ("ALTER TABLE auth_group DROP CONSTRAINT auth_group_name_key",
                        "INSERT INTO auth_group (name) VALUES ('Operators')"),
             "duplicate key value violates unique constraint"),
            ("not null", ("ALTER TABLE django_session ALTER COLUMN session_data DROP NOT NULL",
                          "UPDATE django_session SET session_data = NULL"),
             "violates not-null constraint"),
        ):
            with self.subTest(name):
                if name != "unique":
                    target = self.rebuild_destination()
                self.forge(self.bundle, dump=self.dump_of(self.copy_of_template(*statements)))
                error, work = self.assertRejected(target, self.bundle, "restore.data")
                self.assertIn(cause, error.detail)
                self.assertNotIn("Operators", error.detail)
                self.assertEqual(self.rows(target), {})
                self.assertNotActivated(target, work)
        self.assertOldUntouched(self.before)


class SourceTests(RecoveryTestCase):
    def test_nothing_is_written_to_the_old_database(self):
        self.old_installation()
        before = self.old_state()
        self.assertEqual(self.source().psql("SHOW default_transaction_read_only").strip(), "on")
        with self.assertRaises(recovery.Failure) as caught:
            self.source().psql("CREATE TABLE intruder (id integer)")
        self.assertIn("read-only transaction", str(caught.exception))
        with self.assertRaises(recovery.Failure):
            self.source().psql("DELETE FROM django_session")
        with self.assertRaises(recovery.Failure) as caught:
            recovery.export_bundle(dataclasses.replace(self.source(), read_only=False), self.directory() / "bundle",
                                   log=lambda message: None)
        self.assertIn("read-only", str(caught.exception))
        self.assertOldUntouched(before)

    def test_an_export_leaves_no_bundle_when_it_fails_and_does_not_overwrite_one(self):
        self.old_installation()
        existing = self.directory() / "bundle"
        existing.mkdir()
        (existing / "keep").write_text("mine")
        with self.assertRaises(FileExistsError):
            recovery.export_bundle(self.source(), existing, log=lambda message: None)
        self.assertEqual((existing / "keep").read_text(), "mine")
        for statements, mention in (
            (("CREATE SCHEMA elsewhere", "CREATE TABLE elsewhere.t (id integer)"), "outside schema public"),
            (("SELECT lo_create(0)",), "large objects"),
        ):
            with self.subTest(mention):
                self.old = self.copy_of_template(*statements)
                before = self.old_state()
                bundle = self.directory() / "bundle"
                with self.assertRaises(recovery.Rejected) as caught:
                    recovery.export_bundle(self.source(), bundle, log=lambda message: None)
                self.assertEqual(caught.exception.check, "source")
                self.assertIn(mention, caught.exception.detail)
                self.assertFalse(bundle.exists())
                self.assertOldUntouched(before)

    def test_an_old_database_that_changes_while_it_is_exported_is_found_and_leaves_no_bundle(self):
        self.old_installation()
        test = self

        @dataclasses.dataclass(frozen=True)
        class Written(recovery.Endpoint):
            """A source whose application is still running: a row arrives while the dump is taken."""

            def run(self, program, arguments=(), **kwargs):
                if program == "pg_dump":
                    test.old_sql("INSERT INTO django_session (session_key, session_data, expire_date)"
                                 " VALUES ('00000000deadbeef', 'x', now())")
                return super().run(program, arguments, **kwargs)

        source = self.source()
        written = Written(**{field.name: getattr(source, field.name) for field in dataclasses.fields(source)})
        bundle = self.directory() / "bundle"
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.export_bundle(written, bundle, log=lambda message: None)
        self.assertEqual(caught.exception.check, "source")
        self.assertIn("changed while it was being read", caught.exception.detail)
        self.assertIn("django_session", caught.exception.detail)
        self.assertFalse(bundle.exists())

    def test_an_old_database_that_changed_since_the_export_is_found(self):
        self.old_installation()
        bundle = self.export()
        recovery.verify_source(self.source(), bundle, log=lambda message: None)
        self.old_sql("INSERT INTO django_session (session_key, session_data, expire_date) VALUES ('fedcba9876543210', 'x', now())")
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.verify_source(self.source(), bundle, log=lambda message: None)
        self.assertEqual(caught.exception.check, "source")
        self.assertIn("django_session", caught.exception.detail)

    def test_a_sequence_that_moved_in_the_old_database_is_found(self):
        self.old_installation()
        bundle = self.export()
        self.old_sql("SELECT nextval('auth_group_id_seq')")  # nothing else changed: no row
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.verify_source(self.source(), bundle, log=lambda message: None)
        self.assertEqual(caught.exception.check, "source")
        self.assertIn("sequence auth_group_id_seq", caught.exception.detail)

    def test_an_old_database_that_is_not_sound_is_exported_and_never_restored(self):
        destination = self.new_installation()
        untouched = self.destination_state(destination)
        for name, statements, mention in (
            ("a row without its parent",
             ("SET session_replication_role = replica", "DELETE FROM auth_group WHERE name = 'Operators'"),
             "foreign key auth_group_permissions"),
            ("a sequence behind its column", ("SELECT setval('auth_group_id_seq', 1)",), "auth_group_id_seq would give 2"),
            ("a sequence at its end", (f"SELECT setval('auth_group_id_seq', {INTEGER_MAXIMUM})",), "auth_group_id_seq is exhausted"),
        ):
            with self.subTest(name):
                self.old = self.copy_of_template(*statements)
                before = self.old_state()
                bundle = self.export()  # the export reports it; the bundle says so
                self.assertTrue(json.loads((bundle / recovery.BUNDLE).read_text())["source"]["unsound"])
                error, _ = self.assertRejected(destination, bundle, "bundle")
                self.assertIn(mention, error.detail)
                self.assertEqual(self.destination_state(destination), untouched)
                self.assertOldUntouched(before)


# What changes a value of a column, by its type, as little as can be: the first of the table's rows.
CHANGES = {
    "boolean": "NOT {column}",
    "smallint": "{column} + 1",
    "integer": "{column} + 1",
    "bigint": "{column} + 1",
    "numeric": "{column} + 1",
    "double precision": "{column} + 1",
    "text": "{column} || 'x'",
    "character varying": "{column} || 'x'",
    "timestamp with time zone": "{column} + interval '1 second'",
    "timestamp without time zone": "{column} + interval '1 second'",
    "date": "{column} + 1",
    "jsonb": "{column} || '{{\"x\": 1}}'::jsonb",
    "uuid": "gen_random_uuid()",
}
# The types a change must be seen in: the manifest's fingerprint stands for the rows only if it sees them all.
SEEN = ("boolean", "bigint", "numeric", "double precision", "text", "character varying", "timestamp with time zone")


class FingerprintTests(RecoveryTestCase):
    def test_a_change_in_a_column_of_any_type_is_seen_and_only_in_its_table(self):
        base = self.copy_of_template()
        original = recovery.read_manifest(self.legacy.endpoint(base))
        with self.legacy.connect(base) as connection:
            columns = connection.execute("""
                SELECT c.relname, a.attname, regexp_replace(format_type(a.atttypid, a.atttypmod), '\\(.*\\)', '')
                  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> 'django_migrations'
                   AND a.attnum > 0 AND NOT a.attisdropped
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype <> 'n' AND a.attnum = ANY (k.conkey))
                   AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND a.attnum = ANY (i.indkey))
                 ORDER BY c.relname, a.attnum""").fetchall()
        seen = set()
        for table, column, kind in columns:
            if kind in seen or kind not in CHANGES or not original["tables"][table]["rows"]:
                continue
            copy = self.copy_of_template()
            change = CHANGES[kind].format(column=f'"{column}"')
            try:
                with self.legacy.connect(copy) as connection:
                    updated = connection.execute(
                        f'UPDATE "{table}" SET "{column}" = {change} WHERE ctid = '
                        f'(SELECT min(ctid) FROM "{table}" WHERE "{column}" IS NOT NULL)').rowcount
            except psycopg.Error:
                continue  # a check or a width this change does not respect: another column of the type
            if not updated:
                continue  # no row holds a value there
            changed = recovery.read_manifest(self.legacy.endpoint(copy))
            seen.add(kind)
            with self.subTest(f"{table}.{column} ({kind})"):
                self.assertNotEqual(changed["tables"][table]["fingerprint"], original["tables"][table]["fingerprint"])
                self.assertEqual(changed["tables"][table]["rows"], original["tables"][table]["rows"])
                self.assertEqual({name: info for name, info in changed["tables"].items() if name != table},
                                 {name: info for name, info in original["tables"].items() if name != table})
        self.assertLessEqual(set(SEEN), seen, "the template holds no changeable column of some type")


    def test_the_fingerprint_does_not_depend_on_the_settings_of_the_database_it_is_read_in(self):
        rows = ("CREATE TABLE public.settings_probe (i interval, b bytea, d date, t timestamptz, f double precision)",
                "INSERT INTO public.settings_probe VALUES ('1 day 2 hours', '\\x00ff10', '2026-03-04', '2026-03-04 05:06:07+02', 0.1)")
        plain = self.copy_of_template(*rows)
        other = self.copy_of_template(*rows)
        with self.legacy.connect() as connection:
            for setting in ("intervalstyle = 'sql_standard'", "bytea_output = 'escape'", "datestyle = 'German, DMY'",
                            "timezone = 'Asia/Tokyo'", "extra_float_digits = -3"):
                connection.execute(f'ALTER DATABASE "{other}" SET {setting}')
        one = recovery.read_manifest(self.legacy.endpoint(plain))
        two = recovery.read_manifest(self.legacy.endpoint(other))
        self.assertEqual(one["tables"]["settings_probe"], two["tables"]["settings_probe"])
        self.assertEqual(one["tables"], two["tables"])


class SequenceTests(RecoveryTestCase):
    @staticmethod
    def positions(manifest):
        return {item["name"]: recovery.next_value(item) for item in manifest["sequences"]}

    def test_a_sequence_gives_next_what_the_old_one_would_whether_its_last_value_was_given_or_not(self):
        destination = self.new_installation()
        self.old_installation()
        # Given up to the largest id (is_called); set to a value not yet given (not called); and at the highest value
        # an integer has, not yet given: the one value left, which is not exhausted.
        self.old_sql("SELECT setval('auth_user_id_seq', (SELECT max(id) FROM auth_user), true)",
                     "SELECT setval('auth_group_id_seq', (SELECT max(id) FROM auth_group) + 10, false)",
                     f"SELECT setval('auth_permission_id_seq', {INTEGER_MAXIMUM}, false)")
        before = self.old_state()
        old = {item["name"]: item for item in before["manifest"]["sequences"]}
        self.assertTrue(old["auth_user_id_seq"]["is_called"])
        self.assertFalse(old["auth_group_id_seq"]["is_called"])
        self.assertFalse(old["auth_permission_id_seq"]["is_called"])
        # A sequence never used: its next value is its start, not the one after.
        unused = [item for item in old.values() if item["column_max"] is None and not item["is_called"]]
        self.assertTrue(unused)
        self.attempt(destination, self.export())
        after = self.destination_state(destination)
        self.assertEqual(self.positions(after), self.positions(before["manifest"]))
        new = {item["name"]: item for item in after["sequences"]}
        for item in unused:
            self.assertEqual(recovery.next_value(new[item["name"]]), item["last_value"])
        self.assertEqual(recovery.next_value(new["auth_permission_id_seq"]), INTEGER_MAXIMUM)
        self.assertEqual(recovery.next_value(new["auth_user_id_seq"]), recovery.next_value(old["auth_user_id_seq"]))
        self.assertEqual(recovery.soundness(self.reader(destination), after), [])
        self.assertOldUntouched(before)

    def test_a_sequence_that_was_not_set_is_found_after_the_restore(self):
        runtime, owner = self.new_installation()

        @dataclasses.dataclass(frozen=True)
        class WithoutSequences(recovery.Endpoint):
            """An owner whose sequences are never set: what a statement that did nothing would leave."""

            def psql(self, script):
                return "" if "setval" in script else super().psql(script)

        broken = WithoutSequences(**{field.name: getattr(owner, field.name) for field in dataclasses.fields(owner)})
        self.old_installation()
        before = self.old_state()
        work = self.directory() / "work"
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.import_bundle(runtime, broken, self.export(), work, log=lambda message: None)
        self.assertEqual(caught.exception.check, "verify.sequences")
        self.assertIn("would give 1, the old one", caught.exception.detail)
        record = self.state(work)
        self.assertEqual((record["state"], record["failed"]["check"]), ("rejected", "verify.sequences"))
        self.assertNotActivated((runtime, owner), work)
        self.assertOldUntouched(before)


class VerificationTests(RecoveryTestCase):
    def test_a_row_with_no_parent_after_the_restore_is_found_even_though_the_restore_checks_them(self):
        runtime, owner = self.new_installation()

        @dataclasses.dataclass(frozen=True)
        class Orphaned(recovery.Endpoint):
            """An owner that sees a row without its parent in the first foreign key, as a restore that did not check
            them (or a bypass of them) would leave."""

            def psql(self, script):
                if "NOT EXISTS" in script:
                    return "0|3\n" + "".join(f"{index}|0\n" for index in range(1, script.count("NOT EXISTS")))
                return super().psql(script)

        orphaned = Orphaned(**{field.name: getattr(owner, field.name) for field in dataclasses.fields(owner)})
        self.old_installation()
        before = self.old_state()
        work = self.directory() / "work"
        with self.assertRaises(recovery.Rejected) as caught:
            recovery.import_bundle(runtime, orphaned, self.export(), work, log=lambda message: None)
        self.assertEqual(caught.exception.check, "verify.integrity")
        self.assertRegex(caught.exception.detail, r"foreign key \w+ \(\w+\) -> \w+: 3 rows")
        record = self.state(work)
        self.assertEqual((record["state"], record["failed"]["check"]), ("rejected", "verify.integrity"))
        self.assertNotActivated((runtime, owner), work)
        self.assertOldUntouched(before)


class InjectedFailureTests(RecoveryTestCase):
    """The steps of the import that PostgreSQL does not make fail on demand, made to."""

    @staticmethod
    def intercepted(original, handler):
        """``original``, whose psql is ``handler(psql, script)``: it may fail, or pass the script on to the real one."""

        @dataclasses.dataclass(frozen=True)
        class Intercepted(recovery.Endpoint):
            def psql(self, script):
                return handler(super().psql, script)

        return Intercepted(**{field.name: getattr(original, field.name) for field in dataclasses.fields(original)})

    def prepare(self, **replaced):
        """The destination's two endpoints, with the ones ``replaced`` names (``runtime``, ``owner``) intercepted;
        then the plain ones, and the bundle of an old installation."""
        runtime, owner = self.new_installation()
        endpoints = {"runtime": runtime, "owner": owner}
        for name, handler in replaced.items():
            endpoints[name] = self.intercepted(endpoints[name], handler)
        self.old_installation()
        self.before = self.old_state()
        self.untouched = self.destination_state((runtime, owner))
        return (endpoints["runtime"], endpoints["owner"]), (runtime, owner), self.export()

    def test_rows_of_the_migrations_that_cannot_be_replaced_reject_the_destination_and_change_nothing(self):
        def refuse(psql, script):
            if "DELETE FROM" in script:
                raise recovery.Failure("psql: ERROR: permission denied for table auth_group")
            return psql(script)

        destination, plain, bundle = self.prepare(runtime=refuse)
        error, work = self.assertRejected(destination, bundle, "restore.clear")
        self.assertIn("could not be replaced", error.detail)
        self.assertEqual(self.destination_state(plain), self.untouched)
        self.assertNotActivated(plain, work)
        self.assertOldUntouched(self.before)

    def test_sequences_that_cannot_be_set_reject_the_destination_which_is_then_used(self):
        def refuse(psql, script):
            if "setval" in script:
                raise recovery.Failure("psql: ERROR: permission denied for sequence auth_group_id_seq")
            return psql(script)

        destination, plain, bundle = self.prepare(owner=refuse)
        error, work = self.assertRejected(destination, bundle, "restore.sequences")
        self.assertIn("could not be set", error.detail)
        self.assertNotActivated(plain, work)
        self.assertRejected(plain, bundle, "destination.fresh")  # the rows arrived: it is used
        self.assertOldUntouched(self.before)

    def test_an_interrupt_after_the_data_arrived_rejects_the_destination_which_is_then_used(self):
        def interrupt(psql, script):
            if "setval" in script:
                raise KeyboardInterrupt
            return psql(script)

        destination, plain, bundle = self.prepare(owner=interrupt)
        work = self.directory() / "work"
        with self.assertRaises(KeyboardInterrupt):
            recovery.import_bundle(*destination, bundle, work, log=lambda message: None)
        record = self.state(work)
        self.assertEqual((record["state"], record["failed"]["check"]), ("rejected", "import"))
        self.assertIn("KeyboardInterrupt", record["failed"]["detail"])
        self.assertNotActivated(plain, work)
        self.assertRejected(plain, bundle, "destination.fresh")
        self.assertOldUntouched(self.before)

    def test_a_destination_that_stops_being_trusted_while_it_is_restored_into_is_rejected(self):
        calls = []

        def drift_at_the_end(psql, script):
            if "sentinel-roles:" in script:
                calls.append(script)
                if len(calls) == 2:  # destination.trusted was the first; verify.trusted is the second
                    raise recovery.Failure("psql:<stdin>:9: ERROR:  sentinel-roles: sentinel_app may create objects | x")
            return psql(script)

        destination, plain, bundle = self.prepare(runtime=drift_at_the_end)
        error, work = self.assertRejected(destination, bundle, "verify.trusted")
        self.assertIn("sentinel_app may create objects", error.detail)
        self.assertNotActivated(plain, work)
        self.assertOldUntouched(self.before)

    def test_a_failure_to_ask_is_no_finding_about_the_destination(self):
        def broken(psql, script):
            if "sentinel-roles:" in script:
                raise recovery.Failure("psql: error: connection to server on socket failed")
            return psql(script)

        destination, plain, bundle = self.prepare(runtime=broken)
        work = self.directory() / "work"
        with self.assertRaises(recovery.Failure):
            recovery.import_bundle(*destination, bundle, work, log=lambda message: None)
        self.assertEqual(self.destination_state(plain), self.untouched)  # nothing was changed, and it is said to be unusable
        self.assertEqual(self.state(work)["failed"]["check"], "import")


class DestinationTests(RecoveryTestCase):
    def prepare(self):
        destination = self.new_installation()
        self.old_installation()
        self.before = self.old_state()
        self.untouched = self.destination_state(destination)
        return destination, self.export()

    def test_a_superuser_is_not_the_login_of_the_restore(self):
        destination, bundle = self.prepare()
        host, port = self.server
        environment = {"PGHOST": host, "PGPORT": port, "PGDATABASE": self.database}
        if self.superuser[1]:
            environment["PGPASSWORD"] = self.superuser[1]
        superuser = recovery.Endpoint(user=self.superuser[0], environment=environment)
        error, _ = self.assertRejected((superuser, destination[1]), bundle, "destination.login")
        self.assertIn("a superuser", error.detail)
        self.assertEqual(self.destination_state(destination), self.untouched)
        self.assertOldUntouched(self.before)

    def test_a_destination_that_drifted_from_what_apply_left_is_rejected(self):
        destination, bundle = self.prepare()
        self.execute(f"GRANT CREATE ON SCHEMA public TO {db_roles.RUNTIME_ROLE}")
        self.assertRejected(destination, bundle, "destination.trusted")
        self.assertEqual(self.destination_state(destination), self.untouched)
        self.assertOldUntouched(self.before)

    def test_a_destination_the_application_is_connected_to_is_rejected(self):
        destination, bundle = self.prepare()
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.RUNTIME_ROLE, password=self.passwords[0])
        with psycopg.connect(conninfo) as web:
            web.execute("SELECT 1")
            error, _ = self.assertRejected(destination, bundle, "destination.idle")
        self.assertIn("must not run before", error.detail)
        self.assertEqual(self.destination_state(destination), self.untouched)

    def test_a_destination_is_used_once(self):
        destination, bundle = self.prepare()
        self.attempt(destination, bundle)
        error, _ = self.assertRejected(destination, bundle, "destination.fresh")
        self.assertIn("holds data of its own", error.detail)
        self.assertOldUntouched(self.before)

    def test_a_session_that_is_just_ending_is_waited_for(self):
        destination, bundle = self.prepare()
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.RUNTIME_ROLE, password=self.passwords[0])
        session = psycopg.connect(conninfo)
        session.execute("SELECT 1")
        timer = threading.Timer(1.0, session.close)
        timer.start()
        self.addCleanup(timer.join)
        self.addCleanup(session.close)
        work = self.attempt(destination, bundle)  # the session is gone when the check has waited
        self.assertEqual(self.state(work)["state"], "verified")

    def test_a_session_of_the_migration_login_is_rejected_too(self):
        destination, bundle = self.prepare()
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.MIGRATION_ROLE, password=self.passwords[1])
        with psycopg.connect(conninfo) as migrate:
            migrate.execute("SELECT 1")
            self.assertRejected(destination, bundle, "destination.idle")

    def test_a_verified_destination_is_started_once(self):
        destination, bundle = self.prepare()
        work = self.attempt(destination, bundle)
        self.assertEqual(self.activate(destination, bundle, work), ["start"])
        self.assertEqual(self.state(work)["state"], "activated")
        with self.assertRaises(recovery.Refused):
            recovery.activate(*destination, work, lambda: None, log=lambda message: None)
        self.assertOldUntouched(self.before)

    def test_a_start_that_does_not_complete_is_started_again_and_the_destination_is_never_rejected(self):
        destination, bundle = self.prepare()
        work = self.attempt(destination, bundle)
        self.source_unchanged(bundle, work)
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.RUNTIME_ROLE, password=self.passwords[0])
        sessions = []

        def failing():
            web = psycopg.connect(conninfo, autocommit=True)  # web is up and connected when `up --wait` gives up
            sessions.append(web)
            self.addCleanup(web.close)
            raise recovery.Failure("docker compose up did not complete")

        with self.assertRaises(recovery.Failure):
            recovery.activate(*destination, work, failing, log=lambda message: None)
        self.assertEqual(self.state(work)["state"], "activating")
        # It served, and wrote: the checks would find a session and the data changed. The start is only made again.
        sessions[0].execute(
            "INSERT INTO django_session (session_key, session_data, expire_date) VALUES ('bbbbbbbbbbbbbbbb', 'x', now())")
        started = []
        recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.assertEqual((started, self.state(work)["state"]), (["start"], "activated"))
        self.assertOldUntouched(self.before)

    def test_a_rejected_destination_is_made_again_and_the_recovery_retried(self):
        destination, bundle = self.prepare()
        # A first attempt that is rejected after the data arrived: its record claims another content.
        copy = self.directory() / "copy"
        shutil.copytree(bundle, copy)

        def claim(data):
            data["source"]["manifest"]["tables"]["django_session"]["fingerprint"] = "0" * 32

        _, rejected = self.assertRejected(destination, self.forge(copy, change=claim), "verify.data")
        self.assertRejected(destination, bundle, "destination.fresh")  # not this one again, whatever the bundle
        # A new destination, a new work directory, the bundle that was exported: it verifies.
        destination = self.rebuild_destination()
        work = self.attempt(destination, bundle)
        self.assertEqual(self.state(work)["state"], "verified")
        self.assertEqual(self.state(rejected)["state"], "rejected")
        recovery.check_data(self.before["manifest"], self.destination_state(destination))
        self.assertOldUntouched(self.before)


class ActivationTests(RecoveryTestCase):
    """Verified, and then something changes: nothing is started, whatever it is."""

    def test_the_old_database_must_have_been_found_unchanged(self):
        destination = self.new_installation()
        self.old_installation()
        before = self.old_state()
        bundle = self.export()
        work = self.attempt(destination, bundle)
        started = []
        with self.assertRaises(recovery.Refused) as caught:
            recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.assertIn("verify-source", caught.exception.detail)
        self.source_unchanged(bundle, work)  # found unchanged: recorded
        self.assertIn("source_verified", self.state(work))

        @dataclasses.dataclass(frozen=True)
        class Interrupted(recovery.Endpoint):
            def psql(self, script):
                raise KeyboardInterrupt

        source = self.source()
        interrupted = Interrupted(**{field.name: getattr(source, field.name) for field in dataclasses.fields(source)})
        with self.assertRaises(KeyboardInterrupt):  # a verification that does not finish ends the earlier approval
            recovery.verify_source(interrupted, bundle, log=lambda message: None, work=work)
        self.assertNotIn("source_verified", self.state(work))
        with self.assertRaises(recovery.Refused):
            recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.source_unchanged(bundle, work)
        # The old application restarted after the export and took a write: the new finding replaces the old approval.
        self.old_sql("INSERT INTO django_session (session_key, session_data, expire_date) VALUES ('cccccccccccccccc', 'x', now())")
        with self.assertRaises(recovery.Rejected) as caught:
            self.source_unchanged(bundle, work)
        self.assertEqual(caught.exception.check, "source")
        self.assertNotIn("source_verified", self.state(work))
        with self.assertRaises(recovery.Refused):
            recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.assertEqual((started, self.state(work)["state"]), ([], "verified"))
        self.assertNotEqual(self.old_state(), before)  # the test's own write, the only one

    def test_the_bundle_must_be_the_one_that_was_imported(self):
        destination = self.new_installation()
        self.old_installation()
        bundle = self.export()
        work = self.attempt(destination, bundle)
        self.source_unchanged(bundle, work)
        data = json.loads((bundle / recovery.BUNDLE).read_text())
        (bundle / recovery.BUNDLE).write_text(json.dumps(data, indent=3))  # the same content, not the same bundle
        with self.assertRaises(recovery.Refused) as caught:
            recovery.activate(*destination, work, lambda: self.fail("started"), log=lambda message: None)
        self.assertIn("not the one that was imported", caught.exception.detail)

    def test_the_destination_is_checked_again_before_anything_is_started(self):
        destination = self.new_installation()
        self.old_installation()
        before = self.old_state()
        bundle = self.export()
        changes = (
            ("activate.trusted", lambda: self.execute(f"GRANT CREATE ON SCHEMA public TO {db_roles.RUNTIME_ROLE}")),
            ("migrations", lambda: self.execute("DELETE FROM django_migrations WHERE app = 'sessions'")),
            ("tables", lambda: self.execute(f"SET ROLE {db_roles.OWNER_ROLE}; CREATE TABLE public.extra_table (id integer)")),
            ("schema", lambda: self.execute("ALTER TABLE auth_group ADD COLUMN note text")),
            ("verify.data", lambda: self.execute(
                "INSERT INTO django_session (session_key, session_data, expire_date) VALUES ('dddddddddddddddd', 'x', now())")),
            ("verify.sequences", lambda: self.execute("SELECT nextval('auth_group_id_seq')")),
        )
        for index, (check, change) in enumerate(changes):
            with self.subTest(check):
                if index:
                    destination = self.rebuild_destination()
                work = self.attempt(destination, bundle)
                self.source_unchanged(bundle, work)
                change()
                started = []
                with self.assertRaises(recovery.Rejected) as caught:
                    recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
                self.assertEqual((caught.exception.check, started), (check, []))
                record = self.state(work)
                self.assertEqual((record["state"], record["failed"]["check"]), ("rejected", check))
        self.assertOldUntouched(before)

    def test_a_session_of_the_application_stops_the_start(self):
        destination = self.new_installation()
        self.old_installation()
        bundle = self.export()
        work = self.attempt(destination, bundle)
        self.source_unchanged(bundle, work)
        conninfo = make_conninfo(SERVER, dbname=self.database, user=db_roles.RUNTIME_ROLE, password=self.passwords[0])
        with psycopg.connect(conninfo) as web:
            web.execute("SELECT 1")
            started = []
            with self.assertRaises(recovery.Rejected) as caught:
                recovery.activate(*destination, work, lambda: started.append("start"), log=lambda message: None)
        self.assertEqual((caught.exception.check, started), ("destination.idle", []))


class InterruptedRestoreTests(RecoveryTestCase):
    @staticmethod
    def kill(process):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

    def test_a_restore_that_is_killed_leaves_nothing_and_the_destination_is_used(self):
        destination = self.new_installation()
        self.old_installation()
        before = self.old_state()
        bundle = self.export()
        work = self.directory() / "work"
        # A lock the checks do not conflict with and the restore, which writes to the table, does: on the last table
        # of the dump (the rows the migrations seeded are replaced before it, in another transaction), it waits inside
        # its transaction, having copied what comes before.
        tables = json.loads((bundle / recovery.BUNDLE).read_text())["dump"]["tables"]  # in the order they are restored
        last = [table for table in tables if table not in recovery.SEEDED][-1]
        first = tables[0]
        self.assertNotEqual(first, last)
        holder = psycopg.connect(make_conninfo(SERVER, dbname=self.database))
        self.addCleanup(holder.close)
        holder.execute(f'LOCK TABLE public."{last}" IN SHARE MODE')
        process = subprocess.Popen(
            [sys.executable, "-m", "sentinel.recovery", "import", "--bundle", str(bundle), "--work", str(work)], cwd=ROOT,
            env=self.destination_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.addCleanup(self.kill, process)
        self.wait_until(lambda: self.value(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = %s"
            " AND wait_event_type = 'Lock'", db_roles.RUNTIME_ROLE) > 0, "the restore to wait for its table")
        # It has written to the first table, uncommitted: what the kill must undo.
        self.assertEqual(self.value(
            "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE a.usename = %s AND l.granted"
            " AND l.locktype = 'relation' AND l.mode = 'RowExclusiveLock' AND l.relation = %s::regclass",
            db_roles.RUNTIME_ROLE, f'public."{first}"'), 1)
        self.kill(process)
        process.communicate()
        holder.rollback()
        self.wait_until(lambda: self.app_sessions() == 0, "the killed restore's session to end")

        record = self.state(work)
        self.assertEqual((record["state"], record["failed"]), ("restoring", None))
        self.assertEqual(self.rows(destination), {})  # what the migrations seeded is gone, and nothing arrived
        self.assertRefusedToStart(self.web())  # killed, so nothing could mark it rejected: the database says so
        # It is not started, whatever else says so; and it is not restored into again.
        self.assertNotActivated(destination, work)
        error, _ = self.assertRejected(destination, bundle, "destination.fresh")
        self.assertIn("did not finish", error.detail)
        self.assertOldUntouched(before)
        # From a new destination, the same bundle goes through.
        destination = self.rebuild_destination()
        retried = self.attempt(destination, bundle)
        self.assertEqual(self.state(retried)["state"], "verified")
        recovery.check_data(before["manifest"], self.destination_state(destination))
        self.assertOldUntouched(before)


class CommandTests(RecoveryTestCase):
    def test_the_commands_export_import_and_authorize_without_a_password_in_their_arguments(self):
        self.new_installation()
        self.old_installation()
        before = self.old_state()
        bundle, work = self.directory() / "bundle", self.directory() / "work"
        source = self.cli_environment(**self.legacy.libpq(self.old))
        destination = self.destination_environment()

        exported = self.command(["export", "--bundle", str(bundle)], source)
        self.assertEqual(exported.returncode, 0, exported.stderr)
        self.assertIn("read, never written", exported.stdout)
        digest = re.search(r"bundle SHA-256 ([0-9a-f]{64})", exported.stdout)[1]
        self.assertEqual(digest, recovery.bundle_digest(bundle))
        wrong = self.command(["import", "--bundle", str(bundle), "--bundle-sha256", "0" * 64, "--work", str(self.directory() / "w")],
                             destination)
        self.assertEqual(wrong.returncode, 1)
        self.assertIn("REJECTED: bundle", wrong.stderr)
        imported = self.command(["import", "--bundle", str(bundle), "--bundle-sha256", digest, "--work", str(work)], destination)
        self.assertEqual(imported.returncode, 0, imported.stderr)
        self.assertIn("VERIFIED", imported.stdout)
        self.assertNotIn("ACTIVATED", imported.stdout)
        # Not before the old database was found unchanged, and recorded.
        refused = self.command(["activate", "--work", str(work)], destination)
        self.assertEqual(refused.returncode, 1)
        self.assertIn("REFUSED: activate", refused.stderr)
        self.assertEqual(self.command(["verify-source", "--bundle", str(bundle)], source).returncode, 0)  # nothing recorded
        self.assertEqual(self.command(["activate", "--work", str(work)], destination).returncode, 1)
        checked = self.command(["verify-source", "--bundle", str(bundle), "--work", str(work)], source)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        authorized = self.command(["activate", "--work", str(work)], destination)
        self.assertEqual(authorized.returncode, 0, authorized.stderr)
        self.assertIn("AUTHORIZED", authorized.stdout)
        for result in (exported, imported, authorized):
            for secret in self.passwords:
                self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertOldUntouched(before)
        # The old database changed since: the recovery would not be of what is there.
        self.old_sql("DELETE FROM django_session")
        changed = self.command(["verify-source", "--bundle", str(bundle)], source)
        self.assertEqual(changed.returncode, 1)
        self.assertIn("REJECTED: source", changed.stderr)

    def test_a_rejection_exits_one_and_a_failure_three_and_both_leave_the_old_database_as_it_was(self):
        self.new_installation()
        self.old_installation()
        before = self.old_state()
        bundle = self.directory() / "bundle"
        source = self.cli_environment(**self.legacy.libpq(self.old))
        destination = self.destination_environment()
        self.assertEqual(self.command(["export", "--bundle", str(bundle)], source).returncode, 0)
        # A database that is not there is no finding about the data: a failure of its own.
        lost = self.command(["import", "--bundle", str(bundle), "--work", str(self.directory() / "work")],
                            {**destination, "PGDATABASE": "no_such_database"})
        self.assertEqual(lost.returncode, 3)
        self.assertIn("recovery: failed:", lost.stderr)
        # A dump that is not the one that was exported is: the destination is rejected.
        content = bytearray((bundle / recovery.DUMP).read_bytes())
        content[len(content) // 2] ^= 0xFF
        (bundle / recovery.DUMP).write_bytes(bytes(content))
        rejected = self.command(["import", "--bundle", str(bundle), "--work", str(self.directory() / "work")], destination)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("REJECTED: bundle", rejected.stderr)
        self.assertIn("not started; the old installation was not touched", rejected.stderr)
        self.assertOldUntouched(before)


class ComposeModeTests(RecoveryTestCase):
    """The programs run in the db container of a Compose project: ``docker compose exec``, which a stand-in for docker
    answers from the two clusters (there is no Docker here; CI's Compose job runs the real one)."""

    STUB = """\
#!{python}
# docker compose --project-directory DIR exec -T [-e NAME=VALUE]... db sh -c COMMAND sh PROGRAM ARGUMENT...
# docker compose --project-directory DIR up --detach --wait
# What the container's programs read and write goes through pipes, as docker's streams do: nothing can seek in it
# (a custom-format archive is then read in its order, and written without offsets).
import os
import subprocess
import sys

arguments = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(" ".join(arguments) + "\\n")
if arguments[:2] != ["compose", "--project-directory"]:
    sys.exit(64)
directory, rest = arguments[2], arguments[3:]
environment = dict(os.environ)
for line in open(os.path.join(directory, "container.env")):
    name, _, value = line.rstrip("\\n").partition("=")
    environment[name] = value
if rest[:1] == ["up"]:
    sys.exit(0)
if rest[:2] != ["exec", "-T"]:
    sys.exit(64)
rest = rest[2:]
while rest[:1] == ["-e"]:
    name, _, value = rest[1].partition("=")
    environment[name] = value
    rest = rest[2:]
if rest[:1] != ["db"]:
    sys.exit(64)
result = subprocess.run(rest[1:], env=environment, input=sys.stdin.buffer.read(), stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, check=False)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
"""

    def projects(self):
        """The two Compose projects (their db containers' own settings), and the environment of a command that runs
        docker: the stand-in first on PATH. Returns the old one, the new one, the environment and the stand-in's log."""
        host, port = self.server

        def project(name, **variables):
            directory = self.directory() / name
            directory.mkdir()
            (directory / "container.env").write_text("".join(f"{key}={value}\n" for key, value in variables.items()))
            return directory

        old = project("old", POSTGRES_USER=self.legacy.superuser, POSTGRES_DB=self.old, PGHOST=self.legacy.directory,
                      PGPORT=self.legacy.port)
        new = project("new", POSTGRES_USER=self.superuser[0], POSTGRES_DB=self.database, PGHOST=host, PGPORT=port,
                      PGPASSFILE=str(self.passfile()))
        stub = self.directory() / "bin"
        stub.mkdir()
        (stub / "docker").write_text(self.STUB.format(python=sys.executable))
        (stub / "docker").chmod(0o755)
        log = self.directory() / "docker.log"
        return old, new, self.cli_environment(PATH=f"{stub}:{os.environ['PATH']}", STUB_LOG=str(log)), log

    def test_the_commands_run_in_the_db_containers_and_the_stack_is_started_last(self):
        self.new_installation()
        self.old_installation()
        before = self.old_state()
        old, new, environment, log = self.projects()
        bundle, work = self.directory() / "bundle", self.directory() / "work"
        for arguments in (["export", "--bundle", str(bundle), "--compose-dir", str(old)],
                          ["import", "--bundle", str(bundle), "--work", str(work), "--compose-dir", str(new)],
                          ["verify-source", "--bundle", str(bundle), "--work", str(work), "--compose-dir", str(old)],
                          ["activate", "--work", str(work), "--compose-dir", str(new)]):
            result = self.command(arguments, environment)
            self.assertEqual(result.returncode, 0, result.stderr)
        calls = log.read_text().splitlines()
        started = [index for index, line in enumerate(calls) if line.endswith("up --detach --wait")]
        self.assertEqual(started, [len(calls) - 1], "the stack is started once, by the last call")
        self.assertEqual(self.state(work)["state"], "activated")
        # The logins are named, the old database is read in read-only sessions, the owner role is assumed by the
        # migration login, and no password is on any command line.
        text = "\n".join(calls)
        self.assertIn("-e PGUSER=sentinel_app", text)
        self.assertIn("-e PGUSER=sentinel_migrate", text)
        self.assertIn("-e PGOPTIONS=-c default_transaction_read_only=on -c role=sentinel_owner", text)
        self.assertIn("-e PGOPTIONS=-c role=sentinel_owner", text)
        self.assertIn("-e PGOPTIONS=-c default_transaction_read_only=on db", text)
        for secret in (*self.passwords, self.superuser[1]):
            if secret:
                self.assertNotIn(secret, text)
        self.assertOldUntouched(before)

    def test_a_rejected_destination_is_never_started(self):
        self.new_installation()
        self.old_installation()
        old, new, environment, log = self.projects()
        bundle, work = self.directory() / "bundle", self.directory() / "work"
        self.assertEqual(self.command(["export", "--bundle", str(bundle), "--compose-dir", str(old)], environment).returncode, 0)

        def claim(data):
            data["source"]["manifest"]["tables"]["django_session"]["rows"] += 1

        self.forge(bundle, change=claim)
        rejected = self.command(["import", "--bundle", str(bundle), "--work", str(work), "--compose-dir", str(new)], environment)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn("REJECTED: verify.data", rejected.stderr)
        activation = self.command(["activate", "--work", str(work), "--compose-dir", str(new)], environment)
        self.assertEqual(activation.returncode, 1)
        self.assertFalse(any(line.endswith("up --detach --wait") for line in log.read_text().splitlines()))

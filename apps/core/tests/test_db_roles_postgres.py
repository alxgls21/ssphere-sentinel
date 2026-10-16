"""The provisioning program (sentinel/db_roles.py), run by psql against PostgreSQL.

Skipped unless SENTINEL_TEST_POSTGRES holds a libpq connection string for the
bootstrap superuser of a cluster that is there to be thrown away: the roles
the program manages belong to the whole cluster, and these tests create and
drop them, along with databases of their own. They refuse to run when the
roles exist already, and on a cluster that holds other databases or roles,
which the separate logins refuse (Django's own test database included: give
it another cluster). While they run, PUBLIC loses TEMPORARY and CONNECT on the
cluster's other databases, and in template1 EXECUTE on the functions that
create large objects (the program requires all of it), and gets them back at
the end.
psql must be on PATH.
"""

import functools
import os
import re
import secrets
import shutil
import subprocess
import unittest

import psycopg
from django.test import SimpleTestCase
from psycopg import errors, sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from sentinel import db_roles
from sentinel.database import MIGRATION_ROLE, OWNER_ROLE, RUNTIME_ROLE

SERVER = os.environ.get("SENTINEL_TEST_POSTGRES", "")
# What CI sets (.github/workflows/ci.yml, job postgres): with SENTINEL_TEST_STRICT=1 nothing here
# may be skipped, a missing server, client program or capability fails instead; with
# SENTINEL_TEST_POSTGRES_MAJOR the server and its client programs must be that major version.
STRICT = os.environ.get("SENTINEL_TEST_STRICT", "") == "1"
MAJOR = os.environ.get("SENTINEL_TEST_POSTGRES_MAJOR", "")
CLIENT_PROGRAMS = ("psql", "pg_dump", "pg_restore", "initdb", "pg_ctl")
ROLES = (RUNTIME_ROLE, MIGRATION_ROLE, OWNER_ROLE)
# What PUBLIC holds, of what the program requires it not to hold, on the cluster's databases.
PUBLIC_DATABASE_PRIVILEGES = (
    "SELECT d.datname, a.privilege_type FROM pg_catalog.pg_database d,"
    " pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a"
    " WHERE d.datallowconn AND a.grantee = 0 AND a.privilege_type IN ('TEMPORARY', 'CONNECT') ORDER BY 1, 2"
)
# The functions PUBLIC may create large objects with, qualified (template1, before a test database).
PUBLIC_LARGE_OBJECT_CREATORS = (
    "SELECT pg_catalog.format('%%I.%%s', n.nspname, p.oid::pg_catalog.regprocedure) FROM pg_catalog.pg_proc p"
    " JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace"
    " WHERE p.prosrc = ANY (%s) AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1"
)
# Held by one test class at a time, in whatever process: they share the cluster's roles.
CLUSTER_LOCK = int.from_bytes(b"SNTLTEST", "big")


def identifier(name):
    return sql.Identifier(name)


def required(condition, reason):
    """unittest.skipUnless, but under SENTINEL_TEST_STRICT=1 the class runs, and its setUpClass
    fails on what is missing (strict_requirements)."""
    return (lambda cls: cls) if STRICT else unittest.skipUnless(condition, reason)


@functools.cache
def client_major(program):
    """The major version ``program --version`` reports, or None when it is not installed."""
    path = shutil.which(program)
    if not path:
        return None
    output = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30, check=True).stdout
    match = re.search(r"\(PostgreSQL\) (\d+)", output)
    return match[1] if match else output.strip()


@functools.cache
def wrapped(program):
    """Whether ``program`` on PATH is Debian's pg_wrapper, which picks a version of its own (by the
    cluster it is pointed at), whatever its ``--version`` says."""
    path = shutil.which(program)
    return bool(path) and os.path.basename(os.path.realpath(path)) == "pg_wrapper"


def strict_requirements(connection):
    """What SENTINEL_TEST_STRICT and SENTINEL_TEST_POSTGRES_MAJOR ask of the cluster and the
    programs on PATH; a list of what is wrong."""
    problems = []
    if MAJOR:
        (server,) = connection.execute("SELECT pg_catalog.current_setting('server_version_num')::integer / 10000").fetchone()
        if str(server) != MAJOR:
            problems.append(f"the server is PostgreSQL {server}, not {MAJOR}")
    for program in CLIENT_PROGRAMS:
        major = client_major(program)
        if major is None:
            if STRICT:
                problems.append(f"{program} is not installed")
        elif MAJOR and major != MAJOR:
            problems.append(f"{program} is from PostgreSQL {major}, not {MAJOR}")
        elif MAJOR and wrapped(program):
            problems.append(f"{program} is Debian's pg_wrapper: put the programs of PostgreSQL {MAJOR} first on PATH")
    return problems


@required(SERVER, "SENTINEL_TEST_POSTGRES names no disposable PostgreSQL cluster")
@required(shutil.which("psql"), "psql is not installed")
class DisposableClusterTestCase(SimpleTestCase):
    """A database of the test's own on the cluster SENTINEL_TEST_POSTGRES names, and the
    programs of sentinel/db_roles.py run on it by psql."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not SERVER:
            raise AssertionError("SENTINEL_TEST_STRICT=1, but SENTINEL_TEST_POSTGRES names no PostgreSQL cluster")
        with cls.connect() as connection:
            problems = strict_requirements(connection)
        if problems:
            raise AssertionError("the PostgreSQL tests cannot run as asked: " + "; ".join(problems))
        # A session of its own holds the lock until the class is done; cleanups run even
        # when this method fails halfway.
        lock = cls.connect()
        cls.addClassCleanup(lock.close)
        lock.execute("SELECT pg_catalog.pg_advisory_lock(%s)", [CLUSTER_LOCK])
        with cls.connect() as connection:
            (superuser,) = connection.execute("SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user").fetchone()
            existing = connection.execute(
                "SELECT pg_catalog.array_agg(rolname) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", [list(ROLES)]
            ).fetchone()[0]
            if not superuser:
                raise AssertionError("SENTINEL_TEST_POSTGRES must connect as a superuser")
            if existing:
                raise AssertionError(f"the cluster already has {', '.join(existing)}: these tests need a disposable cluster")
            # The separate logins refuse a cluster that is not Sentinel's own (DEDICATED_CLUSTER):
            # the tests' databases come and go, nothing else may be there.
            (foreign,) = connection.execute(
                "SELECT pg_catalog.string_agg(item, ', ' ORDER BY item) FROM ("
                " SELECT 'database ' || datname AS item FROM pg_catalog.pg_database"
                "  WHERE datname NOT IN ('postgres', 'template0', 'template1')"
                " UNION ALL SELECT 'role ' || rolname FROM pg_catalog.pg_roles WHERE oid <> 10 AND rolname !~ '^pg_'"
                " UNION ALL SELECT 'login ' || current_user WHERE (SELECT oid FROM pg_catalog.pg_roles"
                "  WHERE rolname = current_user) <> 10) items"
            ).fetchone()
            if foreign:
                raise AssertionError("SENTINEL_TEST_POSTGRES must name a cluster of its own, reached as its bootstrap "
                                     f"superuser (the separate logins refuse any other): it has {foreign}")
            for name, privilege in connection.execute(PUBLIC_DATABASE_PRIVILEGES).fetchall():
                connection.execute(sql.SQL("REVOKE {} ON DATABASE {} FROM PUBLIC").format(sql.SQL(privilege), identifier(name)))
                cls.addClassCleanup(cls.grant_to_public, privilege, name)
        # The functions that create large objects: their privileges belong to each database, and the
        # tests' databases are copies of template1.
        with cls.connect("template1") as connection:
            for (function,) in connection.execute(PUBLIC_LARGE_OBJECT_CREATORS, [list(db_roles.LARGE_OBJECT_CREATORS)]).fetchall():
                connection.execute(f"REVOKE EXECUTE ON FUNCTION {function} FROM PUBLIC")
                cls.addClassCleanup(cls.grant_execute_to_public, function)

    def skipTest(self, reason):
        # A test that cannot run is a failure when CI asks for all of them.
        if STRICT:
            self.fail(f"skipped under SENTINEL_TEST_STRICT=1: {reason}")
        super().skipTest(reason)

    @classmethod
    def grant_execute_to_public(cls, function):
        with cls.connect("template1") as connection:
            connection.execute(f"GRANT EXECUTE ON FUNCTION {function} TO PUBLIC")

    @classmethod
    def grant_to_public(cls, privilege, name):
        with cls.connect() as connection:
            connection.execute(sql.SQL("GRANT {} ON DATABASE {} TO PUBLIC").format(sql.SQL(privilege), identifier(name)))

    @staticmethod
    def connect(database=None):
        conninfo = make_conninfo(SERVER, dbname=database) if database else SERVER
        return psycopg.connect(conninfo, autocommit=True)

    def setUp(self):
        # What the test creates, dropped at the end: the databases first, which hold the
        # roles' privileges, then the roles.
        self.databases, self.roles = [], list(ROLES)
        self.addCleanup(self.drop)
        self.database = self.create_database(f"sentinel-roles-{secrets.token_hex(6)}", application=True)
        self.passwords = (secrets.token_urlsafe(48), secrets.token_urlsafe(48))

    def drop(self):
        with self.connect() as connection:
            for name in self.databases:
                connection.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(identifier(name)))
            for name in self.roles:
                connection.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(identifier(name)))

    def create_database(self, name, *, application=False, keep_public_temporary=False):
        """A database of this test. PUBLIC keeps what PostgreSQL gives it with
        ``keep_public_temporary``; otherwise it loses TEMPORARY, and, but in the
        application's database, CONNECT (the program requires both)."""
        with self.connect() as connection:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(identifier(name)))
            self.databases.append(name)
            if not keep_public_temporary:
                connection.execute(sql.SQL("REVOKE TEMPORARY ON DATABASE {} FROM PUBLIC").format(identifier(name)))
                if not application:
                    connection.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM PUBLIC").format(identifier(name)))
        return name

    def create_role(self, prefix):
        name = f"{prefix}_{secrets.token_hex(4)}"
        with self.connect() as connection:
            connection.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(identifier(name)))
        self.roles.insert(0, name)
        return name

    def execute(self, statement, *arguments, database=None):
        with self.connect(database or self.database) as connection:
            cursor = connection.execute(statement, arguments or None)
            return cursor.fetchall() if cursor.description else None

    def value(self, statement, *arguments):
        return self.execute(statement, *arguments)[0][0]

    def psql(self):
        """The command and environment of psql, reading a program from its input."""
        settings = conninfo_to_dict(make_conninfo(SERVER, dbname=self.database))
        environment = dict(os.environ)
        if "password" in settings:  # not on the command line, where other users can read it
            environment["PGPASSWORD"] = str(settings.pop("password"))
        return ["psql", "-X", "-q", "-d", make_conninfo(**settings), "-f", "-"], environment

    @staticmethod
    def outcome(program, status, stdout, stderr):
        """psql's exit status and stderr, whether the program printed its last line, and
        which DO block stopped it (psql names the line that ends the failing statement)."""
        lines = stdout.splitlines()
        ends = {number: match[1] for number, line in enumerate(program.sql.splitlines(), 1)
                if (match := re.fullmatch(r"\$(sentinel_\w+)\$;", line))}
        # Whatever language the server speaks: "ERROR" may be translated, the program's text is not.
        failed = re.search(r"psql:<stdin>:(\d+): \w+:\s+sentinel-roles:", stderr)
        block = ends.get(int(failed[1])) if failed else None
        return status, stderr, bool(lines) and lines[-1].endswith(program.nonce), block

    def run_program(self, program):
        command, environment = self.psql()
        result = subprocess.run(command, input=program.sql, capture_output=True, text=True, timeout=120,
                                check=False, env=environment)
        return self.outcome(program, result.returncode, result.stdout, result.stderr)

    def apply(self, *tables):
        return self.run_program(db_roles.apply_program(self.database, *self.passwords, tables))

    def status(self):
        return self.run_program(db_roles.status_program(self.database))

    def assertSucceeds(self, run):
        status, stderr, finished, _ = run()
        self.assertEqual((status, finished), (0, True), stderr)


class TemporaryPrivilegeTests(DisposableClusterTestCase):
    """The runtime role may not create temporary tables, by any path."""

    def snapshot(self):
        """What a refused run must leave as it was."""
        return self.execute(
            "SELECT 'role', rolname, concat_ws(' ', rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,"
            "  rolinherit, rolcanlogin, rolvaliduntil, rolpassword) FROM pg_catalog.pg_authid WHERE rolname = ANY (%s)"
            " UNION ALL SELECT 'member', m.roleid::regrole::text || ' ' || m.member::regrole::text,"
            "  concat_ws(' ', m.admin_option, m.inherit_option, m.set_option) FROM pg_catalog.pg_auth_members m"
            "  WHERE m.member::regrole::text = ANY (%s) OR m.roleid::regrole::text = ANY (%s)"
            " UNION ALL SELECT 'database', datname, coalesce(datacl::text, '') FROM pg_catalog.pg_database"
            " UNION ALL SELECT 'schema', nspname, coalesce(nspacl::text, '') FROM pg_catalog.pg_namespace"
            " UNION ALL SELECT 'relation', relname, relowner::regrole::text || coalesce(relacl::text, '') FROM pg_catalog.pg_class"
            "  WHERE relnamespace = 'public'::regnamespace"
            " UNION ALL SELECT 'default', defaclrole::regrole::text, coalesce(defaclacl::text, '') FROM pg_catalog.pg_default_acl"
            " UNION ALL SELECT 'setting', setrole::text, coalesce(setconfig::text, '') FROM pg_catalog.pg_db_role_setting"
            " ORDER BY 1, 2, 3",
            list(ROLES), list(ROLES), list(ROLES),
        )

    def assertRefused(self, run, message):
        """Refused with ``message``, by the check before anything changes (apply) or by the
        final check (status), and nothing changed. Returns psql's stderr."""
        before = self.snapshot()
        status, stderr, finished, block = run()
        self.assertEqual((status, finished), (3, False), stderr)
        self.assertIn(message, stderr)
        self.assertEqual(block, "sentinel_preflight" if run == self.apply else "sentinel_verify", stderr)
        self.assertEqual(self.snapshot(), before)
        return stderr

    def run_remedies(self, stderr):
        """Run what the refusal asks for, as printed: "as <role>: <statement>; ..."."""
        remedies = stderr.split("revoking CONNECT from PUBLIC does as well): ", 1)[1].splitlines()[0].split("; ")
        with self.connect(self.database) as connection:
            for remedy in remedies:
                role, statement = re.fullmatch(r"as (\S+): (.+)", remedy.strip()).groups()
                connection.execute(f"SET ROLE {role}")
                connection.execute(statement)
                connection.execute("RESET ROLE")
        return remedies

    def provision(self):
        self.assertSucceeds(self.apply)
        self.assertSucceeds(self.status)

    def assertRuntimeCannotCreateTemporaryTables(self):
        self.assertFalse(self.value("SELECT has_database_privilege(%s, current_database(), 'TEMPORARY')", RUNTIME_ROLE))
        with self.connect(self.database) as connection, self.assertRaises(errors.InsufficientPrivilege):
            connection.execute(sql.SQL("SET ROLE {}").format(identifier(RUNTIME_ROLE)))
            connection.execute("CREATE TEMPORARY TABLE scratch (a integer)")

    def test_the_default_grant_to_public_is_refused_then_provisioning_follows_the_remedy(self):
        # A new database's ACL is NULL: PostgreSQL's default, which gives PUBLIC TEMPORARY. It
        # replaces the database of setUp: the cluster holds Sentinel's database only.
        replaced = self.database
        self.database = self.create_database(f"sentinel-roles-{secrets.token_hex(6)}", keep_public_temporary=True)
        self.execute(sql.SQL("DROP DATABASE {}").format(identifier(replaced)), database="postgres")
        self.assertIsNone(self.value("SELECT datacl FROM pg_catalog.pg_database WHERE datname = current_database()"))
        stderr = self.assertRefused(self.apply, f'REVOKE TEMPORARY ON DATABASE "{self.database}" FROM PUBLIC')
        self.assertEqual(self.value("SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)
        self.assertEqual(len(self.run_remedies(stderr)), 1)
        self.assertSucceeds(self.apply)
        self.assertSucceeds(self.status)
        self.assertRuntimeCannotCreateTemporaryTables()

    def test_another_database_the_runtime_role_may_connect_to_is_refused(self):
        # By default PUBLIC may connect to postgres and create temporary tables there (setUpClass
        # took both away, as the program requires): given back, the runtime role could too.
        self.provision()
        self.execute("GRANT CONNECT, TEMPORARY ON DATABASE postgres TO PUBLIC")
        self.addCleanup(self.execute, "REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC")
        for run in (self.status, self.apply):
            with self.subTest(run.__name__):
                self.assertRefused(run, "REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC")
        self.execute("REVOKE CONNECT ON DATABASE postgres FROM PUBLIC")
        self.assertSucceeds(self.status)

    def test_public_granted_it_again_is_refused_by_status_and_apply_alike(self):
        self.provision()
        self.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO PUBLIC").format(identifier(self.database)))
        for run in (self.status, self.apply):
            with self.subTest(run.__name__):
                self.assertRefused(run, f'REVOKE TEMPORARY ON DATABASE "{self.database}" FROM PUBLIC')

    def temporary_check(self):
        """The TEMPORARY check on its own, as status runs it: its refusal, or None."""
        block = sql.SQL(
            "DO $check$ DECLARE found text; app_oid oid := {}::pg_catalog.regrole; BEGIN\n" + db_roles.TEMPORARY + "END $check$"
        ).format(sql.Literal(RUNTIME_ROLE))
        with self.connect(self.database) as connection:
            connection.execute("SET search_path = pg_catalog, pg_temp")
            try:
                connection.execute(block)
            except errors.RaiseException as exc:
                return str(exc)
        return None

    def test_a_grant_to_public_by_another_role_is_revoked_as_that_role(self):
        # The owner's REVOKE leaves another grantor's entry in place: the refusal names the grantor.
        # Another role is outside a cluster of Sentinel's own, which status refuses first; the
        # TEMPORARY check on its own still names the grantor.
        self.provision()
        grantor = self.create_role("sentinel_roles_grantor")
        self.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO {} WITH GRANT OPTION").format(identifier(self.database), identifier(grantor)))
        with self.connect(self.database) as connection:
            connection.execute(sql.SQL("SET ROLE {}").format(identifier(grantor)))
            connection.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO PUBLIC").format(identifier(self.database)))
        self.assertRefused(self.status, f"this cluster also has role {grantor}")
        refusal = self.temporary_check()
        self.assertIsNotNone(refusal, "the TEMPORARY check refused nothing")
        self.assertIn(f'as {grantor}: REVOKE TEMPORARY ON DATABASE "{self.database}" FROM PUBLIC', refusal)
        self.execute(sql.SQL("REVOKE TEMPORARY ON DATABASE {} FROM PUBLIC").format(identifier(self.database)))
        remaining = self.temporary_check()
        self.assertIsNotNone(remaining, "the TEMPORARY check refused nothing")
        self.assertIn(f"as {grantor}:", remaining)
        self.run_remedies(refusal)
        self.assertIsNone(self.temporary_check())
        self.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM {} CASCADE; DROP ROLE {}").format(
            identifier(self.database), identifier(grantor), identifier(grantor)))
        self.assertSucceeds(self.status)

    def test_an_explicit_grant_to_the_runtime_role_is_refused(self):
        self.provision()
        self.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO {}").format(identifier(self.database), identifier(RUNTIME_ROLE)))
        for run in (self.status, self.apply):
            with self.subTest(run.__name__):
                self.assertRefused(run, f'REVOKE TEMPORARY ON DATABASE "{self.database}" FROM {RUNTIME_ROLE}')
        self.execute(sql.SQL("REVOKE TEMPORARY ON DATABASE {} FROM {}").format(identifier(self.database), identifier(RUNTIME_ROLE)))
        self.assertSucceeds(self.status)

    def test_a_role_the_runtime_role_can_become_is_refused(self):
        # PostgreSQL's predefined roles are the only others a cluster of Sentinel's own holds.
        self.provision()
        helper = "pg_read_all_data"
        self.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO {}").format(identifier(self.database), identifier(helper)))

        def create_temporary_table_as_runtime():
            with self.connect(self.database) as connection:
                connection.execute(sql.SQL("SET SESSION AUTHORIZATION {}").format(identifier(RUNTIME_ROLE)))
                connection.execute(sql.SQL("SET ROLE {}").format(identifier(helper)))
                connection.execute("CREATE TEMPORARY TABLE scratch (a integer)")

        with self.assertRaises(errors.InsufficientPrivilege):
            create_temporary_table_as_runtime()
        self.execute(sql.SQL("GRANT {} TO {} WITH INHERIT FALSE, SET TRUE").format(identifier(helper), identifier(RUNTIME_ROLE)))
        create_temporary_table_as_runtime()  # the path is real once the membership exists
        # The program refuses any membership of the runtime role first.
        for run in (self.status, self.apply):
            with self.subTest(run.__name__):
                self.assertRefused(run, "role memberships")
        # The TEMPORARY check on its own finds the same path.
        refusal = self.temporary_check()
        self.assertIsNotNone(refusal, "the TEMPORARY check refused nothing")
        self.assertIn(f'REVOKE TEMPORARY ON DATABASE "{self.database}" FROM {helper}', refusal)

    def test_other_roles_keep_what_the_operator_gives_them(self):
        self.provision()
        helper = "pg_read_all_data"
        self.execute(sql.SQL("GRANT TEMPORARY ON DATABASE {} TO {}").format(identifier(self.database), identifier(helper)))
        self.assertSucceeds(self.status)
        self.assertSucceeds(self.apply)
        self.assertTrue(self.value("SELECT has_database_privilege(%s, current_database(), 'TEMPORARY')", helper))
        self.assertRuntimeCannotCreateTemporaryTables()

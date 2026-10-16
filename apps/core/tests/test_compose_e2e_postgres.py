"""The parts of the Compose rehearsal (.github/scripts/separate-roles-e2e.sh) that need PostgreSQL
and no Docker, run against the real thing on each version the postgres job of
.github/workflows/ci.yml runs (16 and 18): the SQL its checks ask the database, the way it cuts a
provisioning short, the swallowed acknowledgement, the revocations it takes from the documentation,
and every statement it expects each login to be refused.

The script is sourced, and a stand-in ``docker`` sends what it would run in the db container to the
disposable cluster (the stand-in of ProvisioningScriptTests). What Docker and Compose do with the
rest remains for the CI job that runs the script.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from apps.core.tests.test_database_guard_postgres import ROOT, STARTED, ApplicationTestCase
from apps.core.tests.test_database_startup_postgres import DOCKER
from apps.core.tests.test_db_roles_postgres import ROLES
from sentinel import db_roles

SCRIPT = ROOT / ".github" / "scripts" / "separate-roles-e2e.sh"
PROBE = ROOT / ".github" / "scripts" / "sql_probe.py"
INJECTED = "SELECT pg_catalog.pg_advisory_xact_lock(4243), pg_catalog.pg_sleep(600);"


class ComposeRehearsalTests(ApplicationTestCase):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.docker = self.directory / "bin" / "docker"
        self.docker.parent.mkdir()
        self.docker.write_text(DOCKER)
        self.docker.chmod(self.docker.stat().st_mode | stat.S_IXUSR)
        self.calls = self.directory / "calls"
        environment = {"POSTGRES_DB": self.database, "SENTINEL_DB_ROLES": "separate"}
        (self.directory / "config.json").write_text(json.dumps({"services": {
            "db": {"environment": {"POSTGRES_DB": self.database, "POSTGRES_USER": self.superuser[0],
                                   "POSTGRES_PASSWORD": self.superuser[1] or "a-password"}},
            "web": {"environment": {**environment, "SENTINEL_DB_PASSWORD": self.passwords[0],
                                    "SENTINEL_DB_MIGRATE_PASSWORD": ""}},
            "migrate": {"environment": {**environment, "SENTINEL_DB_ACCESS": "migrate", "SENTINEL_DB_PASSWORD": "",
                                        "SENTINEL_DB_MIGRATE_PASSWORD": self.passwords[1]}},
        }}))

    def script_environment(self, settings=None):
        """The environment a script run from the project directory has, with ``docker`` the stand-in."""
        environment = {
            "PATH": os.pathsep.join([str(self.docker.parent), str(Path(sys.executable).parent),
                                     os.path.dirname(shutil.which("psql")), "/usr/bin", "/bin"]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "DOCKER_CALLS": str(self.calls), "DOCKER_CONFIG": str(self.directory / "config.json"),
            "DB_USER": self.superuser[0], "DB_NAME": self.database,
            "PGHOST": self.server[0], "PGPORT": self.server[1],
            # What the rehearsal keeps in its variables.
            "work": str(self.directory), "E2E_REAL_DOCKER": str(self.docker), "COMPOSE_PROJECT_NAME": "test",
            "app": self.passwords[0], "migration": self.passwords[1], "bootstrap": self.superuser[1] or "a-password",
        }
        if self.superuser[1]:
            environment["PGPASSWORD"] = self.superuser[1]
        environment.update(settings or {})
        return environment

    def shell(self, body, **options):
        """bash, running ``body`` after the rehearsal's functions have been defined."""
        result = subprocess.run(["bash", "-c", f'source "{SCRIPT}"; {body}'], cwd=ROOT, env=self.script_environment(),
                                capture_output=True, text=True, timeout=120, check=False, **options)
        for secret in (*self.passwords, self.superuser[1]):
            if secret:
                self.assertFalse(secret in result.stdout + result.stderr, "a password is in the output")
        return result

    def statements(self, name):
        """What the rehearsal keeps in the array ``name``."""
        result = self.shell(f'printf "%s\\0" "${{{name}[@]}}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        return [statement for statement in result.stdout.split("\0") if statement]

    def probe(self, access, statements):
        """What .github/scripts/sql_probe.py prints for ``statements`` run with the login of a container."""
        settings = {"SENTINEL_DB_ROLES": "separate", "SENTINEL_DB_ACCESS": access, "POSTGRES_PASSWORD": None,
                    "WEB_SQL": "\n".join(statements)}
        if access == "runtime":
            settings["SENTINEL_DB_PASSWORD"] = self.passwords[0]
        else:
            settings["SENTINEL_DB_MIGRATE_PASSWORD"] = self.passwords[1]
        result = self.manage("shell", "--no-imports", "-v", "0", "-c", PROBE.read_text(), **settings)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def owners(self):
        return self.value("SELECT string_agg(DISTINCT pg_get_userbyid(relowner), ',') FROM pg_class"
                          " WHERE relnamespace = 'public'::regnamespace")

    # --- the questions the rehearsal asks the database

    def test_the_helper_queries_answer_on_a_restricted_installation(self):
        self.restricted_installation()
        for helper, expected in (("managed_roles", "3"), ("marker", "1"), ("table_owners", "sentinel_owner"),
                                 ("migrations_privileges", "app SELECT")):
            with self.subTest(helper):
                result = self.shell(helper)
                self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), result.stderr)
        self.assertGreater(int(self.shell("applied_migrations").stdout), 0)
        verifiers = self.shell("verifiers").stdout.splitlines()
        self.assertEqual([line.split()[0] for line in verifiers], ["sentinel_app", "sentinel_migrate", "sentinel_owner"])
        self.assertEqual(verifiers[2], "sentinel_owner none")

    def test_the_fingerprint_follows_every_privilege_and_nothing_else(self):
        self.restricted_installation()
        original = self.value("SELECT obj_description('sentinel_restricted'::regnamespace, 'pg_namespace')")
        before = self.shell("fingerprint").stdout
        self.assertRegex(before, r"^[0-9a-f]{32} [0-9a-f]{32}\n$")
        self.assertEqual(self.shell("fingerprint").stdout, before)
        database = f'"{self.database}"'
        for change, undo in (
            ("GRANT TRUNCATE ON auth_group TO sentinel_app", "REVOKE TRUNCATE ON auth_group FROM sentinel_app"),
            (f"GRANT CREATE ON DATABASE {database} TO sentinel_app", f"REVOKE CREATE ON DATABASE {database} FROM sentinel_app"),
            (f"GRANT TEMPORARY ON DATABASE {database} TO PUBLIC", f"REVOKE TEMPORARY ON DATABASE {database} FROM PUBLIC"),
            ("GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC"),
            ("GRANT UPDATE (name) ON auth_group TO sentinel_app", "REVOKE UPDATE (name) ON auth_group FROM sentinel_app"),
            ("ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public GRANT TRUNCATE ON TABLES TO sentinel_app",
             "ALTER DEFAULT PRIVILEGES FOR ROLE sentinel_owner IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM sentinel_app"),
            ("ALTER ROLE sentinel_app CREATEDB", "ALTER ROLE sentinel_app NOCREATEDB"),
            (f"ALTER ROLE sentinel_app IN DATABASE {database} SET work_mem = '64MB'",
             f"ALTER ROLE sentinel_app IN DATABASE {database} RESET work_mem"),
            ("COMMENT ON SCHEMA sentinel_restricted IS 'e2e altered'", f"COMMENT ON SCHEMA sentinel_restricted IS '{original}'"),
            ("GRANT pg_read_all_data TO sentinel_app", "REVOKE pg_read_all_data FROM sentinel_app"),
            # What lies outside the application's own tables: catalogs, functions, the record of the migrations.
            ("GRANT SELECT ON pg_catalog.pg_authid TO sentinel_app", "REVOKE SELECT ON pg_catalog.pg_authid FROM sentinel_app"),
            ("GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO sentinel_app",
             "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM sentinel_app"),
            ("GRANT UPDATE (name) ON django_migrations TO PUBLIC", "REVOKE UPDATE (name) ON django_migrations FROM PUBLIC"),
            ("GRANT INSERT ON django_migrations TO sentinel_app", "REVOKE INSERT ON django_migrations FROM sentinel_app"),
            ("CREATE SCHEMA e2e_probe", "DROP SCHEMA e2e_probe"),
        ):
            with self.subTest(change):
                self.execute(change)
                self.assertNotEqual(self.shell("fingerprint").stdout, before)
                self.execute(undo)
                self.assertEqual(self.shell("fingerprint").stdout, before)

    def test_the_verifiers_of_roles_that_are_not_there_are_an_error_and_not_an_empty_answer(self):
        result = self.shell("verifiers")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL: the passwords of the three roles could not be read", result.stderr)

    def test_the_fingerprint_sees_what_the_cluster_shares(self):
        # A parameter a role may set, and a tablespace it may create in: shared by every database.
        self.restricted_installation()
        before = self.shell("fingerprint").stdout
        self.execute("GRANT SET ON PARAMETER work_mem TO sentinel_app")
        self.assertNotEqual(self.shell("fingerprint").stdout, before)
        self.execute("REVOKE SET ON PARAMETER work_mem FROM sentinel_app")
        self.assertEqual(self.shell("fingerprint").stdout, before)

        directory = tempfile.mkdtemp(prefix="sentinel-tablespace-")
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        name = f"e2e_{self.database[-12:].replace('-', '_')}"
        try:
            self.execute(f"CREATE TABLESPACE {name} LOCATION '{directory}'")
        except Exception as exc:  # the server cannot use a directory of this host
            self.fail(f"a tablespace could not be created, and the fingerprint of one cannot be tried: {exc}")
        self.addCleanup(self.execute, f"DROP TABLESPACE IF EXISTS {name}")
        with_tablespace = self.shell("fingerprint").stdout
        self.assertNotEqual(with_tablespace, before)
        # Seen when it is granted. (Not asked to come back to the same value: a tablespace that had no ACL has the
        # owner's own once something was granted and revoked: the same rights, written down.)
        self.execute(f"GRANT CREATE ON TABLESPACE {name} TO PUBLIC")
        self.assertNotEqual(self.shell("fingerprint").stdout, with_tablespace)

    def test_new_passwords_change_the_verifiers_and_not_the_fingerprint(self):
        self.restricted_installation()
        before, verifiers = self.shell("fingerprint").stdout, self.shell("verifiers").stdout
        self.assertSucceeds(self.apply)  # as it would again: new salts, the same passwords
        changed = self.shell("verifiers").stdout.splitlines()
        self.assertEqual(self.shell("fingerprint").stdout, before)
        for old, new in zip(verifiers.splitlines()[:2], changed[:2]):
            self.assertNotEqual(old, new)
        self.assertEqual(changed[2], "sentinel_owner none")

    def test_what_may_be_done_with_the_record_of_the_migrations_is_asked_at_every_level(self):
        self.restricted_installation()
        for change, undo, expected in (
            ("GRANT INSERT ON django_migrations TO PUBLIC", "REVOKE INSERT ON django_migrations FROM PUBLIC",
             "app INSERT,SELECT\npublic INSERT"),
            ("GRANT UPDATE (name) ON django_migrations TO sentinel_app", "REVOKE UPDATE (name) ON django_migrations FROM sentinel_app",
             "app SELECT,UPDATE"),
            ("GRANT TRUNCATE ON django_migrations TO sentinel_app", "REVOKE TRUNCATE ON django_migrations FROM sentinel_app",
             "app SELECT,TRUNCATE"),
        ):
            with self.subTest(change):
                self.execute(change)
                self.assertEqual(self.shell("migrations_privileges").stdout.strip(), expected)
                self.execute(undo)
                self.assertEqual(self.shell("migrations_privileges").stdout.strip(), "app SELECT")

    # --- what the logins are refused

    def test_the_statements_each_login_is_refused_are_refused_by_postgres(self):
        self.restricted_installation()
        for access, name in (("runtime", "WEB_REFUSED"), ("migrate", "MIGRATE_REFUSED"), ("runtime", "RECORD_WRITES"),
                             ("runtime", "MARKER_REFUSED_WEB"), ("migrate", "MARKER_REFUSED_MIGRATE")):
            with self.subTest(name):
                statements = self.statements(name)
                self.assertTrue(statements)
                self.assertEqual(self.probe(access, statements), ["error 42501"] * len(statements))
        # Nothing the refused statements would have created or changed exists.
        self.assertEqual(self.value("SELECT count(*) FROM pg_namespace WHERE nspname IN ('schema_probe', 'e2e')"), 0)
        self.assertEqual(self.value("SELECT count(*) FROM pg_class WHERE relname IN ('schema_probe', 'temporary_probe')"), 0)
        self.assertEqual(self.value("SELECT count(*) FROM pg_largeobject_metadata"), 0)
        self.assertEqual(self.shell("migrations_privileges").stdout.strip(), "app SELECT")

    def test_what_the_runtime_login_is_for_is_allowed(self):
        self.restricted_installation()
        allowed = self.statements("WEB_ALLOWED")
        self.assertEqual(len(allowed) % 2, 0)
        for statement, expected in zip(allowed[::2], allowed[1::2]):
            with self.subTest(statement):
                self.assertEqual(self.probe("runtime", [statement]), [expected])

    # --- an activated installation that is not as apply left it

    def password_digests(self):
        """The digest of what each role of Sentinel's stores as its password (renamed or not): never the verifier."""
        return self.execute("SELECT rolname, md5(rolpassword) FROM pg_authid WHERE rolname = ANY (%s) ORDER BY 1",
                            ["sentinel_owner", "sentinel_migrate", "sentinel_app", "sentinel_app_gone"])

    def rename_back(self):
        self.execute("DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sentinel_app_gone')"
                     " THEN ALTER ROLE sentinel_app_gone RENAME TO sentinel_app; END IF; END $$")

    def test_a_renamed_role_is_state_c_to_status_and_the_start_and_a_topology_refusal_to_apply(self):
        # The sequence of scenario_activation_marker: valid roles, one renamed, what each says, nothing changed.
        self.restricted_installation()
        original = self.shell("fingerprint").stdout
        self.addCleanup(self.rename_back)  # the roles are dropped by name at the end
        self.execute("ALTER ROLE sentinel_app RENAME TO sentinel_app_gone")
        expected = self.shell('printf "%s" "$RENAMED_ROLE_REFUSAL"').stdout
        self.assertEqual(expected, "this cluster also has role sentinel_app_gone")
        renamed, digests = self.shell("fingerprint").stdout, self.password_digests()
        record = self.value("SELECT obj_description('sentinel_restricted'::regnamespace, 'pg_namespace')")
        owners, roles = self.owners(), self.value("SELECT count(*) FROM pg_roles WHERE rolname = ANY (%s)",
                                                  ["sentinel_owner", "sentinel_migrate", "sentinel_app", "sentinel_app_gone"])
        self.assertEqual(roles, 3)

        # status reads the history first: state C, and not the topology.
        status, stderr, finished, block = self.status()
        self.assertEqual((status, finished, block), (3, False, "sentinel_verify"), stderr)
        self.assertIn("state C", stderr)
        self.assertNotIn(expected, stderr)
        # apply checks the topology first: the renamed role is a role of the cluster that is not Sentinel's. It says
        # so, in the preflight, and does not get as far as the history.
        status, stderr, finished, block = self.apply()
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertIn("the separate logins are supported on a PostgreSQL cluster of their own only", stderr)
        self.assertIn(expected, stderr)
        self.assertNotIn("state C", stderr)
        # The migrate service reads the history first too. (web cannot log in as a role that has no name.)
        result = self.migrate_service()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("the database roles differ from what Sentinel provisions", result.stderr)
        self.assertIn("state C", result.stderr)
        self.assertNotIn(STARTED, result.stdout)
        result = self.web()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("authentication failed", result.stderr)
        self.assertNotIn(STARTED, result.stdout)

        # The assertions of the rehearsal, which run these same commands, ask for exactly that: and the one
        # that asked for state C of apply does not hold.
        for command, message in (("status", "state C"), ("apply", "$RENAMED_ROLE_REFUSAL")):
            result = self.shell(f'refused_by "{message}" scripts/postgres-roles.sh {command}')
            self.assertEqual(result.returncode, 0, result.stderr)
        result = self.shell('refused_by "state C" scripts/postgres-roles.sh apply')
        self.assertEqual(result.returncode, 1)
        self.assertIn("refused, but not with: state C", result.stderr)

        # None of it changed anything: not a privilege, a password, the record, an owner, a role.
        self.assertEqual(self.shell("fingerprint").stdout, renamed)
        self.assertEqual(self.password_digests(), digests)
        self.assertEqual(self.value("SELECT obj_description('sentinel_restricted'::regnamespace, 'pg_namespace')"), record)
        self.assertEqual(self.owners(), owners)
        self.assertEqual(self.value("SELECT count(*) FROM pg_roles WHERE rolname = ANY (%s)",
                                    ["sentinel_owner", "sentinel_migrate", "sentinel_app", "sentinel_app_gone"]), 3)
        # Renamed back, it is what it was.
        self.execute("ALTER ROLE sentinel_app_gone RENAME TO sentinel_app")
        self.assertEqual(self.shell("fingerprint").stdout, original)
        self.assertSucceeds(self.status)
        self.assertSucceeds(self.apply)

    def test_the_other_ways_to_make_the_installation_state_c_are_state_c_to_status_and_apply(self):
        # The record changed, the record missing: all the roles are Sentinel's, so the topology is as it should be
        # and the history is what is wrong.
        self.restricted_installation()
        record = self.value("SELECT obj_description('sentinel_restricted'::regnamespace, 'pg_namespace')")
        for name, change, undo in (
            ("record changed", "COMMENT ON SCHEMA sentinel_restricted IS 'e2e altered'",
             f"COMMENT ON SCHEMA sentinel_restricted IS '{record}'"),
            ("record missing", "DROP SCHEMA sentinel_restricted",
             f"CREATE SCHEMA sentinel_restricted; COMMENT ON SCHEMA sentinel_restricted IS '{record}'"),
        ):
            with self.subTest(name):
                self.execute(change)
                status, stderr, finished, block = self.apply()
                self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
                self.assertIn("state C", stderr)
                self.assertNotIn("this cluster also has", stderr)
                for command in ("status", "apply"):
                    result = self.shell(f'refused_by "state C" scripts/postgres-roles.sh {command}')
                    self.assertEqual(result.returncode, 0, result.stderr)
                result = self.migrate_service()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("state C", result.stderr)
                self.execute(undo)
                self.assertSucceeds(self.status)

    # --- the provisioning, cut short

    def test_a_provisioning_held_in_its_transaction_and_cut_off_changes_nothing(self):
        names = self.legacy_installation()  # tables of the bootstrap superuser, to hand over
        before, owners = self.shell("fingerprint").stdout, self.owners()
        program = db_roles.apply_program(self.database, *self.passwords, names)
        held = self.shell("hold_provisioning", input=program.sql).stdout
        self.assertEqual(held.count(INJECTED), 1)
        self.assertEqual(held.replace(INJECTED + "\n", ""), program.sql)
        self.assertEqual(held.index(INJECTED), program.sql.index("$sentinel_ownership$;\n") + len("$sentinel_ownership$;\n"))

        command, environment = self.psql()
        client = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        self.addCleanup(client.kill)
        client.stdin.write(held)
        client.stdin.close()
        deadline = time.monotonic() + 60
        while self.shell("holds_provisioning").returncode != 0:
            self.assertLess(time.monotonic(), deadline, "the program did not reach its wait")
            self.assertIsNone(client.poll(), "the program ended: " + client.stderr.read())
            time.sleep(0.2)
        # Nobody else sees what a transaction that has not committed has done.
        self.assertEqual(self.value("SELECT count(*) FROM pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 0)
        self.assertEqual(self.owners(), owners)
        (pid,) = [pid for (pid,) in self.execute(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 0 AND objid = 4243 AND objsubid = 1")]
        self.execute("SELECT pg_terminate_backend(%s)", pid)
        stdout, _ = client.communicate(timeout=60)
        self.assertNotIn("sentinel-roles: committed", stdout)

        self.assertUnprovisioned()
        self.assertEqual(self.owners(), owners)
        self.assertEqual(self.shell("fingerprint").stdout, before)
        self.assertEqual(self.shell("managed_roles").stdout.strip(), "0")
        self.assertEqual(self.shell("marker").stdout.strip(), "0")
        self.assertSucceeds(lambda: self.apply(*names))  # the provisioning that follows is untouched
        self.assertEqual(self.owners(), "sentinel_owner")

    def test_a_program_without_an_ownership_block_is_refused_the_hold(self):
        # Nothing, only the start of the block, or the block twice: one place to wait in, or none.
        for program in ("BEGIN;\nCOMMIT;\n", "DO $sentinel_ownership$\nBEGIN\nEND\n", "$sentinel_ownership$;\n$sentinel_ownership$;\n"):
            with self.subTest(program):
                result = self.shell("hold_provisioning", input=program)
                self.assertEqual(result.returncode, 1)
                self.assertIn("FAIL: the provisioning program has no ownership block to wait in", result.stderr)

    def test_a_lost_acknowledgement_is_said_to_be_provisioned_and_apply_again_converges(self):
        shim = self.directory / "shim"
        self.assertEqual(self.shell(f'lose_acknowledgement "{shim}"').returncode, 0)
        self.assertTrue(os.access(shim / "docker", os.X_OK))
        environment = self.script_environment({"PATH": os.pathsep.join([str(shim), self.script_environment()["PATH"]])})
        script = ROOT / "scripts" / "postgres-roles.sh"
        result = subprocess.run(["bash", str(script), "apply"], cwd=ROOT, env=environment, capture_output=True, text=True,
                                timeout=120, check=False)
        self.assertEqual((result.returncode, result.stdout), (1, ""), result.stderr)
        self.assertIn("postgres-roles: apply did not finish (status 0)", result.stderr)
        self.assertIn("postgres-roles: the database is provisioned (schema sentinel_restricted exists)", result.stderr)
        self.assertNotIn("nothing was committed", result.stderr)
        self.assertEqual(self.value("SELECT count(*) FROM pg_roles WHERE rolname = ANY (%s)", list(ROLES)), 3)
        self.assertTrue(self.marked())
        # The shim is for the one apply: the roles, as the program left them, verify without it.
        plain = self.script_environment()
        status = subprocess.run(["bash", str(script), "status"], cwd=ROOT, env=plain, capture_output=True, text=True,
                                timeout=120, check=False)
        self.assertEqual((status.returncode, status.stdout), (0, "postgres-roles: status: verified\n"), status.stderr)
        again = subprocess.run(["bash", str(script), "apply"], cwd=ROOT, env=plain, capture_output=True, text=True,
                               timeout=120, check=False)
        self.assertEqual((again.returncode, again.stdout), (0, "postgres-roles: apply: committed\n"), again.stderr)

    def test_the_revocations_of_the_documentation_open_the_first_provisioning(self):
        # What PUBLIC holds in a new cluster, in the databases of this test (the class took it away).
        for statement in (
            "GRANT CONNECT, TEMPORARY ON DATABASE postgres TO PUBLIC",
            f'GRANT TEMPORARY ON DATABASE "{self.database}" TO PUBLIC',
            "GRANT EXECUTE ON FUNCTION pg_catalog.lo_creat(integer), pg_catalog.lo_create(oid),"
            " pg_catalog.lo_from_bytea(oid, bytea) TO PUBLIC",
        ):
            self.execute(statement)
        status, stderr, finished, block = self.apply()
        self.assertEqual((status, finished, block), (3, False, "sentinel_preflight"), stderr)
        self.assertEqual(self.shell("revoke_public").returncode, 0)
        self.assertSucceeds(self.apply)

    def test_refused_by_needs_a_failure_that_says_what_it_should_and_prints_nothing_else(self):
        self.assertEqual(self.shell("refused_by boom bash -c 'echo boom >&2; exit 1'").returncode, 0)
        for command, message in (("true", "this must be refused"), ("bash -c 'echo out; echo boom >&2; exit 1'", "standard output"),
                                 ("bash -c 'echo other >&2; exit 1'", "refused, but not with: boom")):
            with self.subTest(command):
                result = self.shell(f"refused_by boom {command}")
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)

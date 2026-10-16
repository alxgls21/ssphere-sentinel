"""The harness of the PostgreSQL-backed tests (apps/core/tests/*_postgres.py), checked without a
cluster: what CI asks of them, which of them the postgres job of .github/workflows/ci.yml runs,
and the password a process they start is given. Every test class of those modules needs the
cluster, so that a module passes the job only if tests that need it ran there
(.github/scripts/postgres-tests-report.py); what needs none is here, which the Server job runs.
"""

import os
import unittest
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase
from psycopg.conninfo import conninfo_to_dict

import apps.core.tests.test_db_roles_postgres as harness
from apps.core.tests.test_database_startup_postgres import psql_import_command

ROOT = Path(__file__).resolve().parents[3]


class HarnessTests(SimpleTestCase):
    """What CI asks of the tests (SENTINEL_TEST_STRICT, SENTINEL_TEST_POSTGRES_MAJOR): nothing
    skipped, and the server and its programs of the major version named."""

    def test_strict_mode_runs_what_would_be_skipped_and_fails_a_skip(self):
        with mock.patch.object(harness, "STRICT", False):
            self.assertTrue(getattr(harness.required(False, "absent")(type("Probe", (), {})), "__unittest_skip__", False))
        with mock.patch.object(harness, "STRICT", True):
            self.assertFalse(getattr(harness.required(False, "absent")(type("Probe", (), {})), "__unittest_skip__", False))
            with self.assertRaisesMessage(AssertionError, "skipped under SENTINEL_TEST_STRICT=1: no tablespace here"):
                harness.TemporaryPrivilegeTests("test_an_explicit_grant_to_the_runtime_role_is_refused").skipTest("no tablespace here")
        with mock.patch.object(harness, "STRICT", False), self.assertRaises(unittest.SkipTest):
            harness.TemporaryPrivilegeTests("test_an_explicit_grant_to_the_runtime_role_is_refused").skipTest("no tablespace here")

    def test_the_server_and_its_programs_must_be_of_the_major_version_named(self):
        connection = mock.MagicMock()
        connection.execute.return_value.fetchone.return_value = (18,)
        majors = {"psql": "18", "pg_dump": "16", "pg_restore": "18", "initdb": None, "pg_ctl": "18"}
        with mock.patch.object(harness, "client_major", majors.get), \
                mock.patch.object(harness, "wrapped", lambda program: program == "pg_ctl"):
            with mock.patch.object(harness, "MAJOR", "16"), mock.patch.object(harness, "STRICT", True):
                self.assertEqual(harness.strict_requirements(connection), [
                    "the server is PostgreSQL 18, not 16", "psql is from PostgreSQL 18, not 16",
                    "pg_restore is from PostgreSQL 18, not 16", "initdb is not installed", "pg_ctl is from PostgreSQL 18, not 16",
                ])
            with mock.patch.object(harness, "MAJOR", "18"), mock.patch.object(harness, "STRICT", True):
                self.assertEqual(harness.strict_requirements(connection), [
                    "pg_dump is from PostgreSQL 16, not 18", "initdb is not installed",
                    "pg_ctl is Debian's pg_wrapper: put the programs of PostgreSQL 18 first on PATH",
                ])
            # Outside CI: what is there must match a version named; nothing else is asked.
            unasked = mock.MagicMock()
            with mock.patch.object(harness, "MAJOR", ""), mock.patch.object(harness, "STRICT", False):
                self.assertEqual(harness.strict_requirements(unasked), [])
                unasked.execute.assert_not_called()


class ChildConnectionTests(SimpleTestCase):
    """A process the tests start as one of the logins authenticates with that login's password,
    whatever SENTINEL_TEST_POSTGRES holds: a password there is the bootstrap superuser's, never
    inherited by the child, and never on a command line."""

    def test_the_bootstrap_password_stays_out_of_the_child(self):
        for server in ("host=db.example port=5433 user=postgres password=bootstrap-secret dbname=postgres",
                       "host=db.example port=5433 user=postgres dbname=postgres"):
            for user, password, role in (("sentinel_app", "app-secret", None),
                                         ("sentinel_migrate", "migrate-secret", "sentinel_owner")):
                with self.subTest(password_in_dsn="password=" in server, user=user), \
                        mock.patch.dict(os.environ, {"PGPASSWORD": "bootstrap-secret", "PGOPTIONS": "-c role=postgres",
                                                     "SENTINEL_TEST_POSTGRES": server}):
                    command, environment = psql_import_command(server, "sentinel-x", user, password, role, "/tmp/probe")
                    self.assertNotIn("bootstrap-secret", " ".join(command))
                    self.assertEqual([name for name, value in environment.items() if "bootstrap-secret" in value], [])
                    self.assertEqual(conninfo_to_dict(command[command.index("-d") + 1]),
                                     {"host": "db.example", "port": "5433", "user": user, "dbname": "sentinel-x"})
                    self.assertEqual(environment["PGPASSWORD"], password)
                    self.assertEqual(environment.get("PGOPTIONS"), f"-c role={role}" if role else None)


class SelectionTests(SimpleTestCase):
    """The postgres job runs the modules apps/core/tests/*_postgres.py (.github/scripts/postgres-tests.sh,
    which finds them by name); everywhere else their tests are skipped. A test that needs the cluster
    in another module would be skipped by every job, and CI would pass without it."""

    def test_what_needs_the_cluster_is_in_the_job_s_modules_and_all_they_test_needs_it(self):
        selected = {".".join(path.relative_to(ROOT).with_suffix("").parts)
                    for path in (ROOT / "apps" / "core" / "tests").rglob("*_postgres.py")}
        self.assertGreaterEqual(len(selected), 3)
        needing = dict.fromkeys(selected, 0)

        def tests(suite):
            for test in suite:
                yield from tests(test) if isinstance(test, unittest.TestSuite) else (test,)

        # The tests of the server, as the Server job finds them (manage.py test apps), by their classes.
        for test in tests(unittest.defaultTestLoader.discover(str(ROOT / "apps"), top_level_dir=str(ROOT))):
            cls = type(test)
            if cls.__name__ == "_FailedTest":  # a module that does not load: the runner says so
                continue
            with self.subTest(f"{cls.__module__}.{cls.__qualname__}"):
                if isinstance(test, harness.DisposableClusterTestCase):
                    self.assertIn(cls.__module__, selected, "it needs the cluster, but the postgres job does not run its module")
                    needing[cls.__module__] += 1
                else:
                    self.assertNotIn(cls.__module__, selected,
                                     "it needs no cluster: it belongs in a module the Server job runs, not the postgres job's")
        for module, count in sorted(needing.items()):
            self.assertTrue(count, f"{module} holds no test that needs the cluster")

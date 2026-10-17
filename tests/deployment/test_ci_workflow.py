"""The jobs of .github/workflows/ci.yml: what each needs, and what it runs.

The Server job installs what the server tests need. Some server tests run the
real agent against the live test server (apps/snmp/tests/test_agent_*.py,
apps/agents/tests/test_request_body_limit.py). The agent is its own
distribution and needs ``psutil``, which the server neither has nor should
have: a cell that installs only the server fails on the import of
``agent.telemetry``. The agent therefore belongs to the *test* environment of
every cell, and never to the server's dependencies.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests.deployment.helpers import load_workflow

ROOT = Path(__file__).resolve().parents[2]


def server_tests_that_import_the_agent() -> list[str]:
    pattern = re.compile(r"^\s*(?:from|import) +agent(?:[. ]|$)", re.M)
    return sorted(
        str(path.relative_to(ROOT))
        for path in (ROOT / "apps").rglob("test*.py")
        if pattern.search(path.read_text())
    )


class ServerJobTests(unittest.TestCase):
    def setUp(self):
        workflow = load_workflow(self)
        self.job = workflow["jobs"]["server"]
        self.steps = self.job["steps"]

    def step_index(self, predicate) -> int:
        return next(i for i, step in enumerate(self.steps) if predicate(step))

    def test_the_server_tests_that_run_the_agent_exist(self):
        # The rule below is about these tests; if they are gone, so is the need.
        tests = server_tests_that_import_the_agent()
        self.assertIn("apps/snmp/tests/test_agent_request_budget.py", tests)

    def test_every_matrix_cell_installs_the_agent_before_the_tests(self):
        installs = [
            i
            for i, step in enumerate(self.steps)
            if "if" not in step and re.search(r"pip install\s+.*\./agent\b", step.get("run", ""))
        ]
        self.assertTrue(
            installs,
            "no step without a condition installs ./agent: the cells that skip it cannot import agent.telemetry (psutil)",
        )
        tests = self.step_index(lambda step: step.get("run", "").strip() == "python manage.py test apps")
        self.assertLess(installs[0], tests)

    def test_the_server_is_installed_without_the_agents_dependency(self):
        (server,) = [step for step in self.steps if step.get("name") == "Install the server"]
        # The server's own install stays the server's: psutil is not smuggled in with it.
        self.assertNotIn("psutil", server["run"])
        self.assertNotIn("./agent", server["run"])

    def test_the_server_does_not_depend_on_psutil(self):
        # psutil is the agent's requirement (agent/pyproject.toml). The server
        # distribution and the image's hash-pinned lock must stay free of it;
        # tests/packaging pins the exact dependency set.
        for path in ("pyproject.toml", "requirements/server.txt"):
            with self.subTest(path=path):
                self.assertNotRegex((ROOT / path).read_text().lower(), r"\bpsutil\b")
        self.assertIn("psutil", (ROOT / "agent" / "pyproject.toml").read_text())


class ComposeCompatibilityJobTests(unittest.TestCase):
    """The job that checks, with each Docker Compose release, that configurations resolve and that an
    installation of the previous release is updated and rolled back."""

    SCRIPTS = sorted([*(ROOT / ".github" / "scripts").glob("*.sh"), *(ROOT / "scripts").glob("*.sh")])

    def setUp(self):
        workflow = load_workflow(self)
        self.job = workflow["jobs"]["compose-compatibility"]
        self.runs = [step.get("run", "").strip() for step in self.job["steps"]]

    def test_every_compose_release_runs_the_checks_in_order(self):
        self.assertEqual(self.job["strategy"]["matrix"]["compose"], ["2.24.6", "5.6.0"])
        order = [
            '.github/scripts/install-compose.sh "${{ matrix.compose }}"',
            ".github/scripts/compose-config-check.sh",
        ]
        positions = [self.runs.index(run) for run in order]
        self.assertEqual(positions, sorted(positions))
        self.assertTrue(any("compose-upgrade-e2e.sh" in run for run in self.runs))
        for step in self.job["steps"]:
            self.assertNotIn("if", step)
            self.assertNotIn("continue-on-error", step)
        # The separate database logins run on the same releases in a job of their own (test_compose_e2e.py).
        self.assertFalse(any("separate-roles-e2e.sh" in run for run in self.runs))

    def test_the_scripts_are_executable_and_parse(self):
        import shutil
        import subprocess

        bash = shutil.which("bash")
        for path in self.SCRIPTS:
            with self.subTest(script=str(path.relative_to(ROOT))):
                self.assertTrue(path.stat().st_mode & 0o111, "not executable")
                self.assertTrue(path.read_text().startswith("#!/usr/bin/env bash\n"))
                self.assertIn("set -euo pipefail", path.read_text())
                if bash:
                    result = subprocess.run([bash, "-n", str(path)], capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_rehearsal_passes_sql_as_data(self):
        # Code built from a statement breaks on its quotes (and runs what they let in).
        script = (ROOT / ".github" / "scripts" / "separate-roles-e2e.sh").read_text()
        helper = re.search(r"web_sql\(\) \{.*?\n\}", script, re.S)[0]
        self.assertIn('docker compose exec -T --env "WEB_SQL=$1" web python manage.py shell', helper)
        self.assertIn('-c "$(cat .github/scripts/web_sql.py)"', helper)
        self.assertEqual(helper.count("$1"), 1)
        program = (ROOT / ".github" / "scripts" / "web_sql.py").read_text()
        compile(program, "web_sql.py", "exec")
        self.assertIn('cursor.execute(os.environ["WEB_SQL"])', program)
        for name in ("separate-roles-e2e.sh", "compose-config-check.sh"):
            text = (ROOT / ".github" / "scripts" / name).read_text()
            for match in re.finditer(r'(?:python3?|shell[^\n]*?) -c "([^"]*)"', text):
                self.assertNotRegex(match[1], r"\$(?!\(cat \.github/scripts/)", match[0])

    def test_the_rehearsal_provisions_as_documented_and_checks_each_container(self):
        script = (ROOT / ".github" / "scripts" / "separate-roles-e2e.sh").read_text()
        self.assertNotIn("CREATE ROLE", script)
        self.assertIn("scripts/postgres-roles.sh apply", script)
        self.assertIn("scripts/postgres-roles.sh status", script)
        # What each container holds: Docker's view of its environment, and its processes' own.
        self.assertIn("for service in web migrate db alert-engine; do", script)
        # The alert engine is stopped with web wherever the roles are provisioned or changed.
        self.assertNotIn("docker compose stop web\n", script)
        self.assertIn("docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \"$id\" > \"$dir/$service.env\"", script)
        self.assertIn("PROCESS_DUMP=", script)
        self.assertIn('docker compose exec -T web sh -c "$PROCESS_DUMP"', script)
        self.assertIn('docker compose exec -T -u postgres db sh -c "$PROCESS_DUMP"', script)
        self.assertIn("docker compose logs --no-color", script)


class PostgresJobTests(unittest.TestCase):
    """The job that runs the separate database logins against real PostgreSQL 16 and 18
    (apps/core/tests/*_postgres.py): each major version, strictly, in both ways the tests can
    be given the bootstrap password, on a disposable cluster of their own."""

    SCRIPT = ROOT / ".github" / "scripts" / "postgres-tests.sh"
    TESTS_IF = "${{ !cancelled() && steps.cluster.outcome == 'success' }}"

    def setUp(self):
        workflow = load_workflow(self)
        self.job = workflow["jobs"]["postgres"]
        self.steps = self.job["steps"]
        self.runs = [step.get("run", "").strip() for step in self.steps]

    def test_every_supported_major_runs_with_both_django_lines_and_no_cell_may_fail(self):
        self.assertEqual(self.job["strategy"]["matrix"], {"postgres": ["16", "18"], "django": ["5.2", "6.1"]})
        self.assertIs(self.job["strategy"]["fail-fast"], False)
        self.assertNotIn("continue-on-error", self.job)
        for step in self.steps:
            self.assertNotIn("continue-on-error", step)
        self.assertEqual(self.job["defaults"]["run"]["shell"], "bash")

    def test_the_programs_and_the_tests_are_of_the_cell_s_major_version(self):
        env = self.job["env"]
        self.assertEqual(env["SENTINEL_TEST_POSTGRES_MAJOR"], "${{ matrix.postgres }}")
        self.assertEqual(env["POSTGRES_BINDIR"], "/usr/lib/postgresql/${{ matrix.postgres }}/bin")
        self.assertEqual(env["SENTINEL_TEST_PORT"], "543${{ matrix.postgres }}")
        (install,) = [run for run in self.runs if "apt.postgresql.org.sh" in run]
        self.assertIn('apt-get install --yes --no-install-recommends "postgresql-${{ matrix.postgres }}"', install)
        self.assertIn("create_main_cluster = false", install)
        self.assertIn('"$POSTGRES_BINDIR/postgres" --version', install)
        self.assertIn('Django==${{ matrix.django }}.*', "\n".join(self.runs))

    def test_django_s_own_database_is_neither_needed_nor_reachable(self):
        # No service container; the settings name a port nothing listens on.
        self.assertNotIn("services", self.job)
        self.assertEqual(self.job["env"]["POSTGRES_HOST"], "127.0.0.1")
        self.assertEqual(self.job["env"]["POSTGRES_PORT"], "9")

    def test_the_cluster_starts_both_runs_follow_and_it_is_always_removed(self):
        order = [".github/scripts/postgres-tests.sh start", ".github/scripts/postgres-tests.sh run password-free",
                 ".github/scripts/postgres-tests.sh run password-in-dsn", ".github/scripts/postgres-tests.sh stop"]
        positions = [self.runs.index(run) for run in order]
        self.assertEqual(positions, sorted(positions))
        start, free, dsn, stop = (self.steps[position] for position in positions)
        self.assertEqual(start["id"], "cluster")
        self.assertNotIn("if", start)
        self.assertEqual((free["if"], dsn["if"]), (self.TESTS_IF, self.TESTS_IF))
        self.assertEqual(stop["if"], "always()")
        (log,) = [step for step in self.steps if step.get("name") == "Server log"]
        self.assertEqual(log["if"], "failure() || cancelled()")
        self.assertLess(self.steps.index(log), positions[-1])

    def test_the_script_runs_every_postgres_module_strictly_and_judges_the_run(self):
        script = self.SCRIPT.read_text()
        strict = '\n        export PATH="$POSTGRES_BINDIR:$PATH" SENTINEL_TEST_STRICT=1 PYTHONDONTWRITEBYTECODE=1\n'
        tests = '"$python" manage.py test'
        self.assertEqual(script.count(strict), 1)
        # In the run branch, before the tests.
        self.assertLess(script.index("\n    run)\n"), script.index(strict))
        self.assertLess(script.index(strict), script.index(tests))
        self.assertLess(script.index(tests), script.index("\n    stop)\n"))
        self.assertIn("find apps/core/tests -name '*_postgres.py'", script)
        self.assertIn('"$python" manage.py test --noinput -v 2 "${modules[@]}" 2>&1 | tee "$log" || status=$?', script)
        self.assertIn('--server "PostgreSQL $version" "${modules[@]}" || status=1', script)
        self.assertGreaterEqual(len(list((ROOT / "apps" / "core" / "tests").glob("*_postgres.py"))), 3)
        # Each way to give the tests the password, and only that way.
        self.assertIn('password-free) export SENTINEL_TEST_POSTGRES="$dsn" PGPASSWORD;', script)
        self.assertIn('password-in-dsn) export SENTINEL_TEST_POSTGRES; SENTINEL_TEST_POSTGRES="$dsn password=$(cat '
                      '"$password_file")"; unset PGPASSWORD ;;', script)
        # A cluster of its own, of the cell's major version, its password masked in the log.
        self.assertIn('[ "$major" != "$SENTINEL_TEST_POSTGRES_MAJOR" ]', script)
        self.assertIn('--auth=scram-sha-256 --pwfile="$password_file"', script)
        self.assertIn('echo "::add-mask::$(cat "$password_file")"', script)

    def test_the_harness_fails_what_strict_mode_would_otherwise_skip(self):
        harness = (ROOT / "apps" / "core" / "tests" / "test_db_roles_postgres.py").read_text()
        self.assertIn('STRICT = os.environ.get("SENTINEL_TEST_STRICT", "") == "1"', harness)
        self.assertIn('@required(SERVER, "SENTINEL_TEST_POSTGRES names no disposable PostgreSQL cluster")', harness)
        self.assertIn('self.fail(f"skipped under SENTINEL_TEST_STRICT=1: {reason}")', harness)
        self.assertNotIn("@unittest.skip", harness)
        for name in ("test_database_guard_postgres.py", "test_database_startup_postgres.py"):
            module = (ROOT / "apps" / "core" / "tests" / name).read_text()
            self.assertNotIn("@unittest.skip", module, name)
            self.assertNotIn("raise unittest.SkipTest", module, name)


class PostgresTestReportTests(unittest.TestCase):
    """.github/scripts/postgres-tests-report.py: a run passes only if every module named ran
    tests and every test passed, none skipped."""

    MODULES = ["apps.core.tests.test_a_postgres", "apps.core.tests.test_b_postgres"]

    def setUp(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("report", ROOT / ".github" / "scripts" / "postgres-tests-report.py")
        self.report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.report)

    def log(self, lines=None, ran=None, summary="OK", extra=""):
        lines = lines if lines is not None else [
            "test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... ok",
            "test_two (apps.core.tests.test_a_postgres.ATests.test_two) ... ok",
            "test_three (apps.core.tests.test_b_postgres.BTests.test_three) ... ok",
        ]
        ran = len(lines) if ran is None else ran
        return "\n".join(["Skipping setup of unused database(s): default.", *lines, "",
                          "-" * 70, f"Ran {ran} tests in 1.234s", "", summary, extra])

    def problems(self, log, modules=None):
        return self.report.judge(log, modules or self.MODULES)[0]

    def test_a_clean_run_passes_and_is_counted_per_module(self):
        problems, outcomes, total = self.report.judge(self.log(), self.MODULES)
        self.assertEqual((problems, total), ([], 3))
        self.assertEqual({module: counts["ok"] for module, counts in outcomes.items()},
                         {self.MODULES[0]: 2, self.MODULES[1]: 1})

    def test_a_test_with_a_docstring_is_counted_on_its_second_line(self):
        # unittest prints the first line of a test's docstring after its name, on a line of its own.
        log = self.log(lines=["test_one (apps.core.tests.test_a_postgres.ATests.test_one)",
                              "What the test says it checks. ... ok",
                              "test_two (apps.core.tests.test_a_postgres.ATests.test_two) ... ok",
                              "test_three (apps.core.tests.test_b_postgres.BTests.test_three)",
                              "Another description. ... skipped 'no psql'"], ran=3, summary="OK (skipped=1)")
        problems, outcomes, total = self.report.judge(log, self.MODULES)
        self.assertEqual(outcomes[self.MODULES[0]]["ok"], 2)
        self.assertEqual(outcomes[self.MODULES[1]]["skipped"], 1)
        self.assertIn(f"{self.MODULES[1]}: 1 skipped", problems)

    def test_whatever_is_not_a_pass_fails_the_run(self):
        cases = {
            "a skip": self.log(lines=["test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... skipped 'no psql'",
                                      "test_three (apps.core.tests.test_b_postgres.BTests.test_three) ... ok"],
                               summary="OK (skipped=1)"),
            "a failure": self.log(lines=["test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... FAIL",
                                         "test_three (apps.core.tests.test_b_postgres.BTests.test_three) ... ok"],
                                  summary="FAILED (failures=1)"),
            "an error": self.log(lines=["test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... ERROR",
                                        "test_three (apps.core.tests.test_b_postgres.BTests.test_three) ... ok"],
                                 summary="FAILED (errors=1)"),
            "an expected failure": self.log(lines=[
                "test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... expected failure",
                "test_three (apps.core.tests.test_b_postgres.BTests.test_three) ... ok"], summary="OK (expected failures=1)"),
            "a module that could not load": self.log(extra="ERROR: test_a_postgres (unittest.loader._FailedTest.test_a_postgres)"),
            "a class not set up": self.log(extra="ERROR: setUpClass (apps.core.tests.test_a_postgres.ATests)"),
            "Django's own test database": self.log(extra="Creating test database for alias 'default'..."),
            "a module that ran nothing": self.log(lines=[
                "test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... ok"]),
            "a module not asked for": self.log(lines=[
                *self.log().splitlines()[1:4], "test_x (apps.core.tests.test_c_postgres.CTests.test_x) ... ok"]),
            "a count that does not add up": self.log(ran=4),
            "no summary": self.log(summary=""),
            "nothing ran": self.log(lines=[], ran=0),
            "a result line cut by other output": self.log(lines=[
                "test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... pg_dump: warning: something", "ok",
                *self.log().splitlines()[2:4]]),
        }
        for name, log in cases.items():
            with self.subTest(name):
                self.assertTrue(self.problems(log), name)
        self.assertIn(f"{self.MODULES[0]}: 1 result line(s) cut by other output",
                      self.problems(cases["a result line cut by other output"]))
        self.assertIn(f"{self.MODULES[0]}: 1 expected failure", self.problems(cases["an expected failure"]))

    def test_a_failed_subtest_is_counted_as_its_failure(self):
        # unittest ends the test's line at "... " and prints each failed subtest under it.
        log = self.log(lines=["test_one (apps.core.tests.test_a_postgres.ATests.test_one) ... ",
                              "  test_one (apps.core.tests.test_a_postgres.ATests.test_one) (case='x') ... FAIL",
                              "  test_one (apps.core.tests.test_a_postgres.ATests.test_one) (case='y') ... ERROR",
                              *self.log().splitlines()[2:4]], ran=3, summary="FAILED (failures=1, errors=1)")
        problems, outcomes, total = self.report.judge(log, self.MODULES)
        self.assertEqual(dict(outcomes[self.MODULES[0]]), {"FAIL": 1, "ERROR": 1, "ok": 1})
        self.assertIn(f"{self.MODULES[0]}: 1 ERROR, 1 FAIL", problems)
        self.assertNotIn(self.report.INTERLEAVED, " ".join(problems))

    def test_the_command_exits_non_zero_and_writes_the_job_summary(self):
        import io
        import os
        import tempfile
        from contextlib import redirect_stdout
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            log, summary = Path(directory) / "tests.log", Path(directory) / "summary.md"
            for text, status in ((self.log(), 0), (self.log(summary="OK (skipped=1)"), 1)):
                with self.subTest(status=status):
                    log.write_text(text)
                    with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), redirect_stdout(io.StringIO()):
                        result = self.report.main(["--log", str(log), "--mode", "password-free",
                                                   "--server", "PostgreSQL 16.4", *self.MODULES])
                    self.assertEqual(result, status)
            written = summary.read_text()
            self.assertIn("### PostgreSQL 16.4, password-free: 3 tests, passed", written)
            self.assertIn("### PostgreSQL 16.4, password-free: 3 tests, FAILED", written)
            self.assertIn(f"| `{self.MODULES[0]}` | 2 |", written)


if __name__ == "__main__":
    unittest.main()

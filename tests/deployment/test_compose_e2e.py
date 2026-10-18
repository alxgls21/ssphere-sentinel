"""The judgement of the Compose rehearsal (.github/scripts/compose_e2e.py), and the shape of the
rehearsal itself (.github/scripts/separate-roles-e2e.sh) and of the CI job that runs it.

The rehearsal needs Docker, which these tests never start: what Docker would show is given to
the judge as files, and the script and the job are read as text. That the real commands do what
the script expects of them remains for the CI job to show.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from tests.deployment.helpers import load_workflow, logical_lines, write_executable

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".github" / "scripts"
SCRIPT = SCRIPTS / "separate-roles-e2e.sh"


def load():
    spec = importlib.util.spec_from_file_location("compose_e2e", SCRIPTS / "compose_e2e.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


e2e = load()

RUNTIME, MIGRATION, BOOTSTRAP = "runtime-" + "r" * 40, "migration-" + "m" * 40, "bootstrap-" + "b" * 40
DJANGO, PEPPER, OLD = "django-" + "d" * 40, "pepper-" + "p" * 40, "retired-" + "o" * 40
SECRETS = {"runtime": [RUNTIME], "migration": [MIGRATION], "bootstrap": [BOOTSTRAP], "django": [DJANGO],
           "pepper": [PEPPER], "retired": [OLD]}


def environments(**changes):
    """What docker inspect prints of each container's environment, as the stack should give it."""
    base = {
        "web": {"DJANGO_SECRET_KEY": DJANGO, "AGENT_TOKEN_PEPPER": PEPPER, "SENTINEL_DB_PASSWORD": RUNTIME,
                "SENTINEL_DB_MIGRATE_PASSWORD": "", "SENTINEL_DB_ACCESS": "runtime", "PATH": "/usr/bin"},
        "migrate": {"DJANGO_SECRET_KEY": DJANGO, "AGENT_TOKEN_PEPPER": PEPPER, "SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION,
                    "SENTINEL_DB_PASSWORD": "", "SENTINEL_DB_ACCESS": "migrate", "GPG_KEY": "7169605F62C751356D054A26"},
        "db": {"POSTGRES_PASSWORD": BOOTSTRAP, "POSTGRES_USER": "sentinel", "PG_MAJOR": "18"},
        "alert-engine": {"DJANGO_SECRET_KEY": DJANGO, "AGENT_TOKEN_PEPPER": PEPPER, "SENTINEL_DB_PASSWORD": RUNTIME,
                         "SENTINEL_DB_MIGRATE_PASSWORD": "", "SENTINEL_SMTP_PASSWORD": "", "SENTINEL_DB_ACCESS": "runtime",
                         "SENTINEL_PROCESS": "worker"},
        "proxy": {"NGINX_VERSION": "1.30.0", "PATH": "/usr/sbin:/usr/bin"},
    }
    for service, edits in changes.items():
        for name, value in edits.items():
            if value is None:
                base[service].pop(name, None)
            else:
                base[service][name] = value
    return base


def block(pid, command, environment=""):
    """A process of a dump, as the rehearsal collects it."""
    return f"## {pid} {command}\n{environment}\n\n"


def write_evidence(directory, env=None, **files):
    """An evidence directory as the rehearsal collects it, the files named in ``files`` replaced."""
    env = env or environments()
    base = Path(directory)
    for service, variables in env.items():
        (base / f"{service}.env").write_text("".join(f"{name}={value}\n" for name, value in variables.items()))
        (base / f"{service}.mounts").write_text("[]" if service != "db" else json.dumps(
            [{"Type": "volume", "Name": "x_postgres18_data", "Source": "/var/lib/docker/volumes/x_postgres18_data/_data"}]))
    exec_shell = block(91, "sh -c for p in /proc/[0-9]*", "SENTINEL_DB_ACCESS=runtime\nPG_MAJOR=18")  # what collects the dump
    contents = {
        "web.processes": block(1, "/sbin/docker-init -- ./entrypoint.sh gunicorn", "PATH=/usr/bin")
        + block(7, "/opt/venv/bin/python /opt/venv/bin/gunicorn --bind 0.0.0.0:8000 sentinel.wsgi:application",
                f"SENTINEL_DB_ACCESS=runtime\nSENTINEL_DB_PASSWORD={RUNTIME}\nDJANGO_SECRET_KEY={DJANGO}") + exec_shell,
        "db.processes": block(1, "postgres", f"PG_MAJOR=18\nPOSTGRES_PASSWORD={BOOTSTRAP}")
        + block(40, "postgres: checkpointer") + exec_shell,
        "logs": "web-1  | listening\nmigrate-1  | entrypoint: verifying the privileges of the runtime login\n",
        "web.files": "",
    }
    contents.update(files)
    for name, text in contents.items():
        (base / name).write_text(text)


def secrets_file(directory, secrets=None):
    path = Path(directory) / "secrets.json"
    path.write_text(json.dumps(secrets or SECRETS))
    return str(path)


class IsolationTests(unittest.TestCase):
    def judge(self, env=None, secrets=None, **files):
        with tempfile.TemporaryDirectory() as directory:
            write_evidence(directory, env, **files)
            return e2e.isolation(directory, secrets_file(directory, secrets))

    def test_each_container_with_its_own_secrets_only_passes(self):
        self.assertEqual(self.judge(), [])

    def test_a_secret_that_is_not_the_service_s_own_is_found_wherever_it_is(self):
        cases = {
            "web has the bootstrap password": (dict(env=environments(web={"POSTGRES_PASSWORD": BOOTSTRAP})),
                                               "web: POSTGRES_PASSWORD is set, and the service has no use for it"),
            "web has the migration password": (dict(env=environments(web={"SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION})),
                                               "web: SENTINEL_DB_MIGRATE_PASSWORD must be blank"),
            "migrate has the runtime password": (dict(env=environments(migrate={"SENTINEL_DB_PASSWORD": RUNTIME})),
                                                 "migrate: SENTINEL_DB_PASSWORD must be blank"),
            "migrate has another variable with the bootstrap password": (
                dict(env=environments(migrate={"DATABASE_URL": f"postgres://sentinel:{BOOTSTRAP}@db/sentinel"})),
                "migrate: DATABASE_URL holds the bootstrap secret"),
            "db has the runtime password": (dict(env=environments(db={"SENTINEL_DB_PASSWORD": RUNTIME})),
                                            "db: SENTINEL_DB_PASSWORD is set, and the service has no use for it"),
            "a tunnel token reaches web": (dict(env=environments(web={"TUNNEL_TOKEN": "t" * 40})),
                                           "web: TUNNEL_TOKEN is set, and the service has no use for it"),
            "the proxy has the Django key": (dict(env=environments(proxy={"DJANGO_SECRET_KEY": DJANGO})),
                                             "proxy: DJANGO_SECRET_KEY holds the django secret"),
            "the proxy has a database password": (dict(env=environments(proxy={"SENTINEL_DB_PASSWORD": RUNTIME})),
                                                  "proxy: SENTINEL_DB_PASSWORD is set, and the service has no use for it"),
            "web has the SMTP password": (dict(env=environments(web={"SENTINEL_SMTP_PASSWORD": "s" * 40})),
                                          "web: SENTINEL_SMTP_PASSWORD must be blank"),
            "the alert engine has the SMTP password": (
                dict(env=environments(**{"alert-engine": {"SENTINEL_SMTP_PASSWORD": "s" * 40}})),
                "alert-engine: SENTINEL_SMTP_PASSWORD must be blank"),
            "the alert engine has the migration password": (
                dict(env=environments(**{"alert-engine": {"SENTINEL_DB_MIGRATE_PASSWORD": MIGRATION}})),
                "alert-engine: SENTINEL_DB_MIGRATE_PASSWORD must be blank"),
            "the alert engine has the bootstrap password": (
                dict(env=environments(**{"alert-engine": {"POSTGRES_PASSWORD": BOOTSTRAP}})),
                "alert-engine: POSTGRES_PASSWORD is set, and the service has no use for it"),
            "the alert engine lacks the runtime password": (
                dict(env=environments(**{"alert-engine": {"SENTINEL_DB_PASSWORD": None}})),
                "alert-engine: SENTINEL_DB_PASSWORD is missing"),
            "web's password is not the runtime's": (dict(env=environments(web={"SENTINEL_DB_PASSWORD": "x" * 40})),
                                                    "web: SENTINEL_DB_PASSWORD is not the runtime secret"),
            "web lacks its password": (dict(env=environments(web={"SENTINEL_DB_PASSWORD": None})),
                                       "web: SENTINEL_DB_PASSWORD is missing"),
            "a retired password is still in web": (dict(env=environments(web={"SENTINEL_DB_PASSWORD": OLD})),
                                                   "web: SENTINEL_DB_PASSWORD holds the retired secret"),
            "a process of web holds the migration password": (
                dict(**{"web.processes": block(7, "python gunicorn", f"SENTINEL_DB_ACCESS=runtime\nX={MIGRATION}")}),
                "web.processes: the environment of process 7 holds the migration secret"),
            "a process of web holds the bootstrap password": (
                dict(**{"web.processes": block(7, "python gunicorn", f"SENTINEL_DB_ACCESS=runtime\nPGPASSWORD={BOOTSTRAP}")}),
                "web.processes: the environment of process 7 holds the bootstrap secret"),
            "the database server holds the runtime password": (
                dict(**{"db.processes": block(1, "postgres", f"PG_MAJOR=18\nX={RUNTIME}")}),
                "db.processes: the environment of process 1 holds the runtime secret"),
            "a password is on a command line": (
                dict(**{"web.processes": block(7, f"python gunicorn --password {RUNTIME}", "SENTINEL_DB_ACCESS=runtime")}),
                "web.processes: the command line of process 7 holds the runtime secret"),
            "even the database's own password is on no command line": (
                dict(**{"db.processes": block(1, f"postgres --password={BOOTSTRAP}", "PG_MAJOR=18")}),
                "db.processes: the command line of process 1 holds the bootstrap secret"),
            "a password is in the logs": (dict(logs=f"x {RUNTIME} y"), "logs: holds the runtime secret"),
            "an old password is in the logs": (dict(logs=f"x {OLD} y"), "logs: holds the retired secret"),
            "the image holds an env file": (dict(**{"web.files": "/app/.env.bootstrap\n"}),
                                            "web: the image holds files of the environment: /app/.env.bootstrap"),
        }
        for name, (changes, expected) in cases.items():
            with self.subTest(name):
                self.assertIn(expected, self.judge(**changes))

    def test_a_blank_variable_or_an_absent_one_is_fine_and_a_foreign_one_is_not(self):
        self.assertEqual(self.judge(env=environments(web={"SENTINEL_DB_MIGRATE_PASSWORD": None})), [])
        self.assertEqual(self.judge(env=environments(migrate={"SENTINEL_DB_PASSWORD": None})), [])
        # Not secret-like names: whatever they hold is not this judge's business, unless it is a secret.
        self.assertEqual(self.judge(env=environments(web={"GPG_KEY": "7169605F62C751356D054A26A821E680E5FA6305"})), [])

    def test_evidence_that_does_not_show_what_it_should_is_not_a_pass(self):
        shell_only = block(91, "sh -c for p in /proc/[0-9]*", "SENTINEL_DB_ACCESS=runtime\nPG_MAJOR=18")  # what collects it
        for name, program, text in (
            ("web.processes", "gunicorn", ""),
            # The environment the collecting shell has is the container's configuration, not gunicorn's.
            ("web.processes", "gunicorn", shell_only),
            ("web.processes", "gunicorn", block(7, "python gunicorn")),  # gunicorn's environment could not be read
            ("db.processes", "postgres", shell_only),
            ("db.processes", "postgres", block(1, "postgres")),  # as root, the server's cannot be read
        ):
            with self.subTest(name, text=text[:30]):
                problems = self.judge(**{name: text})
                self.assertTrue(any(problem.startswith(f"{name}: the evidence does not show the environment of {program}")
                                    for problem in problems), problems)

    def test_the_server_and_its_helpers_are_both_taken_for_the_program(self):
        helpers = (block(1, "/sbin/docker-init -- gunicorn", "SENTINEL_DB_ACCESS=runtime")
                   + block(9, "python /opt/venv/bin/gunicorn", "SENTINEL_DB_ACCESS=runtime"))
        self.assertEqual(self.judge(**{"web.processes": helpers}), [])
        self.assertEqual(self.judge(**{"db.processes": block(1, "postgres: checkpointer", "PG_MAJOR=18")}), [])

    def test_tmpfs_is_the_scratch_space_it_is_meant_to_be(self):
        with tempfile.TemporaryDirectory() as directory:
            write_evidence(directory)
            for service in ("web", "migrate", "alert-engine"):
                (Path(directory) / f"{service}.mounts").write_text(json.dumps([{"Type": "tmpfs", "Destination": "/tmp"}]))
            self.assertEqual(e2e.isolation(directory, secrets_file(directory)), [])

    def test_a_container_that_mounts_anything_but_the_database_volume_is_found(self):
        with tempfile.TemporaryDirectory() as directory:
            write_evidence(directory)
            (Path(directory) / "web.mounts").write_text(json.dumps([{"Type": "bind", "Source": "/srv/sentinel/.env.bootstrap"}]))
            (Path(directory) / "db.mounts").write_text(json.dumps([{"Type": "bind", "Source": "/srv/sentinel/.env.bootstrap"}]))
            problems = e2e.isolation(directory, secrets_file(directory))
        self.assertIn("web: mounts a bind that is not the database volume", problems)
        self.assertIn("db: mounts a bind that is not the database volume", problems)

    def test_what_cannot_be_judged_is_an_error_and_never_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            write_evidence(directory)
            (Path(directory) / "logs").unlink()
            with self.assertRaisesRegex(e2e.Evidence, "evidence missing: logs"):
                e2e.isolation(directory, secrets_file(directory))
            write_evidence(directory)
            with self.assertRaisesRegex(e2e.Evidence, "too short"):
                e2e.isolation(directory, secrets_file(directory, {**SECRETS, "runtime": ["short"]}))
            with self.assertRaisesRegex(e2e.Evidence, "no pepper secret"):
                e2e.isolation(directory, secrets_file(directory, {**SECRETS, "pepper": []}))

    def test_no_problem_prints_a_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            write_evidence(directory, environments(web={"POSTGRES_PASSWORD": BOOTSTRAP, "SENTINEL_DB_PASSWORD": OLD}),
                           logs=f"{RUNTIME} {MIGRATION} {BOOTSTRAP}",
                           **{"web.processes": block(7, f"python gunicorn {DJANGO}", f"SENTINEL_DB_ACCESS=runtime\nX={MIGRATION}")})
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                status = e2e.main(["isolation", directory, "--secrets", secrets_file(directory)])
        self.assertEqual(status, 1)
        for secret in (RUNTIME, MIGRATION, BOOTSTRAP, DJANGO, PEPPER, OLD):
            self.assertNotIn(secret, out.getvalue() + err.getvalue())


class ConfigTests(unittest.TestCase):
    def services(self, **changes):
        return {"services": {name: {"environment": variables} for name, variables in environments(**changes).items()}}

    def judge(self, configuration):
        with tempfile.TemporaryDirectory() as directory:
            return e2e.config(json.dumps(configuration), secrets_file(directory))

    def test_the_resolved_configuration_is_judged_like_the_running_container(self):
        self.assertEqual(self.judge(self.services()), [])
        # A password in the shell of the operator, or .env, that Compose passed to the wrong service.
        problems = self.judge(self.services(web={"POSTGRES_PASSWORD": BOOTSTRAP}, migrate={"SENTINEL_DB_PASSWORD": RUNTIME}))
        self.assertIn("web: POSTGRES_PASSWORD is set, and the service has no use for it", problems)
        self.assertIn("migrate: SENTINEL_DB_PASSWORD must be blank", problems)

    def test_numbers_and_nulls_in_the_configuration_do_not_break_it(self):
        configuration = self.services()
        configuration["services"]["web"]["environment"].update({"POSTGRES_PORT": 5432, "UNSET": None})
        self.assertEqual(self.judge(configuration), [])

    def test_the_notifier_is_judged_when_its_profile_is_enabled(self):
        configuration = self.services()
        notifier = {**configuration["services"]["alert-engine"]["environment"], "SENTINEL_SMTP_PASSWORD": "s" * 40}
        configuration["services"]["notifier"] = {"environment": notifier}
        self.assertEqual(self.judge(configuration), [])  # its own SMTP password: no secret of the stack
        notifier["SENTINEL_DB_MIGRATE_PASSWORD"] = MIGRATION
        self.assertIn("notifier: SENTINEL_DB_MIGRATE_PASSWORD must be blank", self.judge(configuration))
        notifier["SENTINEL_DB_MIGRATE_PASSWORD"] = ""
        notifier["SENTINEL_SMTP_PASSWORD"] = BOOTSTRAP
        self.assertIn("notifier: SENTINEL_SMTP_PASSWORD holds the bootstrap secret", self.judge(configuration))

    def test_a_configuration_of_other_services_is_an_error(self):
        with self.assertRaisesRegex(e2e.Evidence, "the services are"):
            self.judge({"services": {"web": {}}})
        without_engine = self.services()
        del without_engine["services"]["alert-engine"]
        with self.assertRaisesRegex(e2e.Evidence, "the services are"):
            self.judge(without_engine)
        unknown = self.services()
        unknown["services"]["cron"] = {"environment": {}}
        with self.assertRaisesRegex(e2e.Evidence, "the services are"):
            self.judge(unknown)
        with self.assertRaisesRegex(e2e.Evidence, "not a Compose configuration"):
            self.judge({"nothing": 1})


def event(service, action, **attributes):
    return json.dumps({"Type": "container", "Action": action,
                       "Actor": {"Attributes": {"com.docker.compose.service": service, **attributes}}})


class OrderTests(unittest.TestCase):
    COLD = "\n".join([
        event("db", "create"), event("db", "start"), event("db", "health_status: healthy"),
        event("migrate", "create"), event("migrate", "start"), event("migrate", "die", exitCode="0"),
        event("web", "start"), event("web", "health_status: healthy"),
    ])

    def test_a_cold_start_is_database_then_migration_then_web(self):
        expected = ["db:start", "db:healthy", "migrate:start", "migrate:die=0", "web:start", "web:healthy"]
        self.assertEqual(e2e.order(self.COLD, expected, []), [])
        self.assertEqual(e2e.order(self.COLD, ["migrate:die", "web:start"], []), [])

    def test_web_before_the_migration_ended_is_found(self):
        wrong = "\n".join([event("db", "start"), event("db", "health_status: healthy"), event("web", "start"),
                           event("migrate", "start"), event("migrate", "die", exitCode="0")])
        problems = e2e.order(wrong, ["db:healthy", "migrate:start", "migrate:die=0", "web:start"], [])
        self.assertEqual(problems, ["web:start happened before migrate:die=0"])

    def test_a_web_that_started_before_the_migration_ended_did_not_wait_even_if_it_started_again(self):
        restarted = "\n".join([event("web", "start"), event("migrate", "start"), event("migrate", "die", exitCode="0"),
                               event("web", "start")])
        self.assertEqual(e2e.order(restarted, ["migrate:die=0", "web:start"], []), ["web:start happened before migrate:die=0"])

    def test_a_database_that_was_never_healthy_is_found(self):
        wrong = "\n".join([event("db", "start"), event("migrate", "start"), event("migrate", "die", exitCode="1")])
        self.assertEqual(e2e.order(wrong, ["db:start", "db:healthy", "migrate:start"], []),
                         ["db:healthy did not happen after db:start"])

    def test_a_refused_deployment_never_starts_web(self):
        refused = "\n".join([event("db", "health_status: healthy"), event("migrate", "start"),
                             event("migrate", "die", exitCode="1")])
        self.assertEqual(e2e.order(refused, ["migrate:start", "migrate:die=1"], ["web:start"]), [])
        self.assertEqual(e2e.order(refused, ["migrate:start", "migrate:die=0"], []),
                         ["migrate:die=0 did not happen after migrate:start"])
        started = refused + "\n" + event("web", "start")
        self.assertEqual(e2e.order(started, ["migrate:die=1"], ["web:start"]), ["web:start happened, and must not have"])

    def test_events_of_other_things_are_ignored_and_garbage_is_an_error(self):
        noise = "\n".join([json.dumps({"Type": "container", "Action": "start", "Actor": {"Attributes": {}}}),
                           event("db", "exec_start: sh"), event("db", "start"), ""])
        self.assertEqual(e2e.events(noise), [("db", "start")])
        with self.assertRaises(e2e.Evidence):
            e2e.events("not json")
        # A refused deployment that produced no events at all proves nothing about web.
        self.assertEqual(e2e.order("", ["migrate:start"], ["web:start"]), ["migrate:start did not happen after the start"])


class ReportTests(unittest.TestCase):
    NAMES = ["first-one", "second-one", "third-one"]

    def log(self, names=None, passed=None, server="16.4", compose="2.20.0", postgres="16", result=True, extra=""):
        names = self.NAMES if names is None else names
        passed = names if passed is None else passed
        lines = [f"E2E compose={compose} postgres={postgres}", f"E2E server {server} (postgres:{postgres}-alpine)",
                 "E2E scenarios: " + " ".join(names)]
        for name in names:
            lines += [f"== {name}"] + ([f"SCENARIO PASS {name}"] if name in passed else [])
        if result:
            lines.append(f"E2E RESULT: passed {len(passed)} of {len(names)}")
        return "\n".join(lines) + extra

    def test_a_complete_run_passes(self):
        problems, summary = e2e.report(self.log(), "16", "v2.20.0")
        self.assertEqual(problems, [])
        self.assertIn("### Compose v2.20.0, PostgreSQL 16.4: 3 of 3 scenarios, passed", summary)

    def test_whatever_makes_the_run_less_than_what_it_announced_fails_it(self):
        cases = {
            "a scenario that did not pass": self.log(passed=["first-one", "second-one"], result=False),
            "a scenario passed out of order": "\n".join([
                "E2E compose=2.20.0 postgres=16", "E2E server 16.4 (postgres:16-alpine)",
                "E2E scenarios: first-one second-one third-one", "SCENARIO PASS second-one", "SCENARIO PASS first-one",
                "SCENARIO PASS third-one", "E2E RESULT: passed 3 of 3"]),
            "no result": self.log(result=False),
            "another PostgreSQL": self.log(server="18.1"),
            "another PostgreSQL announced": self.log(postgres="18", server="18.1"),
            "another Compose": self.log(compose="2.23.3"),
            "a failure": self.log(extra="\nFAIL: something"),
            "no scenarios": "E2E compose=2.20.0 postgres=16\nE2E server 16.4 (x)\n",
            "nothing at all": "",
        }
        for name, log in cases.items():
            with self.subTest(name):
                problems, summary = e2e.report(log, "16", "2.20.0")
                self.assertTrue(problems, name)
                self.assertIn("FAILED", summary)

    def test_the_summary_names_what_was_not_passed(self):
        problems, summary = e2e.report(self.log(passed=["first-one"], result=False), "16", "2.20.0")
        self.assertIn("- NOT PASSED: second-one", summary)
        self.assertIn("- passed: first-one", summary)
        self.assertIn("scenarios not passed: second-one, third-one", problems)
        self.assertIn("last step begun: third-one", problems)

    def test_the_command_exits_non_zero_and_writes_the_job_summary(self):
        import os
        from unittest import mock

        with tempfile.TemporaryDirectory() as directory:
            log, summary = Path(directory) / "log", Path(directory) / "summary.md"
            for text, status in ((self.log(), 0), (self.log(result=False), 1)):
                log.write_text(text)
                with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}), redirect_stdout(io.StringIO()):
                    self.assertEqual(e2e.main(["report", "--log", str(log), "--postgres", "16", "--compose", "2.20.0"]), status)
            written = summary.read_text()
        self.assertIn("3 of 3 scenarios, passed", written)
        self.assertIn("scenarios, FAILED", written)



# --- the rehearsal --------------------------------------------------------------------------

# What the task asks the rehearsal to validate, and the scenarios that do it.
REQUIRED = [
    "existing-installation", "move-credentials", "provisioning-refusals", "interrupted-provisioning",
    "activation-with-adoption", "start-and-verify", "credential-isolation", "runtime-restrictions",
    "bootstrap-password-refused", "legacy-settings-refused", "second-start",
    "not-started-before-provisioning", "lost-acknowledgement", "first-migration", "state-b-reapplication",
    "activation-marker", "privilege-drift", "password-rotation", "interrupted-migration",
    "failed-deployment-restart",
]
COVERAGE = {
    "real containers: the database, the migration service and web, their order and health":
        ["existing-installation", "start-and-verify", "first-migration", "second-start"],
    "credential isolation, of the running containers": ["move-credentials", "credential-isolation", "password-rotation"],
    "a fresh activation (state A)": ["not-started-before-provisioning", "lost-acknowledgement", "activation-with-adoption"],
    "a valid reapplication (state B)": ["state-b-reapplication"],
    "a rejected state C and the protected marker": ["activation-marker"],
    "operator-managed PUBLIC revocations and the restricted database privileges":
        ["provisioning-refusals", "privilege-drift", "runtime-restrictions"],
    "restricted migrations, django_migrations read-only, startup only after verification":
        ["start-and-verify", "first-migration", "bootstrap-password-refused", "legacy-settings-refused"],
    "an interrupted provisioning": ["interrupted-provisioning"],
    "an interrupted migration": ["interrupted-migration"],
    "a lost acknowledgement": ["lost-acknowledgement"],
    "password rotation": ["password-rotation"],
    "unexpected privilege drift": ["privilege-drift"],
    "a restart after a failed deployment": ["failed-deployment-restart"],
}
SECRET_VARIABLES = ("app", "migration", "bootstrap", "wrong", "old_app", "old_migration")


class RehearsalScriptTests(unittest.TestCase):
    def setUp(self):
        self.script = SCRIPT.read_text()

    def announced(self):
        return re.search(r"^SCENARIOS=\(\n(.*?)\n\)$", self.script, re.S | re.M)[1].split()

    def test_the_scenarios_announced_are_the_scenarios_defined_and_the_ones_required(self):
        defined = [name.replace("_", "-") for name in re.findall(r"^scenario_(\w+)\(\) \{$", self.script, re.M)]
        self.assertEqual(len(set(self.announced())), len(self.announced()))
        self.assertEqual(sorted(self.announced()), sorted(defined))
        self.assertEqual(self.announced(), REQUIRED)
        for requirement, names in COVERAGE.items():
            with self.subTest(requirement):
                self.assertTrue(set(names) <= set(REQUIRED))

    def test_each_scenario_runs_plainly_and_is_announced_only_when_it_passed(self):
        # Not in a condition (where errexit does not apply), and its pass is the next thing that happens.
        self.assertRegex(self.script, r'for name in "\$\{SCENARIOS\[@\]\}"; do\n        step "\$name"\n'
                                      r'        "scenario_\$\{name//-/_\}"\n        echo "SCENARIO PASS \$name"\n')
        self.assertIn('[ "$count" -eq "${#SCENARIOS[@]}" ] || fail', self.script)
        self.assertIn('echo "E2E RESULT: passed $count of ${#SCENARIOS[@]}"', self.script)
        self.assertIn('echo "E2E scenarios: ${SCENARIOS[*]}"', self.script)
        self.assertIn('echo "E2E compose=${compose#v} postgres=$postgres"', self.script)
        self.assertIn('echo "E2E server $version ($image)"', self.script)

    def test_it_runs_only_on_what_it_was_asked_for_and_owns_its_project(self):
        main = self.script[self.script.index("main() {"):]
        self.assertIn('case "$postgres" in 16 | 18) ;; *) fail', main)
        self.assertIn(': "${COMPOSE_PROJECT_NAME:?', main)
        self.assertIn('[ -z "$(docker compose ps --all --quiet)" ] || fail', main)
        self.assertIn('docker volume ls --quiet --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"', main)
        self.assertIn('if [ "${BASH_SOURCE[0]}" = "$0" ]; then\n    main "$@"\nfi', self.script)
        # The server it reports is the one it ran on, and the image it asked for.
        self.assertIn('[ "$major" = "$postgres" ] || fail', self.script)
        self.assertIn('[ "$image" = "postgres:$postgres-alpine" ] || fail', self.script)

    def test_no_secret_is_printed(self):
        names = "|".join(SECRET_VARIABLES)
        for line in logical_lines(self.script):
            code = line.strip()
            if code.startswith("#") or not re.search(rf"\$\{{?({names})\b", code):
                continue
            with self.subTest(line=code):
                # What prints: a failure, a step, an echo; a secret is never part of what they say.
                self.assertNotRegex(code, r"^(fail|step|echo)\b")
                self.assertNotRegex(code, r"\|\|\s*fail .*\$\{?(" + names + r")\b")
        self.assertNotIn("set -x", self.script)
        self.assertNotIn("set -o xtrace", self.script)
        self.assertNotIn("docker compose config\n", self.script)
        # Every secret is generated masked.
        self.assertRegex(self.script, r'new_secret\(\) \{[^}]*mask "\$\{!1\}"')
        self.assertEqual(self.script.count("$(secret)"), 1)  # only in new_secret

    def test_the_statements_the_logins_are_given_are_data(self):
        program = (SCRIPTS / "sql_probe.py").read_text()
        compile(program, "sql_probe.py", "exec")
        self.assertIn('os.environ["WEB_SQL"].splitlines()', program)
        for helper in re.findall(r"^probe\(\) \{.*?\n\}", self.script, re.S | re.M):
            self.assertEqual(helper.count('"WEB_SQL=$2"'), 2)
            self.assertEqual(helper.count('-c "$(cat .github/scripts/sql_probe.py)"'), 2)
        for array in ("RECORD_WRITES", "WEB_REFUSED", "MIGRATE_REFUSED", "MARKER_REFUSED_WEB", "MARKER_REFUSED_MIGRATE",
                      "WEB_ALLOWED"):
            self.assertRegex(self.script, re.compile(rf"^{array}=\(\n", re.M))
        # A statement is never part of code: each goes through the arrays or the helpers.
        for name, text in (("separate-roles-e2e.sh", self.script),):
            for match in re.finditer(r'(?:python3?|shell[^\n]*?) -c "([^"]*)"', text):
                self.assertNotRegex(match[1], r"\$(?!\(cat \.github/scripts/)", match[0])

    def test_the_rehearsal_and_the_documentation_revoke_the_same_things(self):
        docs = (ROOT / "docs" / "server-deployment.md").read_text()
        block = next(block for block in re.findall(r"```bash\n(.*?)```", docs, re.S) if "public-grants.sql" in block)
        record, revoke = re.findall(r"<<'SQL'\n(.*?)\nSQL\n", block, re.S)
        flat = lambda text: " ".join(text.split())  # noqa: E731
        function = re.search(r"^revoke_public\(\) \{\n    sql <<'SQL'\n(.*?)\nSQL\n\}", self.script, re.S | re.M)[1]
        self.assertEqual(flat(function), flat(revoke))
        scenario = re.search(r"^scenario_provisioning_refusals\(\) \{.*?\n\}", self.script, re.S | re.M)[0]
        self.assertIn(flat(record), flat(scenario))
        stepwise = re.findall(r"^    sql <<'SQL'\n(.*?)\nSQL\n", scenario, re.S | re.M)
        self.assertEqual(flat(" ".join(stepwise)), flat(revoke))

    def test_apply_is_not_asked_for_state_c_of_a_renamed_role_which_the_topology_check_refuses_first(self):
        scenario = re.search(r"^scenario_activation_marker\(\) \{.*?\n\}", self.script, re.S | re.M)[0]
        start = scenario.index("RENAME TO sentinel_app_gone")
        end = scenario.rindex('RENAME TO sentinel_app"')
        renamed, others = scenario[start:end], scenario[:start]
        # status and the start read the history first: state C. apply reads the topology first.
        self.assertIn('refused_by "state C" scripts/postgres-roles.sh status', renamed)
        self.assertIn('refused_by "$RENAMED_ROLE_REFUSAL" scripts/postgres-roles.sh apply', renamed)
        self.assertNotIn('refused_by "state C" scripts/postgres-roles.sh apply', renamed)
        self.assertIn("grep -q 'state C' <<<\"$(migrate_log)\"", renamed)
        self.assertRegex(self.script, re.compile(r"^RENAMED_ROLE_REFUSAL='this cluster also has role sentinel_app_gone'$", re.M))
        # The record changed or missing, with all the roles there: state C for both.
        for command in ("status", "apply"):
            self.assertEqual(others.count(f'refused_by "state C" scripts/postgres-roles.sh {command}'), 2)

    def test_every_file_it_runs_exists_and_the_ones_it_names_are_executable(self):
        for path in re.findall(r"(?<![\w/.-])((?:\.github/scripts|scripts)/[\w.-]+\.(?:sh|py))", self.script):
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file(), path)
                if path.endswith(".sh"):
                    self.assertTrue((ROOT / path).stat().st_mode & stat.S_IXUSR)

    def test_the_new_installation_follows_the_documented_commands(self):
        docs = (ROOT / "docs" / "server-deployment.md").read_text()
        section = docs[docs.index("#### A new installation"):docs.index("#### An existing installation")]
        scenario = re.search(r"^scenario_not_started_before_provisioning\(\) \{.*?\n\}", self.script, re.S | re.M)[0]
        for command in ("scripts/postgres-preflight.sh", "scripts/postgres-roles.sh apply"):
            self.assertIn(command, section)
        self.assertIn("scripts/postgres-preflight.sh", scenario)
        self.assertIn("separate_layout", scenario)


class RehearsalHelperTests(unittest.TestCase):
    """The rehearsal's own control flow, with a stand-in ``docker`` that says what it is told to: the
    helpers that record events around `docker compose up`, judge their order and demand refusals. (What
    the real Docker does is for the CI job to show.)"""

    FAKE = """#!/usr/bin/env bash
case "$1" in
    events) cat "$FAKE_EVENTS"; exec sleep 30 ;;
    compose) if [ "$2" = up ]; then exit "${FAKE_UP_STATUS:-0}"; fi; exit 98 ;;
    *) exit 98 ;;
esac
"""

    def run_bash(self, body, events="", up_status=0):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "bin").mkdir()
            docker = base / "bin" / "docker"
            write_executable(docker, self.FAKE)
            (base / "events").write_text(events)
            env = {"PATH": f"{base / 'bin'}:/usr/bin:/bin:{Path(sys.executable).parent}", "work": str(base),
                   "COMPOSE_PROJECT_NAME": "sentinel-test", "FAKE_EVENTS": str(base / "events"), "FAKE_UP_STATUS": str(up_status),
                   "E2E_EVENTS_SETTLE": "0"}
            # The recording of events ends with the shell (the script's own does, through its trap).
            return subprocess.run(["bash", "-c", f'source "{SCRIPT}"; trap events_end EXIT; {body}'], cwd=ROOT, env=env,
                                  capture_output=True, text=True, timeout=120, check=False)

    COLD = "\n".join([event("db", "start"), event("db", "health_status: healthy"), event("migrate", "start"),
                      event("migrate", "die", exitCode="0"), event("web", "start"), event("web", "health_status: healthy")]) + "\n"
    ORDER = "--expect db:start db:healthy migrate:start migrate:die=0 web:start web:healthy"

    def test_a_start_in_the_order_expected_passes(self):
        result = self.run_bash(f"start cold {self.ORDER}", events=self.COLD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("the containers started in order", result.stdout + result.stderr)

    def test_a_start_that_failed_or_started_in_another_order_is_a_failure(self):
        out_of_order = self.COLD.replace(event("web", "start") + "\n", "") + event("web", "start") + "\n"
        for name, events, up_status, message in (
            ("compose failed", self.COLD, 1, None),
            ("web before migrate ended", out_of_order.replace(event("migrate", "die", exitCode="0") + "\n", ""), 0,
             "did not happen after"),
            ("no events at all", "", 0, "db:start did not happen after the start"),
        ):
            with self.subTest(name):
                result = self.run_bash(f"start cold {self.ORDER}", events=events, up_status=up_status)
                self.assertNotEqual(result.returncode, 0)
                if message:
                    self.assertIn(message, result.stderr)

    def test_a_refused_start_is_one_that_fails_and_never_starts_web(self):
        refused = "\n".join([event("migrate", "start"), event("migrate", "die", exitCode="1")]) + "\n"
        expectation = "--expect migrate:start migrate:die=1 --absent web:start"
        result = self.run_bash(f"refused_start refused 30 {expectation}", events=refused, up_status=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Compose that starts the stack when it must not, or a web that was started anyway.
        result = self.run_bash(f"refused_start refused 30 {expectation}", events=refused, up_status=0)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL: the stack started, and must not have: refused", result.stderr)
        started = refused + event("web", "start") + "\n"
        result = self.run_bash(f"refused_start refused 30 {expectation}", events=started, up_status=1)
        self.assertEqual(result.returncode, 1)
        self.assertIn("web:start happened, and must not have", result.stderr)

    def test_the_event_listener_does_not_outlive_the_run(self):
        probe = 'kill -0 "$events_pid" 2> /dev/null && echo alive || echo gone'
        result = self.run_bash(f"start cold {self.ORDER}; {probe}", events=self.COLD)
        self.assertIn("gone", result.stdout)

    def test_a_refusal_must_be_every_statement_and_only_that(self):
        refusal = 'probe() { printf "error 42501\\nerror 42501\\n"; }'
        self.assertEqual(self.run_bash(f"{refusal}; refused web one two").returncode, 0)
        for output in ('error 42501\\nok\\n', 'error 42501\\n', 'error 42501\\nerror 42501\\nerror 42501\\n',
                       'error 42P01\\nerror 42501\\n'):
            with self.subTest(output):
                result = self.run_bash(f'probe() {{ printf "{output}"; }}; refused web one two')
                self.assertEqual(result.returncode, 1)
                self.assertIn("FAIL: web was not refused every one of: one two", result.stderr)

    def test_what_the_runtime_login_is_for_is_checked_statement_by_statement(self):
        body = ('WEB_ALLOWED=("first" "ok True" "second" "ok"); probe() { case "$2" in first) echo "ok True" ;; *) echo "$FAKE_SECOND" ;; esac; }; '
                "allowed")
        self.assertEqual(self.run_bash(body.replace('"$FAKE_SECOND"', '"ok"')).returncode, 0)
        result = self.run_bash(body.replace('"$FAKE_SECOND"', '"error 42501"'))
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL: web cannot: second", result.stderr)

    def test_a_start_that_fails_ends_the_recording_of_events_before_it_fails(self):
        result = self.run_bash(f"start cold {self.ORDER}; echo not reached", events=self.COLD, up_status=1)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL: docker compose up did not complete: cold", result.stderr)
        self.assertNotIn("not reached", result.stdout)

    def test_apply_is_run_again_when_a_session_of_the_health_check_made_it_refuse_and_only_then(self):
        # Refused twice for the session, then for the reason: what the last run said is the answer.
        counting = ('n=$(cat "$work/n" 2> /dev/null || echo 0); echo $((n + 1)) > "$work/n"; '
                    'if [ "$n" -lt 2 ]; then echo "other superuser sessions use this database" >&2; else echo boom >&2; fi; exit 1')
        result = self.run_bash(f"refused_by boom bash -c '{counting}'")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Any other refusal is final at once.
        result = self.run_bash("refused_by boom bash -c 'echo other >&2; exit 1'")
        self.assertEqual(result.returncode, 1)
        self.assertIn("refused, but not with: boom", result.stderr)
        # A command that succeeds is not run again.
        result = self.run_bash('run_again_if_a_session_was_open "$work/out" "$work/err" bash -c \'echo once >> "$work/runs"\'; '
                               'wc -l < "$work/runs"')
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "1"), result.stderr)

    def test_the_log_of_a_container_is_the_log_of_the_run_that_is_judged(self):
        fake = ('docker() { if [ "$1" = compose ]; then echo abc; else echo "since=$3"; fi; }; '
                'since_epoch=1700000000; service_log migrate')
        result = self.run_bash(fake)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "since=1700000000"), result.stderr)

    def test_retry_waits_for_a_command_and_gives_up(self):
        self.assertEqual(self.run_bash("retry 3 nothing true").returncode, 0)
        result = self.run_bash("retry 1 the-moon false")
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL: timed out waiting for the-moon", result.stderr)

    def test_a_secret_is_masked_when_it_is_made_and_only_then(self):
        # Whatever the variable is called, even what the function uses inside.
        for variable in ("value", "generated", "app"):
            with self.subTest(variable):
                result = self.run_bash(f'new_secret {variable}; printf "%s" "${variable}" | wc -c')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertGreaterEqual(int(result.stdout), 48)
                self.assertEqual(result.stdout.count("::add-mask::"), 0)  # outside GitHub Actions: nothing is said
        env = {"PATH": os.environ["PATH"], "GITHUB_ACTIONS": "true", "work": "/nonexistent"}
        masked = subprocess.run(["bash", "-c", f'source "{SCRIPT}"; new_secret app; printf "%s\\n" "$app" | wc -c'], cwd=ROOT,
                                env=env, capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(masked.returncode, 0, masked.stderr)
        lines = masked.stdout.splitlines()
        self.assertTrue(lines[0].startswith("::add-mask::"))
        self.assertEqual(int(lines[1]), len(lines[0]) - len("::add-mask::") + 1)  # the secret, then a newline


class CleanupScriptTests(unittest.TestCase):
    """.github/scripts/compose-cleanup.sh against a stand-in docker that holds the containers, volumes and
    networks of two projects: it removes the project it is given, whether or not `docker compose down`
    works, never touches the other, and fails when anything is left or cannot be seen."""

    SCRIPT = SCRIPTS / "compose-cleanup.sh"
    FAKE = r"""#!/usr/bin/env python3
import json, os, sys

state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path))
scenario = state.get("scenario", {})
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as calls:
    calls.write(json.dumps(args) + "\n")
project = os.environ.get("COMPOSE_PROJECT_NAME", "")

def wanted(args):
    for flag, value in zip(args, args[1:]):
        if flag == "--filter":
            key, _, expected = value.partition("=")
            assert key == "label", value
            return expected.partition("=")[2]
    sys.exit("no filter")

def save():
    json.dump(state, open(state_path, "w"))

kinds = {("ps",): "containers", ("volume", "ls"): "volumes", ("network", "ls"): "networks"}
removals = {("rm",): "containers", ("volume", "rm"): "volumes", ("network", "rm"): "networks"}
if args[:2] == ["compose", "down"]:
    if scenario.get("down_status"):
        sys.exit(scenario["down_status"])
    for kind in ("containers", "volumes", "networks"):
        state[kind] = [item for item in state[kind] if item["project"] != project]
    save()
elif tuple(args[:2]) in kinds or tuple(args[:1]) in kinds:
    kind = kinds.get(tuple(args[:2])) or kinds.get(tuple(args[:1]))
    if scenario.get("lookup_status") == kind:
        sys.exit(1)
    for item in state[kind]:
        if item["project"] == wanted(args):
            print(item["id"])
elif tuple(args[:2]) in removals or tuple(args[:1]) in removals:
    kind = removals.get(tuple(args[:2])) or removals.get(tuple(args[:1]))
    identifier = args[-1]
    if identifier in scenario.get("stuck", []):
        sys.exit(1)
    state[kind] = [item for item in state[kind] if item["id"] != identifier]
    save()
else:
    sys.exit(f"unexpected docker call: {args}")
"""

    def run_cleanup(self, project="sentinel-roles-e2e", scenario=None, environment=None):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "bin").mkdir()
            docker = base / "bin" / "docker"
            write_executable(docker, self.FAKE)
            ours = {"project": "sentinel-roles-e2e"}
            theirs = {"project": "someone-elses-stack"}
            (base / "state.json").write_text(json.dumps({
                "containers": [{"id": "c-db", **ours}, {"id": "c-web", **ours}, {"id": "other-db", **theirs}],
                "volumes": [{"id": "sentinel-roles-e2e_postgres_data", **ours}, {"id": "other_data", **theirs}],
                "networks": [{"id": "n-ours", **ours}, {"id": "n-other", **theirs}],
                "scenario": scenario or {},
            }))
            env = {"PATH": f"{base / 'bin'}:/usr/bin:/bin", "FAKE_STATE": str(base / "state.json"),
                   "FAKE_CALLS": str(base / "calls"), **(environment or {})}
            if project is not None:
                env["COMPOSE_PROJECT_NAME"] = project
            result = subprocess.run(["bash", str(self.SCRIPT)], env=env, capture_output=True, text=True, timeout=60, check=False)
            state = json.loads((base / "state.json").read_text())
            calls = [json.loads(line) for line in (base / "calls").read_text().splitlines()] if (base / "calls").exists() else []
            remaining = {kind: sorted(item["id"] for item in state[kind]) for kind in ("containers", "volumes", "networks")}
            return result, remaining, calls

    OTHERS = {"containers": ["other-db"], "volumes": ["other_data"], "networks": ["n-other"]}

    def test_the_project_goes_and_the_other_stays(self):
        result, remaining, calls = self.run_cleanup()
        self.assertEqual((result.returncode, remaining), (0, self.OTHERS), result.stderr)
        self.assertIn("nothing of sentinel-roles-e2e is left", result.stdout)
        self.assertEqual(calls[0], ["compose", "down", "--volumes", "--remove-orphans"])

    def test_what_down_cannot_remove_is_removed_by_label(self):
        result, remaining, _ = self.run_cleanup(scenario={"down_status": 1})
        self.assertEqual((result.returncode, remaining), (0, self.OTHERS), result.stderr)
        self.assertIn("docker compose down failed", result.stderr)

    def test_every_lookup_is_limited_to_the_project_label(self):
        _, _, calls = self.run_cleanup(scenario={"down_status": 1})
        lookups = [call for call in calls if call[0] != "compose" and "--filter" in call]
        self.assertGreaterEqual(len(lookups), 6)  # each kind, to remove and to check
        for call in lookups:
            self.assertIn("label=com.docker.compose.project=sentinel-roles-e2e", call)
        for call in calls:
            if call[0] != "compose" and "--filter" not in call:
                self.assertIn(call[-1], {"c-db", "c-web", "sentinel-roles-e2e_postgres_data", "n-ours"})

    def test_what_cannot_be_removed_fails_the_cleanup(self):
        result, remaining, _ = self.run_cleanup(scenario={"down_status": 1, "stuck": ["c-web"]})
        self.assertEqual(result.returncode, 1)
        self.assertIn("something of sentinel-roles-e2e is left", result.stderr)
        # The rest was still removed.
        self.assertEqual(remaining, {"containers": ["c-web", "other-db"], "volumes": ["other_data"], "networks": ["n-other"]})

    def test_a_lookup_that_fails_is_not_an_empty_answer(self):
        for kind in ("containers", "volumes", "networks"):
            with self.subTest(kind):
                result, _, _ = self.run_cleanup(scenario={"lookup_status": kind})
                self.assertEqual(result.returncode, 1)
                self.assertIn("failed", result.stderr)
                self.assertNotIn("nothing of", result.stdout)

    def test_a_project_that_is_not_a_rehearsal_s_is_not_touched(self):
        for project in ("someone-elses-stack", "sentinel-", "", None):
            with self.subTest(project=project):
                result, remaining, calls = self.run_cleanup(project=project)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])
                self.assertEqual(len(remaining["containers"]), 3)


# --- the job ------------------------------------------------------------------------------------


class SeparateRolesJobTests(unittest.TestCase):
    def setUp(self):
        self.workflow = load_workflow(self)
        self.job = self.workflow["jobs"]["separate-roles"]
        self.steps = self.job["steps"]
        self.runs = [step.get("run", "").strip() for step in self.steps]

    def test_every_compose_release_runs_every_postgres_version_and_no_cell_may_fail(self):
        compose = self.workflow["jobs"]["compose-compatibility"]["strategy"]["matrix"]["compose"]
        self.assertEqual(self.job["strategy"]["matrix"], {"compose": compose, "postgres": ["16", "18"]})
        self.assertIs(self.job["strategy"]["fail-fast"], False)
        self.assertNotIn("continue-on-error", self.job)
        for step in self.steps:
            self.assertNotIn("continue-on-error", step)
        self.assertEqual(self.job["if"], self.workflow["jobs"]["compose-compatibility"]["if"])
        self.assertGreaterEqual(self.job["timeout-minutes"], 45)

    def test_the_project_is_the_job_s_and_the_version_is_the_cell_s(self):
        env = self.job["env"]
        self.assertTrue(env["COMPOSE_PROJECT_NAME"].startswith("sentinel-"))
        self.assertEqual(env["SENTINEL_E2E_POSTGRES"], "${{ matrix.postgres }}")
        self.assertIn('.github/scripts/ci-env.sh "${{ matrix.postgres }}"', self.runs)
        self.assertEqual(self.steps[0]["with"], {"persist-credentials": False})

    def test_the_steps_run_in_order_and_the_judgement_and_the_cleanup_cannot_be_skipped(self):
        order = ['.github/scripts/install-compose.sh "${{ matrix.compose }}"', '.github/scripts/ci-env.sh "${{ matrix.postgres }}"']
        positions = [self.runs.index(run) for run in order]
        (scenarios,) = [step for step in self.steps if step.get("id") == "scenarios"]
        (judge,) = [step for step in self.steps if "compose_e2e.py report" in step.get("run", "")]
        (logs,) = [step for step in self.steps if "docker compose logs" in step.get("run", "")]
        (cleanup,) = [step for step in self.steps if "compose-cleanup.sh" in step.get("run", "")]
        indexes = positions + [self.steps.index(step) for step in (scenarios, judge, logs, cleanup)]
        self.assertEqual(indexes, sorted(indexes))
        self.assertNotIn("if", scenarios)
        # The scenarios' failure is the step's failure, whatever tee says.
        self.assertIn("set -o pipefail", scenarios["run"])
        self.assertIn('.github/scripts/separate-roles-e2e.sh 2>&1 | tee "$RUNNER_TEMP/separate-roles-e2e.log"', scenarios["run"])
        # Judged even when the scenarios failed (the summary says which passed), unless cancelled or never run.
        self.assertEqual(judge["if"], "${{ !cancelled() && steps.scenarios.outcome != 'skipped' }}")
        for argument in ('--log "$RUNNER_TEMP/separate-roles-e2e.log"', '--postgres "${{ matrix.postgres }}"',
                         '--compose "${{ matrix.compose }}"'):
            self.assertIn(argument, judge["run"])
        self.assertEqual(logs["if"], "failure() || cancelled()")
        self.assertEqual(cleanup["if"], "always()")

    def test_the_other_compose_job_still_runs_what_it_ran_and_not_the_logins(self):
        steps = self.workflow["jobs"]["compose-compatibility"]["steps"]
        runs = [step.get("run", "") for step in steps]
        self.assertTrue(any(".github/scripts/compose-config-check.sh" in run for run in runs))
        self.assertTrue(any(".github/scripts/compose-upgrade-e2e.sh" in run for run in runs))
        self.assertFalse(any("separate-roles-e2e.sh" in run or "ci-env.sh" in run for run in runs))


class CiEnvironmentTests(unittest.TestCase):
    """.github/scripts/ci-env.sh makes the .env of an existing installation (PostgreSQL 16) or of a new
    one (18), with masked random secrets and nothing reachable from outside the host."""

    SCRIPT = SCRIPTS / "ci-env.sh"

    def make(self, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "tests" / "deployment").mkdir(parents=True)
            shutil.copy(ROOT / ".env.example", base / ".env.example")
            shutil.copy(ROOT / "tests" / "deployment" / "legacy.env.example", base / "tests" / "deployment" / "legacy.env.example")
            result = subprocess.run(["bash", str(self.SCRIPT), *arguments], cwd=base, capture_output=True, text=True, timeout=60,
                                    env={"PATH": os.environ["PATH"], "GITHUB_ACTIONS": "true"}, check=False)
            env = (base / ".env").read_text() if (base / ".env").exists() else ""
            return result, env

    def setUp(self):
        probe = subprocess.run(["sed", "--version"], capture_output=True, text=True, check=False)
        if "GNU" not in probe.stdout:
            self.skipTest("these scripts run on GNU sed (CI)")

    def settings(self, env):
        return dict(line.split("=", 1) for line in env.splitlines() if re.match(r"^[A-Z_]+=", line))

    def test_a_new_installation_selects_postgresql_18_and_authorizes_its_first_start(self):
        for arguments in ((), ("18",)):
            with self.subTest(arguments=arguments):
                result, env = self.make(*arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                settings = self.settings(env)
                self.assertEqual((settings["SENTINEL_POSTGRES"], settings["SENTINEL_POSTGRES_INITIALIZE"]), ("18", "true"))
                self.assertEqual(settings["SENTINEL_HTTP_BIND"], "127.0.0.1")

    def test_an_existing_installation_stays_on_postgresql_16(self):
        result, env = self.make("16")
        self.assertEqual(result.returncode, 0, result.stderr)
        settings = self.settings(env)
        self.assertNotIn("SENTINEL_POSTGRES", settings)
        self.assertNotIn("SENTINEL_POSTGRES_INITIALIZE", settings)
        self.assertEqual(settings["SENTINEL_HTTP_BIND"], "127.0.0.1")

    def test_each_secret_is_random_and_masked_and_never_printed_otherwise(self):
        for arguments in ((), ("16",)):
            result, env = self.make(*arguments)
            settings = self.settings(env)
            secrets = [settings[name] for name in ("DJANGO_SECRET_KEY", "AGENT_TOKEN_PEPPER", "POSTGRES_PASSWORD")]
            self.assertEqual(len(set(secrets)), 3)
            masks = re.findall(r"^::add-mask::(.+)$", result.stdout, re.M)
            self.assertEqual(sorted(masks), sorted(secrets))
            rest = re.sub(r"^::add-mask::.*$", "", result.stdout, flags=re.M)
            for secret in secrets:
                self.assertNotIn(secret, rest + result.stderr)

    def test_another_version_is_refused(self):
        result, env = self.make("17")
        self.assertEqual((result.returncode, env), (2, ""))
        self.assertIn("usage: ci-env.sh [16|18]", result.stderr)


if __name__ == "__main__":
    unittest.main()

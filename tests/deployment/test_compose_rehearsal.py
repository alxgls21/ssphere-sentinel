"""Isolation of .github/scripts/compose-upgrade-e2e.sh from everything else on
the Docker host: it may only find and remove containers and volumes of its own
Compose project, and only after it has established that the project is new.

Two layers of tests, both under bash against a stand-in ``docker`` (and ``git``)
that knows containers and volumes of several projects, filters them by label
the way ``docker ps`` and ``docker volume ls`` do, and records every call:

* the script's project-scoped functions, run on their own;
* the whole script, from its first line to its EXIT trap, with the stand-ins
  scripted to fail in the places a real host can: a failing lookup, a project
  that already exists, a deployment that fails halfway.

The Docker daemon, Compose and the real rehearsal are not involved: what the
real commands do remains for the CI job to show.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github" / "scripts" / "compose-upgrade-e2e.sh"
BEGIN = "# --- project-scoped lookups"
END = "# --- end of project-scoped lookups"

PROJECT = "sentinel-upgrade-rehearsal-4242"
OTHER = "someone-elses-stack"
# In a state file: the project of the running script (COMPOSE_PROJECT_NAME).
REHEARSAL = "@rehearsal@"
PREFIX = "sentinel-upgrade-rehearsal-"
STOP = 41  # status of the stand-in's `compose exec`: the end of what these tests run

FAKE_DOCKER = r'''
import json, os, sys

state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path))
scenario = state.setdefault("scenario", {})
args = sys.argv[1:]
project = os.environ.get("COMPOSE_PROJECT_NAME", "")
with open(os.environ["FAKE_CALLS"], "a") as calls:
    calls.write(json.dumps({"tool": "docker", "args": args, "project": project}) + "\n")

def save():
    json.dump(state, open(state_path, "w"))

def labels(item):
    return {k: (project if v == "@rehearsal@" else v) for k, v in item["labels"].items()}

def label_filters(args):
    wanted = []
    for flag, value in zip(args, args[1:]):
        if flag == "--filter":
            kind, _, rest = value.partition("=")
            if kind != "label":
                sys.exit(f"unsupported filter {value}")
            key, _, expected = rest.partition("=")
            wanted.append((key, expected))
    return wanted

def matching(items, args):
    wanted = label_filters(args)
    return [item for item in items if all(labels(item).get(k) == v for k, v in wanted)]

def of_this_project(item):
    return labels(item).get("com.docker.compose.project") == project

def answer(kind, items):
    status = scenario.get(f"{kind}_status", 0)
    if status:
        sys.exit(status)  # a failing lookup prints nothing
    if f"{kind}_output" in scenario:
        print(scenario[f"{kind}_output"])
        sys.exit(0)
    for item in items:
        print(item.get("id") or item["name"])

if args[:1] == ["ps"]:
    assert "--all" in args and "--quiet" in args, args
    answer("ps", matching(state["containers"], args))
elif args[:2] == ["volume", "ls"]:
    assert "--quiet" in args, args
    answer("volume", matching(state["volumes"], args))
elif args[:1] == ["inspect"]:
    (container,) = [c for c in state["containers"] if c["id"] == args[-1]]
    print(container["status"])
elif args[:2] == ["container", "rm"]:
    for identifier in args[2:]:
        (container,) = [c for c in state["containers"] if c["id"] == identifier]
        if container["status"] != "exited":
            sys.exit(f"cannot remove running container {identifier}")
        state["containers"].remove(container)
    save()
elif args[:2] == ["compose", "version"]:
    print("Docker Compose version v0.0.0-stand-in")
elif args[:2] == ["compose", "up"]:
    status = scenario.get("up_status", 0)
    if status:
        # A deployment that failed halfway: it left a container behind.
        state["containers"].append({"id": "half-started", "status": "created", "labels": {"com.docker.compose.project": "@rehearsal@", "com.docker.compose.service": "db"}})
        save()
        sys.exit(status)
    state["containers"].append({"id": "database", "status": "running", "labels": {"com.docker.compose.project": "@rehearsal@", "com.docker.compose.service": "db"}})
    state["volumes"].append({"name": project + "_postgres_data", "labels": {"com.docker.compose.project": "@rehearsal@", "com.docker.compose.volume": "postgres_data"}})
    save()
elif args[:2] == ["compose", "down"]:
    # Like Compose: removes what belongs to the project in the environment.
    state["containers"] = [c for c in state["containers"] if not of_this_project(c)]
    state["volumes"] = [v for v in state["volumes"] if not of_this_project(v)]
    save()
    sys.exit(scenario.get("down_status", 0))
elif args[:2] == ["compose", "logs"]:
    print("stand-in compose logs")
    sys.exit(scenario.get("logs_status", 0))
elif args[:2] == ["compose", "exec"]:
    sys.exit(scenario.get("exec_status", 41))
else:
    sys.exit(f"unexpected docker call: {args}")
'''

FAKE_GIT = r'''
import json, os, sys

state = json.load(open(os.environ["FAKE_STATE"]))
scenario = state.get("scenario", {})
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as calls:
    calls.write(json.dumps({"tool": "git", "args": args}) + "\n")

if args[:2] == ["rev-parse", "HEAD"]:
    print("c0ffee")
elif args[:1] == ["status"]:
    sys.exit(scenario.get("git_status_status", 0))  # a clean tree prints nothing
elif args[:1] == ["checkout"]:
    sys.exit(scenario.get("checkout_status", {}).get(args[-1], 0))
else:
    sys.exit(f"unexpected git call: {args}")
'''

FAKE_MKTEMP = r'''
import json, os, sys, tempfile

with open(os.environ["FAKE_CALLS"], "a") as calls:
    calls.write(json.dumps({"tool": "mktemp", "args": sys.argv[1:]}) + "\n")
print(tempfile.mkdtemp(dir=os.environ["FAKE_TMP"]))
'''

FAKE_SUDO = '#!/bin/sh\necho "unexpected sudo call: $*" >&2\nexit 99\n'
ENV_EXAMPLE = "DJANGO_SECRET_KEY=change-me\nAGENT_TOKEN_PEPPER=change-me\nPOSTGRES_PASSWORD=change-me\n"


def compose_labels(project: str, service: str) -> dict[str, str]:
    return {"com.docker.compose.project": project, "com.docker.compose.service": service}


def volume_labels(project: str) -> dict[str, str]:
    return {"com.docker.compose.project": project, "com.docker.compose.volume": "postgres_data"}


def foreign_resources() -> tuple[list[dict], list[dict]]:
    """Another Compose project's stopped migrate and database containers and
    volumes, and a container and a volume that belong to no project."""
    containers = [
        {"id": "other-migrate", "status": "exited", "labels": compose_labels(OTHER, "migrate")},
        {"id": "other-migrate-2", "status": "exited", "labels": compose_labels(OTHER + "-2", "migrate")},
        {"id": "other-db", "status": "running", "labels": compose_labels(OTHER, "db")},
        {"id": "plain-container", "status": "exited", "labels": {}},
    ]
    volumes = [
        {"name": f"{OTHER}_postgres_data", "labels": volume_labels(OTHER)},
        {"name": f"{OTHER}-2_postgres_data", "labels": volume_labels(OTHER + "-2")},
        {"name": "plain-volume", "labels": {}},
    ]
    return containers, volumes


def host_state() -> dict:
    """Containers and volumes of the rehearsal (project PROJECT) and of others."""
    containers, volumes = foreign_resources()
    return {
        "containers": [
            {"id": "rehearsal-migrate", "status": "exited", "labels": compose_labels(PROJECT, "migrate")},
            {"id": "rehearsal-db", "status": "running", "labels": compose_labels(PROJECT, "db")},
            {"id": "rehearsal-web", "status": "running", "labels": compose_labels(PROJECT, "web")},
            *containers,
        ],
        "volumes": [{"name": f"{PROJECT}_postgres_data", "labels": volume_labels(PROJECT)}, *volumes],
    }


def code_lines(text: str) -> list[str]:
    """Logical lines (continuations joined) that are not comments."""
    joined = re.sub(r"\\\n\s*", " ", text)
    return [line for line in joined.splitlines() if line.strip() and not line.lstrip().startswith("#")]


class StandIns:
    """A scratch directory with stand-in docker, git and sudo commands."""

    def make(self, test: unittest.TestCase) -> Path:
        if not shutil.which("bash"):  # pragma: no cover - CI has bash
            test.skipTest("bash is not available")
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name, text in (("docker", FAKE_DOCKER), ("git", FAKE_GIT), ("mktemp", FAKE_MKTEMP)):
            path = self.bin / name
            path.write_text(f"#!{sys.executable}\n{text}")
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        sudo = self.bin / "sudo"
        sudo.write_text(FAKE_SUDO)
        sudo.chmod(sudo.stat().st_mode | stat.S_IXUSR)
        self.state = self.base / "state.json"
        self.calls = self.base / "calls"
        # Where the stand-in mktemp makes the script's scratch directory (the
        # real one is not told apart by platform: macOS ignores TMPDIR).
        self.tmp = self.base / "tmp"
        self.tmp.mkdir()
        self.state.write_text(json.dumps(host_state()))
        self.env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "FAKE_STATE": str(self.state),
            "FAKE_CALLS": str(self.calls),
            "FAKE_TMP": str(self.tmp),
        }
        return self.base

    def write_state(self, state: dict) -> None:
        self.state.write_text(json.dumps(state))

    def read_state(self) -> dict:
        return json.loads(self.state.read_text())

    def recorded(self) -> list[dict]:
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def remaining(self) -> tuple[set[str], set[str]]:
        state = self.read_state()
        return {c["id"] for c in state["containers"]}, {v["name"] for v in state["volumes"]}


def is_removal(call: dict) -> bool:
    """A call that deletes or tears down something on the host."""
    args = call["args"]
    if call["tool"] != "docker":
        return False
    return (
        "prune" in args
        or args[:2] in (["compose", "down"], ["compose", "rm"], ["container", "rm"], ["volume", "rm"])
        or args[:1] in (["rm"], ["rmi"], ["kill"], ["stop"])
    )


class ProjectScopedFunctionTests(unittest.TestCase):
    def setUp(self):
        self.stand_ins = StandIns()
        self.stand_ins.make(self)
        text = SCRIPT.read_text()
        self.functions = text[text.index(BEGIN) : text.index(END)]

    def call(self, function: str, project: str = PROJECT) -> subprocess.CompletedProcess:
        harness = (
            "set -euo pipefail\n"
            'fail() { echo "FAIL: $*" >&2; exit 1; }\n'
            f"project={project}\n"
            f"{self.functions}\n"
            f"{function}\n"
        )
        return subprocess.run(
            ["bash", "-c", harness], env=self.stand_ins.env, capture_output=True, text=True, check=False
        )

    def scenario(self, **scenario) -> None:
        self.stand_ins.write_state({**host_state(), "scenario": scenario})

    def removals(self) -> list[list[str]]:
        return [call["args"] for call in self.stand_ins.recorded() if is_removal(call)]

    def test_lookups_only_find_the_rehearsal_project(self):
        result = self.call("migrate_containers")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["rehearsal-migrate"])
        result = self.call("postgres_volume")
        self.assertEqual(result.stdout.split(), [f"{PROJECT}_postgres_data"])
        result = self.call("project_resources")
        self.assertEqual(
            sorted(result.stdout.split()),
            sorted(["rehearsal-migrate", "rehearsal-db", "rehearsal-web", f"{PROJECT}_postgres_data"]),
        )

    def test_removing_the_exited_migrate_container_touches_nothing_else(self):
        containers_before, volumes_before = self.stand_ins.remaining()
        result = self.call("remove_exited_migrate")
        self.assertEqual(result.returncode, 0, result.stderr)
        containers, volumes = self.stand_ins.remaining()
        self.assertEqual(containers_before - containers, {"rehearsal-migrate"})
        self.assertEqual(volumes, volumes_before)
        self.assertEqual(self.removals(), [["container", "rm", "rehearsal-migrate"]])

    def test_another_projects_migrate_container_is_never_removed(self):
        # A project of its own with no migrate container: nothing is removed,
        # although an exited migrate container of another stack exists.
        result = self.call("remove_exited_migrate", project="sentinel-upgrade-rehearsal-9999")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected one migrate container", result.stderr)
        self.assertEqual(self.removals(), [])
        self.assertIn("other-migrate", self.stand_ins.remaining()[0])

    def test_a_running_migrate_container_is_not_removed(self):
        state = host_state()
        state["containers"][0]["status"] = "running"
        self.stand_ins.write_state(state)
        result = self.call("remove_exited_migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.removals(), [])

    def test_a_failed_lookup_is_an_error_never_an_empty_answer(self):
        for lookup, setting in (
            ("migrate_containers", {"ps_status": 17}),
            ("project_containers", {"ps_status": 17}),
            ("postgres_volume", {"volume_status": 17}),
            ("project_volumes", {"volume_status": 17}),
            ("project_resources", {"ps_status": 17}),
            ("project_resources", {"volume_status": 17}),
        ):
            with self.subTest(lookup=lookup, setting=setting):
                self.scenario(**setting)
                result = self.call(lookup)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("failed with status 17", result.stderr)

    def test_an_answer_that_is_not_a_list_of_identifiers_is_an_error(self):
        for output in ("Error response from daemon: boom", "WARNING: something", "id with spaces", "-flag", "ok\nbad one"):
            for lookup, kind in (("migrate_containers", "ps"), ("postgres_volume", "volume")):
                with self.subTest(output=output, lookup=lookup):
                    self.scenario(**{f"{kind}_output": output})
                    result = self.call(lookup)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("unexpected answer to docker", result.stderr)

    def test_an_empty_answer_is_an_empty_list(self):
        self.scenario(ps_output="", volume_output="")
        for lookup in ("project_resources", "migrate_containers", "postgres_volume"):
            with self.subTest(lookup=lookup):
                result = self.call(lookup)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "")

    def test_the_absence_of_the_migrate_container_is_only_confirmed_by_a_successful_lookup(self):
        self.scenario(ps_status=17)
        result = self.call('assert_no_migrate_container "still there"')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot list the migrate containers", result.stderr)
        self.scenario(ps_output="")
        self.assertEqual(self.call('assert_no_migrate_container "still there"').returncode, 0)
        self.scenario()
        result = self.call('assert_no_migrate_container "still there"')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still there", result.stderr)

    def test_removing_the_migrate_container_with_a_failed_lookup_removes_nothing(self):
        self.scenario(ps_status=17)
        result = self.call("remove_exited_migrate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.removals(), [])

    def test_the_project_must_be_unused(self):
        self.scenario(ps_output="", volume_output="")
        self.assertEqual(self.call("claim_project").returncode, 0)
        for setting in ({"ps_output": "abc123"}, {"volume_output": "somevolume"}, {"ps_status": 17}, {"volume_status": 17}):
            with self.subTest(setting=setting):
                self.scenario(**{"ps_output": "", "volume_output": "", **setting})
                self.assertNotEqual(self.call("claim_project").returncode, 0)

    def test_an_unscoped_lookup_would_be_caught(self):
        # The stand-in itself: without the project filter, the other stack's
        # container and volume would be selected.
        self.functions = self.functions.replace('--filter "label=com.docker.compose.project=$project"', "")
        self.assertEqual(
            sorted(self.call("migrate_containers").stdout.split()),
            ["other-migrate", "other-migrate-2", "rehearsal-migrate"],
        )
        self.assertEqual(
            sorted(self.call("postgres_volume").stdout.split()),
            sorted([f"{PROJECT}_postgres_data", f"{OTHER}_postgres_data", f"{OTHER}-2_postgres_data"]),
        )


class FullScriptTests(unittest.TestCase):
    """The whole script, from its first line to its EXIT trap."""

    def setUp(self):
        self.stand_ins = StandIns()
        base = self.stand_ins.make(self)
        self.workspace = base / "workspace"
        self.workspace.mkdir()
        (self.workspace / ".env.example").write_text(ENV_EXAMPLE)
        self.tmp = self.stand_ins.tmp

    def run_script(self, scenario=None, containers=(), volumes=()) -> subprocess.CompletedProcess:
        self.stand_ins.write_state(
            {"containers": list(containers), "volumes": list(volumes), "scenario": scenario or {}}
        )
        env = {
            **self.stand_ins.env,
            "CI": "true",
            "GITHUB_WORKSPACE": str(self.workspace),
            "HOME": str(self.stand_ins.base),
        }
        return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, check=False)

    def docker_calls(self, *prefix: str) -> list[dict]:
        return [
            call
            for call in self.stand_ins.recorded()
            if call["tool"] == "docker" and call["args"][: len(prefix)] == list(prefix)
        ]

    def deployed(self) -> bool:
        return bool(self.docker_calls("compose", "up"))

    def removals(self) -> list[list[str]]:
        return [call["args"] for call in self.stand_ins.recorded() if is_removal(call)]

    def checkouts(self) -> list[str]:
        return [call["args"][-1] for call in self.stand_ins.recorded() if call["tool"] == "git" and call["args"][:1] == ["checkout"]]

    def assert_nothing_happened(self, result: subprocess.CompletedProcess) -> None:
        """The script refused before it deployed or removed anything, and left
        nothing of its own behind."""
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse(self.deployed())
        self.assertEqual(self.removals(), [])
        self.assertEqual(self.docker_calls("compose", "logs"), [])
        self.assertEqual(self.checkouts(), [])  # the working tree is as it was
        self.assertFalse((self.workspace / ".env").exists())
        self.assertEqual([c for c in self.stand_ins.recorded() if c["tool"] == "mktemp"], [])
        self.assertEqual(list(self.tmp.iterdir()), [])

    def pre_existing(self, containers=(), volumes=()) -> tuple[list[dict], list[dict]]:
        foreign_containers, foreign_volumes = foreign_resources()
        return [*containers, *foreign_containers], [*volumes, *foreign_volumes]

    # -- A, B: a lookup that fails is not an empty project

    def test_a_failed_container_lookup_ends_the_script_before_anything_is_deployed(self):
        containers, volumes = self.pre_existing()
        result = self.run_script({"ps_status": 17}, containers, volumes)
        self.assert_nothing_happened(result)
        self.assertIn("failed with status 17", result.stderr)
        self.assertIn("FAIL:", result.stderr)

    def test_a_failed_volume_lookup_ends_the_script_before_anything_is_deployed(self):
        containers, volumes = self.pre_existing()
        result = self.run_script({"volume_status": 17}, containers, volumes)
        self.assert_nothing_happened(result)
        self.assertIn("failed with status 17", result.stderr)

    def test_an_answer_that_is_not_a_list_of_identifiers_ends_the_script_too(self):
        for scenario in ({"ps_output": "Error response from daemon: boom"}, {"volume_output": "WARNING: x y"}):
            with self.subTest(scenario=scenario):
                self.stand_ins.calls.unlink(missing_ok=True)
                self.assert_nothing_happened(self.run_script(scenario))

    # -- C, D: a project that already exists is rejected and left alone

    def test_an_existing_container_of_the_project_is_rejected_and_left_alone(self):
        existing = {"id": "preexisting", "status": "running", "labels": compose_labels(REHEARSAL, "web")}
        containers, volumes = self.pre_existing(containers=[existing])
        result = self.run_script({}, containers, volumes)
        self.assert_nothing_happened(result)
        self.assertIn("already exists", result.stderr)
        self.assertIn("preexisting", result.stderr)
        self.assertEqual(self.docker_calls("compose", "down"), [])
        self.assertEqual(self.stand_ins.remaining()[0], {c["id"] for c in containers})

    def test_an_existing_volume_of_the_project_is_rejected_and_left_alone(self):
        existing = {"name": "orphan-data", "labels": volume_labels(REHEARSAL)}
        containers, volumes = self.pre_existing(volumes=[existing])
        result = self.run_script({}, containers, volumes)
        self.assert_nothing_happened(result)
        self.assertIn("already exists", result.stderr)
        self.assertIn("orphan-data", result.stderr)
        self.assertEqual(self.docker_calls("compose", "down"), [])
        self.assertEqual(self.stand_ins.remaining()[1], {v["name"] for v in volumes})

    def test_a_working_tree_that_cannot_be_inspected_is_not_a_clean_one(self):
        result = self.run_script({"git_status_status": 128})
        self.assert_nothing_happened(result)
        self.assertIn("cannot inspect the working tree", result.stderr)

    # -- E: an unused project may be deployed to, and cleanup only follows

    def test_an_unused_project_is_deployed_to_and_cleanup_only_becomes_active_afterwards(self):
        containers, volumes = foreign_resources()
        result = self.run_script({}, containers, volumes)
        self.assertEqual(result.returncode, STOP, result.stderr)  # the stand-in ends the run at `compose exec`
        calls = self.stand_ins.recorded()
        kinds = [(call["tool"], *call["args"][:2]) for call in calls]
        lookups = [i for i, kind in enumerate(kinds) if kind[:2] in (("docker", "ps"), ("docker", "volume"))]
        deployment = kinds.index(("docker", "compose", "up"))
        self.assertTrue(lookups)
        self.assertLess(max(lookups[:2]), min(i for i, kind in enumerate(kinds) if kind[0] == "git" and kind[1] == "checkout"))
        self.assertLess(max(lookups[:2]), deployment)
        # No teardown of any kind before the deployment; the first is the cleanup after it.
        teardowns = [i for i, call in enumerate(calls) if is_removal(call)]
        self.assertEqual(len(teardowns), 1)
        self.assertGreater(teardowns[0], deployment)
        self.assertEqual(calls[teardowns[0]]["args"], ["compose", "down", "--volumes", "--remove-orphans"])
        self.assertEqual(len(self.docker_calls("compose", "up")), 1)

    # -- F: a failure after the ownership check is cleaned up, its status kept

    def test_a_failed_deployment_is_cleaned_up_and_keeps_its_exit_status(self):
        result = self.run_script({"up_status": 23})
        self.assertEqual(result.returncode, 23, result.stderr)
        calls = self.stand_ins.recorded()
        kinds = [(call["tool"], *call["args"][:2]) for call in calls]
        self.assertLess(kinds.index(("docker", "compose", "up")), kinds.index(("docker", "compose", "logs")))
        self.assertLess(kinds.index(("docker", "compose", "logs")), kinds.index(("docker", "compose", "down")))
        self.assertEqual(self.checkouts()[-1], "c0ffee")  # the commit under test is checked out again
        self.assertFalse((self.workspace / ".env").exists())
        # The scratch directory was made after the claim, and is gone again.
        self.assertEqual([c["tool"] for c in calls if c["tool"] == "mktemp"], ["mktemp"])
        self.assertEqual(list(self.tmp.iterdir()), [])
        # What the half-started deployment left behind is gone, and nothing else existed.
        self.assertEqual(self.stand_ins.remaining(), (set(), set()))

    def test_a_failing_cleanup_does_not_replace_the_original_exit_status(self):
        scenario = {"up_status": 23, "down_status": 1, "logs_status": 1, "checkout_status": {"c0ffee": 1}}
        result = self.run_script(scenario)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(len(self.docker_calls("compose", "down")), 1)
        self.assertEqual(self.checkouts()[-1], "c0ffee")  # attempted all the same
        self.assertEqual(list(self.tmp.iterdir()), [])

    # -- G: foreign projects are never selected or removed

    def test_resources_of_other_projects_are_never_selected_or_removed(self):
        containers, volumes = foreign_resources()
        before = ({c["id"] for c in containers}, {v["name"] for v in volumes})
        for scenario in ({"up_status": 23}, {}):
            with self.subTest(scenario=scenario):
                self.stand_ins.calls.unlink(missing_ok=True)
                result = self.run_script(scenario, containers, volumes)
                self.assertIn(result.returncode, (23, STOP), result.stderr)
                self.assertEqual(self.stand_ins.remaining(), before)
                foreign = before[0] | before[1]
                for call in self.stand_ins.recorded():
                    self.assertFalse(foreign & set(call["args"]), call)
                    if call["tool"] == "docker" and call["args"][:1] != ["compose"] and call["args"][:1] != ["ps"] and call["args"][:2] != ["volume", "ls"]:
                        self.fail(f"unexpected docker call {call}")
                projects = {call["project"] for call in self.docker_calls()}
                self.assertEqual(len(projects), 1, projects)
                (project,) = projects
                self.assertTrue(project.startswith(PREFIX) and project not in (OTHER, OTHER + "-2"), project)
                for call in self.docker_calls("compose"):
                    self.assertNotIn("--project-name", call["args"])
                    self.assertNotIn("-p", call["args"])

    # -- the same on the real script's text

    def test_the_cleanup_trap_is_armed_only_after_the_project_has_been_claimed(self):
        lines = code_lines(SCRIPT.read_text())
        claim = lines.index("claim_project")
        trap = lines.index("trap cleanup EXIT")
        self.assertLess(claim, trap)
        first_deploy = min(i for i, line in enumerate(lines) if re.search(r"^(up|checkout)\b", line))
        self.assertLess(trap, first_deploy)
        # The teardown exists once, in cleanup(), and cleanup() is reached only
        # through that trap: no other trap, no direct call, nothing before the claim.
        self.assertEqual(len([line for line in lines if re.search(r"compose down\b", line)]), 1)
        self.assertEqual([line for line in lines if re.search(r"\btrap\b", line)], ["    trap - EXIT", "trap cleanup EXIT"])
        self.assertEqual([line for line in lines if re.search(r"\bcleanup\b", line) and line != "trap cleanup EXIT"], ["cleanup() {"])
        # What runs before the trap (top-level lines; function bodies are indented) removes nothing.
        executed = [line for line in lines[:trap] if not line.startswith(" ") and not line.endswith("() {")]
        self.assertEqual([line for line in executed if re.search(r"\brm\b|remove_exited_migrate|\bdown\b", line)], [])

    def test_the_cleanup_cannot_replace_the_exit_status_or_run_twice(self):
        text = SCRIPT.read_text()
        body = re.search(r"\ncleanup\(\) \{\n(.*?)\n\}\n", text, re.S)[1]
        self.assertIn("local status=$?", body)
        self.assertIn("trap - EXIT", body)
        self.assertIn("set +e", body)
        self.assertRegex(body, r'exit "\$status"\s*$')


class ScriptIsolationTests(unittest.TestCase):
    def setUp(self):
        self.text = SCRIPT.read_text()
        self.lines = code_lines(self.text)
        self.scoped = code_lines(self.text[self.text.index(BEGIN) : self.text.index(END)])

    def test_nothing_is_pruned(self):
        for line in self.lines:
            self.assertNotIn("prune", line)

    def test_every_lookup_or_removal_outside_compose_is_project_scoped(self):
        pattern = re.compile(r"\bdocker (ps|volume|container|rm|rmi|system|network|image)\b|\bdocker_ids\b")
        outside = [line for line in self.lines if pattern.search(line) and line not in self.scoped]
        self.assertEqual(outside, [])
        lookups = [line for line in self.scoped if re.search(r"\bdocker_ids (ps|volume ls)\b", line)]
        self.assertTrue(lookups)
        for line in lookups:
            self.assertIn('--filter "label=com.docker.compose.project=$project"', line)
        # The one place that runs docker for them is docker_ids; nothing else lists.
        raw = [line for line in self.scoped if re.search(r"\bdocker (ps|volume)\b", line)]
        self.assertEqual(raw, [])

    def test_a_lookup_failure_is_never_masked_by_a_command_substitution(self):
        # `[ -z "$(lookup)" ]` reads a failed lookup as an empty one.
        for line in self.lines:
            self.assertNotRegex(line, r'-z "\$\((migrate_containers|project_resources|project_containers|project_volumes|postgres_volume|docker_ids)')

    def test_the_project_name_is_unique_and_set_before_any_docker_command(self):
        assignment = self.lines.index("COMPOSE_PROJECT_NAME=sentinel-upgrade-rehearsal-$$-$token")
        self.assertEqual(self.lines[assignment + 1], "export COMPOSE_PROJECT_NAME")
        self.assertEqual(self.lines[assignment + 2], "readonly COMPOSE_PROJECT_NAME")
        first_docker = min(i for i, line in enumerate(self.lines) if re.search(r"\bdocker\b", line))
        self.assertLess(assignment, first_docker)
        for line in self.lines:
            self.assertNotRegex(line, r"docker compose .*(-p |--project-name)")

    def test_it_refuses_to_run_outside_ci_before_doing_anything(self):
        guard = self.lines.index(
            '[ "${CI:-}" = true ] || fail "CI only: it checks out other commits and restarts the Docker daemon"'
        )
        for command in (r"^cd ", r"\bgit\b", r"\bdocker\b", r"\bsudo\b"):
            first = min(i for i, line in enumerate(self.lines) if re.search(command, line))
            self.assertLess(guard, first, command)

    def test_it_refuses_to_run_outside_ci_when_run(self):
        stand_ins = StandIns()
        stand_ins.make(self)
        for ci in (None, "", "false", "1"):
            with self.subTest(ci=ci):
                env = {**stand_ins.env, **({} if ci is None else {"CI": ci})}
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("CI only", result.stderr)
                self.assertEqual(stand_ins.recorded(), [])


if __name__ == "__main__":
    unittest.main()

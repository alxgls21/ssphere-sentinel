"""Judges the evidence of the Compose rehearsal .github/scripts/separate-roles-e2e.sh.

The rehearsal gathers facts from Docker (what each container holds, the order
containers started in, its own log); this program decides what they mean, so
that the decisions are code that tests/deployment/test_compose_e2e.py runs
without Docker:

  isolation DIR --secrets FILE   what each container's environment and processes hold
  config FILE --secrets FILE     what `docker compose config --format json` would give each service
  order FILE --expect ...        the order in which containers started, became healthy and exited
  report --log FILE ...          whether the rehearsal ran every scenario it announced

It never prints a secret: only the names of variables and the kind of secret
(runtime, migration, bootstrap, django, pepper, retired). Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# The names of variables taken for secrets. (Not KEY: the Python image has GPG_KEY, a public key id.) The values
# of the stack's own secrets are looked for whatever the variable is called, in any case.
SECRET_NAME = re.compile(r"PASSWORD|SECRET|TOKEN|PEPPER")
KINDS = ("runtime", "migration", "bootstrap", "django", "pepper")
# A value this short is not a secret of the stack, and would match anything.
MINIMUM_LENGTH = 16

OWN = "own"

# What each service may hold. migrate holds the application's keys because its settings need them at import
# (sentinel/settings.py: manage.py migrate does not start without them). variables: the secret-like
# variables it has, and what each is:
# a kind of secret (its value is that secret), "" (the variable is there, blank, on purpose) or OWN
# (a secret that is the service's own and none of the stack's: the notifier's SMTP password).
# Any other secret-like variable with a value is a finding.
SERVICES = {
    "web": {
        "kinds": {"runtime", "django", "pepper"},
        "variables": {
            "SENTINEL_DB_PASSWORD": "runtime",
            "DJANGO_SECRET_KEY": "django",
            "AGENT_TOKEN_PEPPER": "pepper",
            "SENTINEL_DB_MIGRATE_PASSWORD": "",
            "SENTINEL_SMTP_PASSWORD": "",
        },
    },
    "migrate": {
        "kinds": {"migration", "django", "pepper"},
        "variables": {
            "SENTINEL_DB_MIGRATE_PASSWORD": "migration",
            "DJANGO_SECRET_KEY": "django",
            "AGENT_TOKEN_PEPPER": "pepper",
            "SENTINEL_DB_PASSWORD": "",
            "SENTINEL_SMTP_PASSWORD": "",
        },
    },
    "db": {"kinds": {"bootstrap"}, "variables": {"POSTGRES_PASSWORD": "bootstrap"}},
    # The workers log in as web does, and hold no SMTP password but the notifier's own.
    "alert-engine": {
        "kinds": {"runtime", "django", "pepper"},
        "variables": {
            "SENTINEL_DB_PASSWORD": "runtime",
            "DJANGO_SECRET_KEY": "django",
            "AGENT_TOKEN_PEPPER": "pepper",
            "SENTINEL_DB_MIGRATE_PASSWORD": "",
            "SENTINEL_SMTP_PASSWORD": "",
        },
    },
    "notifier": {
        "kinds": {"runtime", "django", "pepper"},
        "variables": {
            "SENTINEL_DB_PASSWORD": "runtime",
            "DJANGO_SECRET_KEY": "django",
            "AGENT_TOKEN_PEPPER": "pepper",
            "SENTINEL_DB_MIGRATE_PASSWORD": "",
            "SENTINEL_SMTP_PASSWORD": OWN,
        },
    },
}
# Services of a Compose profile: in the configuration only once the profile is enabled.
OPTIONAL = {"notifier"}

# What the files of an evidence directory are. Processes: one block for each process the container
# has, "## <pid> <command line>" and then its environment, as the separate-roles-e2e.sh collects them.
# What must be in them to be evidence at all (the processes of the container's own program, whose
# environment could be read: the ones the exec that collects them starts have the container's
# configuration too, and prove nothing).
PROCESSES = {
    "web.processes": ("web", "gunicorn", "SENTINEL_DB_ACCESS=runtime"),
    "db.processes": ("db", "postgres", "PG_MAJOR="),
}
ENVIRONMENTS = ("web.env", "migrate.env", "db.env", "alert-engine.env")
MOUNTS = ("web.mounts", "migrate.mounts", "db.mounts", "alert-engine.mounts")
EMPTY = ("web.files",)  # what must not exist, one path per line: nothing
LOGS = "logs"


class Evidence(Exception):
    """The evidence cannot be judged (not a finding about the stack)."""


def load_secrets(path: str) -> dict[str, list[str]]:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise Evidence(f"the secrets cannot be read: {exc}") from None
    secrets = {kind: list(data.get(kind, [])) for kind in (*KINDS, "retired")}
    for kind, values in secrets.items():
        if kind != "retired" and not values:
            raise Evidence(f"no {kind} secret given")
        for value in values:
            if len(value) < MINIMUM_LENGTH:
                raise Evidence(f"a {kind} secret is too short to look for safely")
    return secrets


def parse_environment(text: str) -> dict[str, str]:
    """NAME=value lines (what docker inspect prints of Config.Env)."""
    environment = {}
    for line in text.splitlines():
        name, separator, value = line.partition("=")
        if separator and name:
            environment[name] = value
    return environment


def holds(text: str, secrets: dict[str, list[str]], kinds: set[str]) -> list[str]:
    """The kinds of secret in ``text`` among ``kinds``, retired ones always."""
    found = []
    for kind in sorted(kinds | {"retired"}):
        if any(value in text for value in secrets[kind]):
            found.append(kind)
    return found


def judge_environment(service: str, environment: dict[str, str], secrets: dict[str, list[str]]) -> list[str]:
    """What is wrong with the environment ``service`` is given: names and kinds, never values."""
    allowed = SERVICES[service]
    problems = []
    for name, value in sorted(environment.items()):
        expected = allowed["variables"].get(name)
        if expected is None:
            if SECRET_NAME.search(name) and value:
                problems.append(f"{service}: {name} is set, and the service has no use for it")
        elif expected == "":
            if value:
                problems.append(f"{service}: {name} must be blank")
        elif expected == OWN:
            pass  # whatever it is, as long as it is no secret of the stack (below)
        elif value not in secrets[expected]:
            problems.append(f"{service}: {name} is not the {expected} secret")
        # Whatever the variable is, a secret that is not the service's own, or is retired, is a leak.
        for kind in holds(value, secrets, set(KINDS) - allowed["kinds"]):
            problems.append(f"{service}: {name} holds the {kind} secret")
    for name, expected in allowed["variables"].items():
        if expected and expected != OWN and name not in environment:
            problems.append(f"{service}: {name} is missing")
    return sorted(set(problems))


def processes(text: str) -> list[tuple[str, list[str], str]]:
    """(pid, command line words, environment) of each block of a process dump."""
    blocks, current = [], None
    for line in text.splitlines():
        if line.startswith("## "):
            pid, _, command = line[3:].partition(" ")
            current = (pid, command.split(), [])
            blocks.append(current)
        elif current is not None:
            current[2].append(line)
    return [(pid, command, "\n".join(environment).strip()) for pid, command, environment in blocks]


def judge_processes(
    label: str, text: str, owner: str, program: str, marker: str, secrets: dict[str, list[str]]
) -> list[str]:
    """What the processes of a container hold: its own kinds of secret in their environment, none on a
    command line, and the program the container is for among those that could be read."""
    problems = []
    found = processes(text)
    readable = [(pid, command, environment) for pid, command, environment in found if environment]
    kinds = SERVICES[owner]["kinds"]
    own = [
        pid
        for pid, command, environment in readable
        if marker in environment
        and any(os.path.basename(word) == program or os.path.basename(word).startswith(program + ":") for word in command[:2])
    ]
    if not own:
        problems.append(f"{label}: the evidence does not show the environment of {program} ({len(readable)} of {len(found)} "
                        "processes could be read)")
    for pid, command, environment in found:
        for kind in holds(" ".join(command), secrets, set(KINDS)):
            problems.append(f"{label}: the command line of process {pid} holds the {kind} secret")
        for kind in holds(environment, secrets, set(KINDS) - kinds):
            problems.append(f"{label}: the environment of process {pid} holds the {kind} secret")
    return sorted(set(problems))


def judge_log(label: str, text: str, secrets: dict[str, list[str]]) -> list[str]:
    return [f"{label}: holds the {kind} secret" for kind in holds(text, secrets, set(KINDS))]


def isolation(directory: str, secrets_path: str) -> list[str]:
    secrets = load_secrets(secrets_path)
    base = Path(directory)
    problems: list[str] = []

    def read(name: str) -> str:
        path = base / name
        if not path.is_file():
            raise Evidence(f"evidence missing: {name}")
        return path.read_text(errors="replace")

    for name in ENVIRONMENTS:
        service = name.split(".")[0]
        problems += judge_environment(service, parse_environment(read(name)), secrets)
    for name, (owner, program, marker) in PROCESSES.items():
        problems += judge_processes(name, read(name), owner, program, marker, secrets)
    problems += judge_log(LOGS, read(LOGS), secrets)
    for name in MOUNTS:
        service = name.split(".")[0]
        try:
            mounts = json.loads(read(name) or "[]")
        except ValueError as exc:
            raise Evidence(f"{name} is not JSON: {exc}") from None
        for mount in mounts or []:
            kind = mount.get("Type")
            source = str(mount.get("Source", ""))
            if kind == "tmpfs":  # scratch space in memory, which compose.yml gives every Sentinel service on purpose
                continue
            if service != "db" or kind != "volume" or re.search(r"\.env|\.bootstrap|\.migrate", source):
                problems.append(f"{service}: mounts a {kind} that is not the database volume")
    for name in EMPTY:
        if read(name).strip():
            problems.append(f"{name.split('.')[0]}: the image holds files of the environment: {read(name).split()[0]}")
    return problems


def config(text: str, secrets_path: str) -> list[str]:
    """The services `docker compose config --format json` gives: each its own password only."""
    secrets = load_secrets(secrets_path)
    try:
        services = json.loads(text)["services"]
    except (ValueError, KeyError) as exc:
        raise Evidence(f"not a Compose configuration: {exc}") from None
    if not set(SERVICES) - OPTIONAL <= set(services) <= set(SERVICES):
        raise Evidence(f"the services are {sorted(services)}, not {sorted(SERVICES)}")
    problems = []
    for service in sorted(set(services)):
        environment = {name: str(value) for name, value in (services[service].get("environment") or {}).items()
                       if value is not None}
        problems += judge_environment(service, environment, secrets)
    return problems


# --- the order of events -------------------------------------------------------

def events(text: str) -> list[tuple[str, str]]:
    """(service, event) of each container event, in the order docker events printed them: start,
    healthy, unhealthy, die=<exit code>."""
    found = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            raise Evidence(f"not an event: {line[:60]}") from None
        attributes = (event.get("Actor") or {}).get("Attributes") or {}
        service = attributes.get("com.docker.compose.service")
        action = event.get("Action") or event.get("status") or ""
        if not service:
            continue
        if action == "start":
            found.append((service, "start"))
        elif action == "die":
            found.append((service, f"die={attributes.get('exitCode', '?')}"))
        elif action.startswith("health_status"):
            found.append((service, action.split(":")[-1].strip()))
    return found


def order(text: str, expected: list[str], absent: list[str]) -> list[str]:
    """``expected`` (service:event, with die or die=<code>) first happened in that order, ``absent`` never did.
    The first time counts: a web that started before the migration ended, and again after it, did not wait."""
    seen = events(text)
    problems = []
    position, previous = -1, "the start"
    for wanted in expected:
        first = next((index for index, event in enumerate(seen) if matches(event, wanted)), None)
        if first is None:
            problems.append(f"{wanted} did not happen after {previous}")
            break
        if first < position:
            problems.append(f"{wanted} happened before {previous}")
            break
        position, previous = first, wanted
    for wanted in absent:
        if any(matches(event, wanted) for event in seen):
            problems.append(f"{wanted} happened, and must not have")
    return problems


def matches(event: tuple[str, str], wanted: str) -> bool:
    """Whether ``event`` is ``wanted``: service:start, service:healthy, service:die (any exit
    code) or service:die=<exit code>."""
    service, _, name = wanted.partition(":")
    there_service, there_event = event
    return there_service == service and (there_event == name or (name == "die" and there_event.startswith("die=")))


# --- the report of a run --------------------------------------------------------

def report(log: str, postgres: str, compose: str) -> tuple[list[str], str]:
    """What is wrong with a run of the rehearsal, and its summary (markdown)."""
    lines = log.splitlines()
    problems: list[str] = []
    identity = next((line for line in lines if line.startswith("E2E compose=")), "")
    server = next((line for line in lines if line.startswith("E2E server ")), "")
    announced = next((line.split(":", 1)[1].split() for line in lines if line.startswith("E2E scenarios:")), [])
    passed = [line.split()[2] for line in lines if line.startswith("SCENARIO PASS ") and len(line.split()) == 3]
    result = next((line for line in lines if line.startswith("E2E RESULT:")), "")
    version = (re.search(r"E2E server (\S+)", server) or [None, ""])[1]

    if identity != f"E2E compose={compose.removeprefix('v')} postgres={postgres}":
        problems.append(f"the run is not of Compose {compose} and PostgreSQL {postgres}: {identity or 'no identification'}")
    if not version.startswith(f"{postgres}."):
        problems.append(f"the server is PostgreSQL {version or '(unknown)'}, not {postgres}")
    if not announced:
        problems.append("the run announced no scenarios")
    if passed != announced:
        missing = [name for name in announced if name not in passed]
        problems.append(f"scenarios not passed: {', '.join(missing) or 'out of order'}")
    if result != f"E2E RESULT: passed {len(announced)} of {len(announced)}":
        problems.append(f"the run did not end with its result: {result or 'no result line'}")
    failures = [line for line in lines if line.startswith("FAIL:")]
    if failures:
        problems.append(f"{len(failures)} failure(s): {failures[0]}")
    running = [line for line in lines if line.startswith("== ")]
    if problems and running:
        problems.append(f"last step begun: {running[-1][3:]}")

    verdict = "passed" if not problems else "FAILED"
    summary = (f"### Compose {compose}, PostgreSQL {version or postgres}: "
               f"{len(passed)} of {len(announced)} scenarios, {verdict}\n\n")
    summary += "\n".join(f"- {'passed' if name in passed else 'NOT PASSED'}: {name}" for name in announced) + "\n"
    if problems:
        summary += "\n" + "\n".join(f"- {problem}" for problem in problems) + "\n"
    return problems, summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("isolation")
    one.add_argument("directory")
    one.add_argument("--secrets", required=True)
    two = commands.add_parser("config")
    two.add_argument("--secrets", required=True)
    three = commands.add_parser("order")
    three.add_argument("events")
    three.add_argument("--expect", nargs="*", default=[])
    three.add_argument("--absent", nargs="*", default=[])
    four = commands.add_parser("report")
    four.add_argument("--log", required=True)
    four.add_argument("--postgres", required=True)
    four.add_argument("--compose", required=True)
    arguments = parser.parse_args(argv)

    try:
        if arguments.command == "isolation":
            problems = isolation(arguments.directory, arguments.secrets)
            what = "each container holds its own secrets only"
        elif arguments.command == "config":
            problems = config(sys.stdin.read(), arguments.secrets)
            what = "Compose gives each service its own secrets only"
        elif arguments.command == "order":
            problems = order(Path(arguments.events).read_text(), arguments.expect, arguments.absent)
            what = "the containers started in order: " + " ".join(arguments.expect)
        else:
            log = Path(arguments.log).read_text(errors="replace")
            problems, summary = report(log, arguments.postgres, arguments.compose)
            print(summary)
            target = os.environ.get("GITHUB_STEP_SUMMARY")
            if target:
                with open(target, "a", encoding="utf-8") as file:
                    file.write(summary + "\n")
            return 1 if problems else 0
    except (Evidence, OSError) as exc:
        print(f"compose_e2e: {exc}", file=sys.stderr)
        return 2
    for problem in problems:
        print(f"compose_e2e: {problem}", file=sys.stderr)
    if not problems:
        print(f"compose_e2e: {what}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

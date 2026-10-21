"""Guards for the shipped deployment files: security properties that must not
regress silently (non-root, no Docker socket by default, no secrets)."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SYSTEMD = ROOT / "deploy" / "systemd"


def unit_directives(path: Path) -> dict[str, list[str]]:
    """Parse a systemd unit into {"Section.Key": [values]} (keys may repeat)."""
    directives: dict[str, list[str]] = {}
    section = ""
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        key, _, value = line.partition("=")
        directives.setdefault(f"{section}.{key.strip()}", []).append(value.strip())
    return directives


class AgentUnitTests(unittest.TestCase):
    def setUp(self):
        self.unit = unit_directives(SYSTEMD / "sentinel-agent.service")

    def value(self, key: str) -> str:
        (value,) = self.unit[key]
        return value

    def test_runs_unprivileged_from_the_venv(self):
        self.assertEqual(self.value("Service.User"), "sentinel-agent")
        self.assertEqual(self.value("Service.Group"), "sentinel-agent")
        self.assertEqual(
            self.value("Service.ExecStart"),
            "/opt/ssphere-sentinel-agent/venv/bin/sentinel-agent run",
        )
        self.assertEqual(self.value("Service.CapabilityBoundingSet"), "")
        self.assertEqual(self.value("Service.AmbientCapabilities"), "")
        self.assertEqual(self.value("Service.NoNewPrivileges"), "yes")

    def test_icmp_uses_unprivileged_sockets_not_capabilities(self):
        # ping must not regain CAP_NET_RAW through the unit or a shipped drop-in.
        for path in SYSTEMD.glob("*"):
            if path.suffix in {".service", ".conf"}:
                directives = unit_directives(path)
                for key in ("Service.CapabilityBoundingSet", "Service.AmbientCapabilities"):
                    self.assertNotIn("CAP_NET_RAW", " ".join(directives.get(key, [])), path.name)
        helper = SYSTEMD / "enable-unprivileged-icmp.sh"
        self.assertTrue(os.access(helper, os.X_OK), "helper must be executable")
        self.assertIn("net.ipv4.ping_group_range = $gid $gid", helper.read_text())
        # The end-to-end CI test applies the shipped helper, not its own fix.
        e2e = (ROOT / ".github" / "scripts" / "agent-systemd-e2e.sh").read_text()
        self.assertIn("sh deploy/systemd/enable-unprivileged-icmp.sh", e2e)

    def test_docker_socket_access_is_not_granted_by_default(self):
        self.assertNotIn("Service.SupplementaryGroups", self.unit)
        dropin = unit_directives(SYSTEMD / "docker-monitoring.conf")
        self.assertEqual(dropin["Service.SupplementaryGroups"], ["docker"])

    def test_token_only_comes_from_the_environment_file(self):
        self.assertEqual(
            self.value("Service.EnvironmentFile"), "/etc/ssphere-sentinel-agent/agent.env"
        )
        text = (SYSTEMD / "sentinel-agent.service").read_text()
        self.assertNotIn("SENTINEL_AGENT_TOKEN", text)

    def test_persistent_queue_in_private_state_directory(self):
        self.assertEqual(self.value("Service.StateDirectory"), "ssphere-sentinel-agent")
        self.assertEqual(self.value("Service.StateDirectoryMode"), "0700")
        self.assertIn(
            "SENTINEL_QUEUE_PATH=/var/lib/ssphere-sentinel-agent/network-queue.sqlite3",
            self.unit["Service.Environment"],
        )
        self.assertEqual(self.value("Service.WorkingDirectory"), "/var/lib/ssphere-sentinel-agent")

    def test_restart_and_shutdown_behaviour(self):
        self.assertEqual(self.value("Service.Restart"), "on-failure")
        # SIGTERM to the agent only; probes in flight are allowed to finish.
        self.assertEqual(self.value("Service.KillMode"), "mixed")
        self.assertEqual(self.value("Install.WantedBy"), "multi-user.target")
        self.assertIn("network-online.target", self.value("Unit.After"))

    def test_sandboxing(self):
        expected = {
            "ProtectSystem": "strict",
            "ProtectHome": "yes",
            "PrivateTmp": "yes",
            "PrivateDevices": "yes",
            "ProtectKernelTunables": "yes",
            "ProtectKernelModules": "yes",
            "ProtectControlGroups": "yes",
            "RestrictSUIDSGID": "yes",
            "MemoryDenyWriteExecute": "yes",
            "SystemCallArchitectures": "native",
            "UMask": "0077",
        }
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertEqual(self.value(f"Service.{key}"), value)

    def test_environment_template_contains_no_real_secret(self):
        text = (SYSTEMD / "agent.env.example").read_text()
        self.assertIn("SENTINEL_AGENT_TOKEN=replace-with-the-agent-token", text)
        self.assertIn("SENTINEL_URL=https://", text)
        self.assertIn("-m 0600 -o root -g root", text)


class DockerImageTests(unittest.TestCase):
    def setUp(self):
        self.dockerfile = (ROOT / "Dockerfile").read_text()
        self.instructions = [
            line.strip()
            for line in re.sub(r"\\\n", " ", self.dockerfile).splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]

    def test_runs_as_non_root(self):
        users = [line for line in self.instructions if line.startswith("USER ")]
        self.assertEqual(users, ["USER sentinel:sentinel"])
        # USER comes after every RUN in the final stage.
        final_stage = self.instructions[
            max(i for i, line in enumerate(self.instructions) if line.startswith("FROM ")):
        ]
        last_run = max(i for i, line in enumerate(final_stage) if line.startswith("RUN "))
        user = next(i for i, line in enumerate(final_stage) if line.startswith("USER "))
        self.assertGreater(user, last_run)

    def test_dependencies_are_hash_pinned_wheels(self):
        self.assertIn("--require-hashes --only-binary=:all:", self.dockerfile)
        self.assertIn("requirements/server.txt", self.dockerfile)

    def test_base_image_is_pinned_and_supported(self):
        (arg,) = [line for line in self.instructions if line.startswith("ARG PYTHON_IMAGE=")]
        image = arg.split("=", 1)[1]
        self.assertRegex(image, r"^python:3\.\d+-slim-[a-z]+$")
        self.assertNotIn(":latest", self.dockerfile)

    def test_lock_file_is_resolved_for_the_image_python(self):
        (arg,) = [line for line in self.instructions if line.startswith("ARG PYTHON_IMAGE=")]
        image_python = re.search(r"python:(3\.\d+)-", arg).group(1)
        lock = (ROOT / "requirements" / "server.txt").read_text()
        self.assertIn(f"(Linux, CPython {image_python})", lock)

    def test_no_secrets_baked_into_the_image(self):
        env_lines = [line for line in self.instructions if line.startswith("ENV ")]
        for line in env_lines:
            self.assertNotRegex(line, r"SECRET|PEPPER|PASSWORD|TOKEN")

    def test_healthcheck_and_graceful_server(self):
        self.assertIn("HEALTHCHECK", self.dockerfile)
        self.assertIn("/health/ready/", self.dockerfile)
        self.assertIn('CMD ["gunicorn"', self.dockerfile)
        self.assertIn('exec "$@"', (ROOT / "entrypoint.sh").read_text())

    def test_build_context_is_an_allowlist(self):
        lines = [
            line.strip()
            for line in (ROOT / ".dockerignore").read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
        self.assertEqual(lines[0], "*")
        self.assertFalse([line for line in lines if ".env" in line and line.startswith("!")])


def interpolate(text: str, environment: dict[str, str]) -> str:
    """Resolve ``${NAME:-default}`` the way Compose does."""

    def substitute(match: re.Match) -> str:
        return environment.get(match["name"]) or match["default"]

    return re.sub(r"\$\{(?P<name>[A-Z_0-9]+):-(?P<default>[^}]*)\}", substitute, text)


def dotenv_values(path: Path) -> dict[str, str]:
    """The assignments of an env file (comments and blank lines ignored)."""
    values = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            name, _, value = line.partition("=")
            values[name.strip()] = value.strip()
    return values


POSTGRES_DIR = ROOT / "deploy" / "postgres"
# The .env of an installation made before SENTINEL_DB_ROLES existed (frozen).
LEGACY_ENV = Path(__file__).parent / "legacy.env.example"
# Volume and mount of each supported PostgreSQL major version. 16 keeps the
# layout (and volume) of installations that predate version selection.
LAYOUTS = {
    "16": ("postgres_data", "/var/lib/postgresql/data"),
    "18": ("postgres18_data", "/var/lib/postgresql"),
}
# The long-running processes beside web: the image again, the runtime login, no migrations.
WORKERS = {"alert-engine": "run_alert_engine", "notifier": "run_notifier", "domain-verifier": "run_domain_verifier"}


class ComposeTests(unittest.TestCase):
    def setUp(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - CI installs PyYAML
            self.skipTest("PyYAML is not installed")
        self.yaml = yaml
        self.compose = yaml.safe_load((ROOT / "compose.yml").read_text())
        self.tunnel = yaml.safe_load((ROOT / "compose.tunnel.yml").read_text())

    def version_file(self, major: str) -> dict:
        return self.yaml.safe_load((POSTGRES_DIR / f"postgres-{major}.yml").read_text())

    def selected_file(self, environment: dict[str, str]) -> Path:
        """The database file Compose includes for ``environment`` (the .env values)."""
        (include,) = self.compose["include"]
        return ROOT / interpolate(include["path"], environment)

    def database(self, environment: dict[str, str]) -> dict:
        """The db service and volumes Compose resolves for ``environment``."""
        document = self.yaml.safe_load(self.selected_file(environment).read_text())
        return {"file": self.selected_file(environment).name, **document}

    def test_service_and_volume_names_preserve_existing_data(self):
        self.assertNotIn("name", self.compose)  # project name drives volume names
        self.assertEqual(set(self.compose["services"]), {"web", "migrate", "proxy", *WORKERS})
        self.assertNotIn("volumes", self.compose)
        self.assertEqual(self.database({})["services"].keys(), {"db"})

    def test_the_database_comes_from_a_file_selected_by_one_setting(self):
        (include,) = self.compose["include"]
        self.assertEqual(include["path"], "deploy/postgres/postgres-${SENTINEL_POSTGRES:-16}.yml")
        # Compose 2.20 does not pass the project's .env to an included file
        # unless it is named; naming it works in every release. The second file
        # holds the bootstrap password with the separate logins (below).
        self.assertEqual(include["project_directory"], ".")
        self.assertEqual(include["env_file"][0], ".env")
        self.assertEqual(
            sorted(path.name for path in POSTGRES_DIR.iterdir()),
            [f"postgres-{major}.yml" for major in sorted(LAYOUTS)],
        )

    def test_an_existing_installation_keeps_its_postgresql_16_service_unchanged(self):
        # An .env without SENTINEL_POSTGRES belongs to an installation that
        # predates PostgreSQL 18: pulling this file must not change its database.
        database = self.database({})
        self.assertEqual(database["file"], "postgres-16.yml")
        reference = self.yaml.safe_load((Path(__file__).parent / "postgres16-reference.yml").read_text())
        self.assertEqual(database["services"], reference["services"])
        self.assertEqual(database["volumes"], reference["volumes"])
        # The same for the .env such an installation actually has.
        self.assertEqual(self.database(dotenv_values(LEGACY_ENV)), database)

    def test_the_example_does_not_authorize_database_initialization(self):
        # Copying the example's lines into an existing installation must not
        # carry the authorization along with the version.
        example = dotenv_values(ROOT / ".env.example")
        self.assertNotIn("SENTINEL_POSTGRES_INITIALIZE", example)
        self.assertIn("# SENTINEL_POSTGRES_INITIALIZE=true", (ROOT / ".env.example").read_text())

    def test_a_new_installation_runs_postgresql_18_with_the_versioned_layout(self):
        example = dotenv_values(ROOT / ".env.example")
        self.assertEqual(example["SENTINEL_POSTGRES"], "18")
        database = self.database(example)
        self.assertEqual(database["file"], "postgres-18.yml")
        self.assertEqual(database["services"]["db"]["image"], "postgres:18-alpine")

    def test_each_version_file_pairs_its_image_with_its_own_volume_and_mount(self):
        # A major version never meets another version's cluster: the image, the
        # volume and the mount are chosen together, in one file.
        for major, (volume, mount) in LAYOUTS.items():
            with self.subTest(major=major):
                document = self.version_file(major)
                db = document["services"]["db"]
                self.assertEqual(db["image"], f"postgres:{major}-alpine")
                self.assertEqual(db["volumes"], [f"{volume}:{mount}"])
                self.assertEqual(set(document["volumes"]), {volume})
                # The image's own PGDATA belongs to its layout.
                self.assertNotIn("PGDATA", db["environment"])
        self.assertEqual(len({volume for volume, _ in LAYOUTS.values()}), len(LAYOUTS))

    def test_version_files_differ_only_in_image_volume_and_initialization_guard(self):
        guard = ("entrypoint", "command")

        def comparable(major: str) -> dict:
            document = self.version_file(major)
            db = {**document["services"]["db"], "image": None, "volumes": None}
            for key in guard:
                db.pop(key, None)
            db["environment"] = {
                name: value
                for name, value in db["environment"].items()
                if name != "SENTINEL_POSTGRES_INITIALIZE"
            }
            return {"services": {"db": db}, "top_level_keys": sorted(document)}

        majors = sorted(LAYOUTS)
        for other in majors[1:]:
            self.assertEqual(comparable(majors[0]), comparable(other))

    def test_a_selection_without_a_version_file_cannot_resolve(self):
        for value in ("17", "18-alpine", "latest", "../x"):
            with self.subTest(value=value):
                self.assertFalse(self.selected_file({"SENTINEL_POSTGRES": value}).is_file())

    def test_postgres_is_not_published(self):
        for major in LAYOUTS:
            self.assertNotIn("ports", self.version_file(major)["services"]["db"])

    def test_web_service_hardening(self):
        web = self.compose["services"]["web"]
        workers = [self.compose["services"][name] for name in WORKERS]
        for service in (web, self.compose["services"]["migrate"], *workers):
            self.assertTrue(service["read_only"])
            self.assertEqual(service["tmpfs"], ["/tmp"])
            self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertIn("no-new-privileges:true", service["security_opt"])
            self.assertTrue(service["init"])
            self.assertEqual(service["depends_on"]["db"]["condition"], "service_healthy")
            self.assertEqual(service["logging"]["options"]["max-size"], "10m")
        services = [web, *workers] + [self.version_file(major)["services"]["db"] for major in LAYOUTS]
        for service in services:
            self.assertEqual(service["restart"], "unless-stopped")
            self.assertEqual(service["logging"]["options"]["max-size"], "10m")
        for major in LAYOUTS:
            db = self.version_file(major)["services"]["db"]
            self.assertIn("no-new-privileges:true", db["security_opt"])

    def test_migrations_run_in_a_one_shot_service_that_web_waits_for(self):
        migrate = self.compose["services"]["migrate"]
        web = self.compose["services"]["web"]
        self.assertEqual(migrate["build"], web["build"])  # the same image
        self.assertEqual(migrate["command"], ["apply-migrations"])
        # It runs on every `docker compose up` and exits; a reboot does not
        # start it again (web, already migrated, restarts on its own).
        self.assertEqual(migrate["restart"], "no")
        self.assertEqual(migrate["healthcheck"], {"disable": True})
        self.assertEqual(set(migrate["depends_on"]), {"db"})
        self.assertEqual(web["depends_on"]["migrate"], {"condition": "service_completed_successfully"})
        self.assertNotIn("ports", migrate)
        self.assertEqual(migrate["environment"]["SENTINEL_DB_ACCESS"], "migrate")
        self.assertEqual(web["environment"]["SENTINEL_DB_ACCESS"], "runtime")
        for name in ("POSTGRES_HOST", "POSTGRES_PORT"):
            self.assertEqual(migrate["environment"][name], web["environment"][name])

    def test_the_workers_run_the_image_with_the_runtime_login_and_never_migrate(self):
        services = self.compose["services"]
        web = services["web"]
        for name, command in WORKERS.items():
            with self.subTest(worker=name):
                worker = services[name]
                self.assertEqual(worker["build"], web["build"])  # the same image
                self.assertEqual(worker["command"][:3], ["python", "manage.py", command])
                self.assertNotIn("ports", worker)
                self.assertEqual(worker["restart"], "unless-stopped")
                environment = worker["environment"]
                self.assertEqual(environment["SENTINEL_DB_ACCESS"], "runtime")
                self.assertEqual(environment["SENTINEL_PROCESS"], "worker")
                for key in ("POSTGRES_HOST", "POSTGRES_PORT"):
                    self.assertEqual(environment[key], web["environment"][key])
                self.assertNotIn("SENTINEL_PROCESS", web["environment"])
                # After migrate, and with web, which applies the migrations with the default
                # logins: the worker waits for them, so that a long migration does not fail `up`
                # (web turns unhealthy while it migrates).
                self.assertEqual(worker["depends_on"], {
                    "db": {"condition": "service_healthy"},
                    "migrate": {"condition": "service_completed_successfully"},
                    "web": {"condition": "service_started"},
                })
                # The image's health check probes Gunicorn: a worker's checks its liveness file instead.
                (flag, path) = worker["command"][3:]
                self.assertEqual(flag, "--liveness-file")
                self.assertTrue(path.startswith("/tmp/"))  # the tmpfs: the root file system is read-only
                self.assertEqual(worker["healthcheck"]["test"], ["CMD", "python", "-m", "apps.alerts.runtime", path])
                # SIGTERM ends the cycle in progress first.
                self.assertRegex(worker["stop_grace_period"], r"^\d+s$")
                self.assertGreaterEqual(int(worker["stop_grace_period"][:-1]), 60)
        # The alert engine always runs; the notifier only once email is set up, the domain
        # verifier once website monitoring is.
        self.assertNotIn("profiles", services["alert-engine"])
        self.assertEqual(services["notifier"]["profiles"], ["notifications"])
        self.assertEqual(services["domain-verifier"]["profiles"], ["web-monitoring"])

    def test_the_smtp_password_reaches_only_the_notifier(self):
        services = self.compose["services"]
        for name, service in services.items():
            with self.subTest(service=name):
                if name == "notifier":
                    self.assertNotIn("SENTINEL_SMTP_PASSWORD", service["environment"])
                elif name == "proxy":
                    self.assertNotIn("environment", service)
                else:
                    self.assertEqual(service["environment"]["SENTINEL_SMTP_PASSWORD"], "")
        self.assertNotIn("SMTP", str(self.tunnel))

    def test_migration_secrets_reach_only_the_migrate_service(self):
        services = self.compose["services"]
        self.assertEqual(
            services["migrate"]["env_file"],
            [".env", "${SENTINEL_MIGRATE_ENV_FILE:-deploy/compose/no-migration-secrets.env}"],
        )
        selectors = [name for name, service in services.items() if "SENTINEL_MIGRATE_ENV_FILE" in str(service)]
        self.assertEqual(selectors, ["migrate"])
        # A migration password put in .env by mistake is blanked for web and the workers.
        for name in ("web", *WORKERS):
            self.assertEqual(services[name]["environment"]["SENTINEL_DB_MIGRATE_PASSWORD"], "")

    def test_the_migrate_service_never_lists_an_env_file_twice(self):
        # Compose releases before 2.24 refuse a service whose env_file list
        # repeats an entry, which would stop every Compose command.
        env_files = self.compose["services"]["migrate"]["env_file"]
        environments = (
            {},
            dotenv_values(LEGACY_ENV),
            dotenv_values(ROOT / ".env.example"),
            {"SENTINEL_MIGRATE_ENV_FILE": ".env.migrate"},
        )
        for environment in environments:
            with self.subTest(environment=sorted(environment)):
                resolved = [interpolate(path, environment) for path in env_files]
                self.assertEqual(len(resolved), len(set(resolved)), resolved)
        default = ROOT / interpolate(env_files[1], {})
        self.assertTrue(default.is_file())
        self.assertEqual(dotenv_values(default), {})  # no settings, no secrets

    def test_an_existing_installation_needs_no_new_setting(self):
        # Every value compose.yml takes from .env has a default, so an .env
        # made before a setting existed still resolves.
        lines = [
            line
            for line in (ROOT / "compose.yml").read_text().splitlines()
            if not line.lstrip().startswith("#")
        ]
        references = re.findall(r"\$\{([^}]*)\}", "\n".join(lines))
        self.assertTrue(references)
        for reference in references:
            self.assertRegex(reference, r"^[A-Z_0-9]+:-", reference)
        self.assertNotIn("SENTINEL_DB_ROLES", dotenv_values(LEGACY_ENV))

    def test_the_bootstrap_password_file_reaches_only_the_database_file(self):
        (include,) = self.compose["include"]
        self.assertEqual(
            include["env_file"], [".env", "${SENTINEL_BOOTSTRAP_ENV_FILE:-deploy/compose/no-bootstrap-secrets.env}"]
        )
        # Named in the include only: it resolves the database file and is no service's env_file.
        text = "\n".join(line for line in (ROOT / "compose.yml").read_text().splitlines()
                         if not line.lstrip().startswith("#"))
        self.assertEqual(text.count("SENTINEL_BOOTSTRAP_ENV_FILE"), 1)
        for service in (*self.compose["services"].values(), *self.tunnel["services"].values()):
            self.assertNotIn("SENTINEL_BOOTSTRAP_ENV_FILE", str(service))
        default = ROOT / interpolate(include["env_file"][1], {})
        self.assertTrue(default.is_file())
        self.assertEqual(dotenv_values(default), {})  # no settings, no secrets
        for environment in ({}, dotenv_values(LEGACY_ENV), dotenv_values(ROOT / ".env.example"),
                            {"SENTINEL_BOOTSTRAP_ENV_FILE": ".env.bootstrap"}):
            resolved = [interpolate(path, environment) for path in include["env_file"]]
            self.assertEqual(len(resolved), len(set(resolved)), resolved)

    def test_no_application_service_names_a_password_or_passes_one_through(self):
        # A variable listed without a value is taken from the shell that runs Compose;
        # nothing may arrive that way, nor through a mount, a secret or a config.
        for name, service in {**self.compose["services"], **self.tunnel["services"]}.items():
            with self.subTest(service=name):
                environment = service.get("environment", {})
                self.assertIsInstance(environment, dict)
                self.assertNotIn(None, environment.values())
                self.assertNotIn("POSTGRES_PASSWORD", environment)
                for key in ("volumes", "secrets", "configs", "env_file"):
                    if key == "env_file" and name in ("web", "migrate", *WORKERS, "cloudflared"):
                        continue
                    self.assertNotIn(key, service)
        services = self.compose["services"]
        self.assertEqual(services["web"]["environment"]["SENTINEL_DB_MIGRATE_PASSWORD"], "")
        self.assertEqual(services["migrate"]["environment"]["SENTINEL_DB_PASSWORD"], "")

    def test_each_service_gets_its_own_password_only(self):
        # A model of how Compose resolves the services (env files in order, then
        # environment; the database file with the include's env files). CI checks
        # the real thing with `docker compose config` (.github/scripts/compose-config-check.sh).
        from sentinel import database

        legacy = dotenv_values(LEGACY_ENV)
        separate = {name: value for name, value in legacy.items() if name != "POSTGRES_PASSWORD"}
        separate.update(SENTINEL_DB_ROLES="separate", SENTINEL_DB_PASSWORD="runtime-secret",
                        SENTINEL_BOOTSTRAP_ENV_FILE=".env.bootstrap", SENTINEL_MIGRATE_ENV_FILE=".env.migrate")
        files = {
            ".env.bootstrap": {"POSTGRES_PASSWORD": "bootstrap-secret"},
            ".env.migrate": {"SENTINEL_DB_MIGRATE_PASSWORD": "migration-secret"},
        }
        passwords = ("POSTGRES_PASSWORD", "SENTINEL_DB_PASSWORD", "SENTINEL_DB_MIGRATE_PASSWORD")

        def held(environment):
            return {name for name in passwords if environment.get(name)}

        runtime = ("web", *WORKERS)
        resolved = self.resolve(separate, files)
        for name in runtime:
            self.assertEqual(held(resolved[name]), {"SENTINEL_DB_PASSWORD"}, name)
            self.assertEqual(resolved[name]["SENTINEL_DB_PASSWORD"], "runtime-secret", name)
            self.assertEqual(database.foreign_passwords(resolved[name]), [], name)
        self.assertEqual(held(resolved["migrate"]), {"SENTINEL_DB_MIGRATE_PASSWORD"})
        self.assertEqual(resolved["db"]["POSTGRES_PASSWORD"], "bootstrap-secret")
        self.assertEqual(database.foreign_passwords(resolved["migrate"]), [])
        # Passwords put in .env by mistake: blanked, or refused by the processes.
        mistaken = {**separate, "SENTINEL_DB_MIGRATE_PASSWORD": "migration-secret"}
        resolved = self.resolve(mistaken, files)
        for name in runtime:
            self.assertEqual(held(resolved[name]), {"SENTINEL_DB_PASSWORD"}, name)
        mistaken = {**separate, "POSTGRES_PASSWORD": "bootstrap-secret"}
        resolved = self.resolve(mistaken, files)
        for name in (*runtime, "migrate"):
            self.assertEqual(database.foreign_passwords(resolved[name]), ["POSTGRES_PASSWORD"], name)
        # An existing installation resolves as it always did; the workers log in as web does.
        resolved = self.resolve(legacy, {})
        for name in runtime:
            self.assertEqual(held(resolved[name]), {"POSTGRES_PASSWORD"}, name)
            self.assertEqual(database.foreign_passwords(resolved[name]), [], name)
        self.assertEqual(resolved["db"]["POSTGRES_PASSWORD"], legacy["POSTGRES_PASSWORD"])
        # The migrate service of a half switch refuses instead of having nothing to do.
        resolved = self.resolve({**legacy, "SENTINEL_MIGRATE_ENV_FILE": ".env.migrate"}, files)
        self.assertEqual(database.foreign_passwords(resolved["migrate"]), ["SENTINEL_DB_MIGRATE_PASSWORD"])
        # The SMTP password, in .env, reaches the notifier only.
        resolved = self.resolve({**separate, "SENTINEL_SMTP_PASSWORD": "smtp-secret"}, files)
        self.assertEqual(
            {name for name, environment in resolved.items() if environment.get("SENTINEL_SMTP_PASSWORD")}, {"notifier"}
        )

    def resolve(self, dotenv: dict[str, str], files: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
        """The environment of each service (db included) for an .env and the other env files."""

        def env_file(path: str) -> dict[str, str]:
            resolved = interpolate(path, dotenv)
            if resolved == ".env":
                return dotenv
            return files[resolved] if resolved in files else dotenv_values(ROOT / resolved)

        environments = {}
        for name, service in self.compose["services"].items():
            environment = {}
            for path in service.get("env_file", []):
                environment.update(env_file(path))
            environment.update({key: str(value) for key, value in service.get("environment", {}).items()})
            environments[name] = environment
        (include,) = self.compose["include"]
        values = {}
        for path in include["env_file"]:
            values.update(env_file(path))
        db = self.yaml.safe_load(self.selected_file(dotenv).read_text())["services"]["db"]["environment"]
        resolved = {key: re.sub(r"\$\{([A-Z_]+):[-?]([^}]*)\}",
                                lambda match: values.get(match[1]) or match[2], str(value))
                    for key, value in db.items()}
        return {**environments, "db": resolved}

    def test_tunnel_token_is_kept_away_from_the_web_container(self):
        cloudflared = self.tunnel["services"]["cloudflared"]
        self.assertEqual(cloudflared["env_file"], [".env.tunnel"])
        self.assertEqual(self.compose["services"]["web"]["env_file"], [".env"])
        self.assertNotRegex(cloudflared["image"], r":latest$")



FRONTEND = ROOT / "frontend"
PROXY_DIR = ROOT / "deploy" / "frontend"


class ProxyTests(unittest.TestCase):
    """The proxy service: the console's build and the one way in to Django, alone on the edge network."""

    def setUp(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - CI installs PyYAML
            self.skipTest("PyYAML is not installed")
        self.compose = yaml.safe_load((ROOT / "compose.yml").read_text())
        self.tunnel = yaml.safe_load((ROOT / "compose.tunnel.yml").read_text())
        self.services = self.compose["services"]
        self.proxy = self.services["proxy"]
        self.nginx = (PROXY_DIR / "nginx.conf").read_text()
        self.dockerfile = (PROXY_DIR / "Dockerfile").read_text()

    def block(self, opening: str) -> str:
        """The body of the nginx block that starts with ``opening``."""
        start = self.nginx.index(opening + " {")
        end = self.nginx.index("\n    }", start)
        return self.nginx[start:end]

    def test_only_the_proxy_is_published_at_the_address_web_had(self):
        published = {name for name, service in self.services.items() if "ports" in service}
        self.assertEqual(published, {"proxy"})
        self.assertEqual(self.proxy["ports"], ["${SENTINEL_HTTP_BIND:-0.0.0.0}:${SENTINEL_HTTP_PORT:-8000}:8080"])
        self.assertNotIn("ports", self.tunnel["services"]["cloudflared"])

    def test_the_edge_network_holds_the_proxy_and_web_only(self):
        self.assertEqual(self.compose["networks"], {"edge": {}})
        self.assertEqual(self.proxy["networks"], ["edge"])
        # Distinct priorities, or Compose 2.24.6 leaves one of them out at random (docker/compose#11533).
        self.assertEqual(self.services["web"]["networks"], {"default": {"priority": 20}, "edge": {"priority": 10}})
        for name, service in self.services.items():
            if name not in ("proxy", "web"):
                with self.subTest(service=name):
                    self.assertNotIn("networks", service)  # the default network only
        for major in LAYOUTS:
            db = yaml_load(POSTGRES_DIR / f"postgres-{major}.yml")["services"]["db"]
            self.assertNotIn("networks", db)

    def test_the_tunnel_reaches_the_proxy_on_the_edge_network(self):
        cloudflared = self.tunnel["services"]["cloudflared"]
        self.assertEqual(cloudflared["networks"], ["edge"])
        self.assertEqual(cloudflared["depends_on"], {"proxy": {"condition": "service_healthy"}})
        self.assertIn("http://proxy:8080", (ROOT / "compose.tunnel.yml").read_text())

    def test_the_proxy_holds_no_setting_and_no_secret(self):
        for key in ("environment", "env_file", "volumes", "secrets", "configs"):
            self.assertNotIn(key, self.proxy)
        self.assertNotRegex(self.dockerfile, r"(?m)^(ENV|ARG) ")

    def test_proxy_hardening(self):
        self.assertTrue(self.proxy["read_only"])
        self.assertEqual(self.proxy["tmpfs"], ["/tmp"])
        self.assertEqual(self.proxy["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", self.proxy["security_opt"])
        self.assertTrue(self.proxy["init"])
        self.assertEqual(self.proxy["restart"], "unless-stopped")
        self.assertEqual(self.proxy["logging"]["options"]["max-size"], "10m")
        self.assertEqual(self.proxy["depends_on"], {"web": {"condition": "service_healthy"}})
        # Healthy on its own files: a restarting web does not take the console down with it.
        self.assertEqual(self.proxy["healthcheck"]["test"][-1], "http://127.0.0.1:8080/")
        # Long enough for the proxy's longest request (proxy_read_timeout) to finish.
        self.assertGreater(int(self.proxy["stop_grace_period"].rstrip("s")), 35)

    def test_the_image_is_built_from_the_frontend_and_the_proxy_configuration(self):
        build = self.proxy["build"]
        self.assertEqual(build["context"], "./frontend")
        self.assertEqual(build["dockerfile"], "../deploy/frontend/Dockerfile")
        self.assertEqual(build["additional_contexts"], {"nginx": "./deploy/frontend"})
        self.assertNotIn("image", self.proxy)  # the release's build, never a registry's
        self.assertIn("COPY --from=nginx nginx.conf /etc/nginx/conf.d/default.conf", self.dockerfile)
        self.assertIn("COPY --from=build /src/dist /usr/share/nginx/html", self.dockerfile)
        self.assertIn("RUN npm ci", self.dockerfile)
        self.assertIn("ignore-scripts=true", (FRONTEND / ".npmrc").read_text())
        ignored = (FRONTEND / ".dockerignore").read_text().split()
        for name in ("node_modules", "dist", ".env*"):
            self.assertIn(name, ignored)

    def test_the_build_uses_the_node_line_ci_checks_the_console_with(self):
        (node,) = re.findall(r"(?m)^FROM node:(\d+)-", self.dockerfile)
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        self.assertIn(f'node-version: "{node}"', ci)
        minimum = re.search(r'"node": ">=(\d+)', (FRONTEND / "package.json").read_text())[1]
        self.assertGreaterEqual(int(node), int(minimum))

    def test_nginx_runs_unprivileged_from_a_supported_line(self):
        (image,) = re.findall(r"(?m)^FROM (nginxinc/nginx-unprivileged:\S+)$", self.dockerfile)
        self.assertRegex(image, r":1\.\d*[02468]-alpine$")  # an even minor: nginx's stable line
        self.assertIn("listen 8080;", self.nginx)
        self.assertIn("server_tokens off;", self.nginx)

    def test_django_is_reached_by_name_and_found_again_when_web_is_recreated(self):
        self.assertIn("resolver 127.0.0.11 ", self.nginx)
        self.assertIn("set $web http://web:8000;", self.nginx)
        self.assertEqual(re.findall(r"proxy_pass (\S+);", self.nginx), ["$web"])

    def test_every_path_django_serves_is_passed_on(self):
        django = self.block("location ~ ^/(api|admin|static|health)/")
        self.assertIn("proxy_pass $web;", django)
        # The first segment of each route (sentinel/urls.py, and the root routes of apps/core/urls.py);
        # the static files come from WhiteNoise under STATIC_URL.
        routes = re.findall(r'path\("([^"]*)"', (ROOT / "sentinel" / "urls.py").read_text())
        routes += re.findall(r'path\("([^"]*)"', (ROOT / "apps" / "core" / "urls.py").read_text())
        prefixes = {route.split("/")[0] for route in routes} - {""}
        self.assertEqual(prefixes, {"api", "admin", "health"})
        self.assertIn('STATIC_URL = "static/"', (ROOT / "sentinel" / "settings.py").read_text())

    def test_the_host_reaches_django_and_the_scheme_stays_gunicorns_decision(self):
        django = self.block("location ~ ^/(api|admin|static|health)/")
        self.assertIn("proxy_set_header Host $http_host;", django)
        for header in ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Ssl", "X-Forwarded-Protocol", "Forwarded"):
            with self.subTest(header):
                self.assertIn(f'proxy_set_header {header} "";', django)
        # X-Forwarded-Proto goes on as the client sent it: Gunicorn ignores it unless FORWARDED_ALLOW_IPS trusts
        # the proxy (docs/security.md); the proxy never vouches for a scheme it did not see.
        self.assertNotRegex(django, r"X-Forwarded-Proto\s")
        self.assertNotIn("$proxy_add_x_forwarded_for", self.nginx)
        self.assertNotIn("$scheme", self.nginx)

    def test_an_agent_heartbeat_fits_and_gunicorn_times_out_first(self):
        from agent.http_client import MAX_REQUEST_BYTES

        size = re.search(r"client_max_body_size (\d+)m;", self.nginx)[1]
        self.assertGreaterEqual(int(size) * 1024 * 1024, MAX_REQUEST_BYTES)
        gunicorn = int(re.search(r"(?m)^timeout = (\d+)$", (ROOT / "gunicorn.conf.py").read_text())[1])
        django = self.block("location ~ ^/(api|admin|static|health)/")
        for name in ("proxy_read_timeout", "proxy_send_timeout"):
            self.assertGreater(int(re.search(rf"{name} (\d+)s;", django)[1]), gunicorn)

    def test_the_apis_answer_in_their_own_shape_while_web_is_down(self):
        django = self.block("location ~ ^/(api|admin|static|health)/")
        self.assertIn("error_page 502 503 504 = @unavailable;", django)
        unavailable = self.block("location @unavailable")
        self.assertIn("default_type application/json;", unavailable)
        body = re.search(r"return 503 '(.*)\\n';", unavailable)[1]
        self.assertEqual(json.loads(body)["error"]["code"], "unavailable")

    def test_the_console_routes_fall_back_to_index_html(self):
        console = self.block("location /")
        self.assertIn("try_files $uri /index.html;", console)
        self.assertIn('Cache-Control "no-cache"', console)
        assets = self.block("location /assets/")
        self.assertIn("try_files $uri =404;", assets)
        self.assertIn("immutable", assets)

    def test_the_console_files_carry_the_security_headers(self):
        # add_header in a location replaces the server's: each location states them all.
        headers = {}
        for opening in ("location /assets/", "location /"):
            block = self.block(opening)
            found = dict(re.findall(r'add_header (\S+) "([^"]*)" always;', block))
            found.pop("Cache-Control")
            headers[opening] = found
        self.assertEqual(headers["location /assets/"], headers["location /"])
        found = headers["location /"]
        self.assertEqual(found["X-Content-Type-Options"], "nosniff")
        self.assertEqual(found["X-Frame-Options"], "DENY")
        self.assertEqual(found["Referrer-Policy"], "same-origin")
        policy = dict(directive.strip().split(" ", 1) for directive in found["Content-Security-Policy"].split(";"))
        self.assertEqual(policy["default-src"], "'self'")
        self.assertEqual(policy["script-src"], "'self'")
        self.assertEqual(policy["connect-src"], "'self'")
        self.assertEqual(policy["frame-ancestors"], "'none'")
        self.assertEqual(policy["object-src"], "'none'")
        self.assertNotIn("add_header", self.nginx.split("location", 1)[0])


def yaml_load(path: Path) -> dict:
    import yaml

    return yaml.safe_load(path.read_text())

class InitializationGuardTests(unittest.TestCase):
    """The PostgreSQL 18 entrypoint guard, run as Compose would run it, with a
    stand-in for the image's docker-entrypoint.sh."""

    def setUp(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - CI installs PyYAML
            self.skipTest("PyYAML is not installed")
        self.db = yaml.safe_load((POSTGRES_DIR / "postgres-18.yml").read_text())["services"]["db"]
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        base = Path(self.directory.name)
        self.pgdata = base / "pgdata"
        self.pgdata.mkdir()
        self.calls = base / "calls"
        stub = base / "bin" / "docker-entrypoint.sh"
        stub.parent.mkdir()
        stub.write_text('#!/bin/sh\necho "$*" > "$STUB_CALLS"\n')
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)

    def start(self, **environment) -> subprocess.CompletedProcess:
        entrypoint = [part.replace("$$", "$") for part in self.db["entrypoint"]]  # Compose unescapes $$
        env = {
            "PATH": f"{Path(self.directory.name) / 'bin'}{os.pathsep}{os.environ['PATH']}",
            "PGDATA": str(self.pgdata),
            "STUB_CALLS": str(self.calls),
            **environment,
        }
        return subprocess.run(
            [*entrypoint, *self.db["command"]], env=env, capture_output=True, text=True, check=False
        )

    def started(self) -> bool:
        return self.calls.exists()

    def test_an_empty_data_directory_is_not_initialized_without_authorization(self):
        for value in (None, "", "false", "yes", "1", "TRUE"):
            with self.subTest(value=value):
                result = self.start(**({} if value is None else {"SENTINEL_POSTGRES_INITIALIZE": value}))
                self.assertEqual(result.returncode, 1)
                self.assertFalse(self.started())
                self.assertIn("SENTINEL_POSTGRES_INITIALIZE=true", result.stderr)
                self.assertIn("scripts/postgres-preflight.sh", result.stderr)

    def test_authorization_lets_the_image_initialize_the_database(self):
        result = self.start(SENTINEL_POSTGRES_INITIALIZE="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text().strip(), "postgres")

    def test_an_existing_cluster_starts_without_any_setting(self):
        # Restoring a volume that holds a cluster is not an initialization.
        (self.pgdata / "PG_VERSION").write_text("18\n")
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text().strip(), "postgres")

    def test_a_data_directory_with_other_content_but_no_cluster_is_still_refused(self):
        (self.pgdata / "backup.dump").write_text("not a cluster")
        self.assertEqual(self.start().returncode, 1)
        (self.pgdata / "PG_VERSION").write_text("")  # an empty marker is no cluster either
        self.assertEqual(self.start().returncode, 1)
        self.assertFalse(self.started())

    def test_the_guard_hands_over_to_the_image_with_exec(self):
        # exec keeps the image's entrypoint as the container's main process, so
        # it still receives the stop signal.
        self.assertIn('exec docker-entrypoint.sh "$$@"', self.db["entrypoint"][2])

    def test_the_command_is_stated_because_the_entrypoint_is_overridden(self):
        self.assertEqual(self.db["command"], ["postgres"])

    def test_the_postgresql_16_service_has_no_guard(self):
        import yaml

        db = yaml.safe_load((POSTGRES_DIR / "postgres-16.yml").read_text())["services"]["db"]
        for key in ("entrypoint", "command"):
            self.assertNotIn(key, db)
        self.assertNotIn("SENTINEL_POSTGRES_INITIALIZE", db["environment"])


class OperatorGuideTests(unittest.TestCase):
    """What the guides have an operator run: restores that cannot half succeed, the whole cleanup, and copies of
    the environment that git never takes."""

    GUIDES = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]

    def lines(self):
        """Every line of the guides, a command's continuation lines joined to it."""
        for path in self.GUIDES:
            for line in re.sub(r"\\\n\s*", " ", path.read_text()).splitlines():
                yield path.name, line

    def test_every_restore_into_a_database_is_one_transaction_that_stops_at_the_first_error(self):
        restores = [(name, line.strip()) for name, line in self.lines()
                    if re.search(r"pg_restore\b[^`]*\s(-d|--dbname)\b", line)]
        self.assertGreaterEqual(len(restores), 2)
        for name, line in restores:
            with self.subTest(guide=name, command=line):
                self.assertIn("--single-transaction", line)
                self.assertIn("--exit-on-error", line)

    def test_every_cleanup_command_is_in_the_daily_set_of_both_guides(self):
        commands = sorted(path.stem for path in ROOT.glob("apps/*/management/commands/purge_*.py"))
        self.assertIn("purge_telemetry_samples", commands)

        def section(path, heading, level):
            text = path.read_text()
            start = text.index(heading)
            end = text.find("\n" + "#" * level + " ", start + len(heading))
            return text[start:end if end != -1 else None]

        readme = section(ROOT / "README.md", "## Data retention and history", 2)
        retention = section(ROOT / "docs" / "server-deployment.md", "### Retention", 3)
        for command in commands:
            with self.subTest(command):
                self.assertIn(f"python manage.py {command}\n", readme)
                self.assertIn(f"docker compose exec -T web python manage.py {command}\n", retention)

    def test_copies_of_the_environment_the_guides_make_are_never_committed(self):
        copies = {copy for _, line in self.lines() for copy in re.findall(r"\bcp \.env (\S+)", line)}
        self.assertLessEqual({"env.legacy.backup", "env.pg16.backup"}, copies)
        if shutil.which("git") is None or not (ROOT / ".git").exists():
            self.skipTest("not a git checkout")
        for name in sorted(copies | {".env", ".env.bootstrap", ".env.migrate", ".env.tunnel"}):
            with self.subTest(name):
                ignored = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", "--no-index", name], check=False)
                self.assertEqual(ignored.returncode, 0, f"git would take {name}, which holds the secrets of .env")

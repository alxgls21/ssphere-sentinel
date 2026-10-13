"""Guards for the shipped deployment files: security properties that must not
regress silently (non-root, no Docker socket by default, no secrets)."""

from __future__ import annotations

import os
import re
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
# Volume and mount of each supported PostgreSQL major version. 16 keeps the
# layout (and volume) of installations that predate version selection.
LAYOUTS = {
    "16": ("postgres_data", "/var/lib/postgresql/data"),
    "18": ("postgres18_data", "/var/lib/postgresql"),
}


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
        self.assertEqual(set(self.compose["services"]), {"web"})
        self.assertNotIn("volumes", self.compose)
        self.assertEqual(self.database({})["services"].keys(), {"db"})

    def test_the_database_comes_from_a_file_selected_by_one_setting(self):
        (include,) = self.compose["include"]
        self.assertEqual(include["path"], "deploy/postgres/postgres-${SENTINEL_POSTGRES:-16}.yml")
        # Compose 2.20 does not pass the project's .env to an included file
        # unless it is named; naming it works in every release.
        self.assertEqual((include["project_directory"], include["env_file"]), (".", ".env"))
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
        self.assertTrue(web["read_only"])
        self.assertEqual(web["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", web["security_opt"])
        self.assertEqual(web["depends_on"]["db"]["condition"], "service_healthy")
        services = [web] + [self.version_file(major)["services"]["db"] for major in LAYOUTS]
        for service in services:
            self.assertEqual(service["restart"], "unless-stopped")
            self.assertEqual(service["logging"]["options"]["max-size"], "10m")
        for major in LAYOUTS:
            db = self.version_file(major)["services"]["db"]
            self.assertIn("no-new-privileges:true", db["security_opt"])

    def test_tunnel_token_is_kept_away_from_the_web_container(self):
        cloudflared = self.tunnel["services"]["cloudflared"]
        self.assertEqual(cloudflared["env_file"], [".env.tunnel"])
        self.assertEqual(self.compose["services"]["web"]["env_file"], [".env"])
        self.assertNotRegex(cloudflared["image"], r":latest$")


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

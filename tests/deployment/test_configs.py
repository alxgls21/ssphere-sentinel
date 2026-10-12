"""Guards for the shipped deployment files: security properties that must not
regress silently (non-root, no Docker socket by default, no secrets)."""

from __future__ import annotations

import re
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


class ComposeTests(unittest.TestCase):
    def setUp(self):
        try:
            import yaml
        except ImportError:  # pragma: no cover - CI installs PyYAML
            self.skipTest("PyYAML is not installed")
        self.compose = yaml.safe_load((ROOT / "compose.yml").read_text())
        self.tunnel = yaml.safe_load((ROOT / "compose.tunnel.yml").read_text())

    def test_service_and_volume_names_preserve_existing_data(self):
        self.assertNotIn("name", self.compose)  # project name drives volume names
        self.assertEqual(set(self.compose["services"]), {"db", "web"})
        self.assertIn("postgres_data", self.compose["volumes"])
        self.assertEqual(
            self.compose["services"]["db"]["volumes"], ["postgres_data:/var/lib/postgresql/data"]
        )

    def test_postgres_is_not_published(self):
        self.assertNotIn("ports", self.compose["services"]["db"])

    def test_web_service_hardening(self):
        web = self.compose["services"]["web"]
        self.assertTrue(web["read_only"])
        self.assertEqual(web["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", web["security_opt"])
        self.assertEqual(web["depends_on"]["db"]["condition"], "service_healthy")
        for service in self.compose["services"].values():
            self.assertEqual(service["restart"], "unless-stopped")
            self.assertEqual(service["logging"]["options"]["max-size"], "10m")

    def test_tunnel_token_is_kept_away_from_the_web_container(self):
        cloudflared = self.tunnel["services"]["cloudflared"]
        self.assertEqual(cloudflared["env_file"], [".env.tunnel"])
        self.assertEqual(self.compose["services"]["web"]["env_file"], [".env"])
        self.assertNotRegex(cloudflared["image"], r":latest$")

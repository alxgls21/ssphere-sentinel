import sys
import unittest
from unittest.mock import MagicMock, patch

from agent.docker_discovery import (
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_PERMISSION_DENIED,
    STATUS_UNAVAILABLE,
    collect_docker,
    normalize_health,
    normalize_state,
)


class NormalizeTests(unittest.TestCase):
    def test_normalized_states(self):
        self.assertEqual(normalize_state("running"), "running")
        self.assertEqual(normalize_state("exited"), "exited")
        self.assertEqual(normalize_state("PAUSED"), "paused")
        self.assertEqual(normalize_state("restarting"), "restarting")
        self.assertEqual(normalize_state("created"), "created")
        self.assertEqual(normalize_state("dead"), "dead")
        self.assertEqual(normalize_state("removing"), "unknown")
        self.assertEqual(normalize_state(None), "unknown")

    def test_normalized_health(self):
        self.assertEqual(normalize_health(None, has_healthcheck=False), "none")
        self.assertEqual(normalize_health("healthy", has_healthcheck=True), "healthy")
        self.assertEqual(
            normalize_health("unhealthy", has_healthcheck=True), "unhealthy"
        )
        self.assertEqual(normalize_health("starting", has_healthcheck=True), "starting")
        self.assertEqual(normalize_health("weird", has_healthcheck=True), "unknown")


class DockerDiscoveryTests(unittest.TestCase):
    def test_docker_unavailable(self):
        result = self._collect(from_env_side_effect=FileNotFoundError("no socket"))
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], STATUS_UNAVAILABLE)
        self.assertEqual(result["containers"], [])
        self.assertEqual(result["version"], 1)

    def test_docker_daemon_inaccessible(self):
        result = self._collect(
            from_env_side_effect=ConnectionRefusedError("connection refused")
        )
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], STATUS_UNAVAILABLE)

    def test_docker_permission_failure(self):
        result = self._collect(
            from_env_side_effect=PermissionError("permission denied")
        )
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], STATUS_PERMISSION_DENIED)

    def test_docker_generic_error(self):
        result = self._collect(from_env_side_effect=RuntimeError("boom"))
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], STATUS_ERROR)

    def test_successful_empty_docker_host(self):
        client = MagicMock()
        client.containers.list.return_value = []
        result = self._collect(client=client)
        self.assertTrue(result["available"])
        self.assertEqual(result["status"], STATUS_AVAILABLE)
        self.assertEqual(result["containers"], [])

    def test_running_container(self):
        client = MagicMock()
        client.containers.list.return_value = [
            self._container(
                container_id="a" * 64,
                name="/nginx",
                image="nginx:latest",
                status="running",
                health=None,
                has_healthcheck=False,
            )
        ]
        result = self._collect(client=client)
        item = result["containers"][0]
        self.assertEqual(item["container_id"], "a" * 64)
        self.assertEqual(item["name"], "nginx")
        self.assertEqual(item["image"], "nginx:latest")
        self.assertEqual(item["state"], "running")
        self.assertEqual(item["health"], "none")
        self.assertIsNotNone(item["created_at"])
        self.assertIsNotNone(item["started_at"])

    def test_exited_container(self):
        client = MagicMock()
        client.containers.list.return_value = [
            self._container(
                container_id="b" * 64,
                name="old",
                image="busybox",
                status="exited",
                health=None,
                has_healthcheck=False,
            )
        ]
        result = self._collect(client=client)
        self.assertEqual(result["containers"][0]["state"], "exited")

    def test_container_with_healthcheck(self):
        client = MagicMock()
        client.containers.list.return_value = [
            self._container(
                container_id="c" * 64,
                name="api",
                image="api:1",
                status="running",
                health="healthy",
                has_healthcheck=True,
            )
        ]
        result = self._collect(client=client)
        self.assertEqual(result["containers"][0]["health"], "healthy")

    def test_container_without_healthcheck(self):
        client = MagicMock()
        client.containers.list.return_value = [
            self._container(
                container_id="d" * 64,
                name="redis",
                image="redis:7",
                status="running",
                health=None,
                has_healthcheck=False,
            )
        ]
        result = self._collect(client=client)
        self.assertEqual(result["containers"][0]["health"], "none")

    def test_payload_does_not_include_secrets(self):
        container = self._container(
            container_id="e" * 64,
            name="secretive",
            image="app",
            status="running",
            health=None,
            has_healthcheck=False,
        )
        container.attrs["Config"]["Env"] = ["SECRET=value", "TOKEN=abc"]
        container.attrs["Config"]["Cmd"] = ["sh", "-c", "echo hi"]
        container.attrs["Mounts"] = [{"Source": "/secret"}]
        client = MagicMock()
        client.containers.list.return_value = [container]
        result = self._collect(client=client)
        serialized = result["containers"][0]
        blob = str(serialized)
        self.assertNotIn("SECRET", blob)
        self.assertNotIn("TOKEN", blob)
        self.assertEqual(
            set(serialized.keys()),
            {
                "container_id",
                "name",
                "image",
                "state",
                "health",
                "created_at",
                "started_at",
            },
        )

    def _container(
        self,
        *,
        container_id: str,
        name: str,
        image: str,
        status: str,
        health: str | None,
        has_healthcheck: bool,
    ):
        state = {
            "Status": status,
            "StartedAt": "2026-01-01T00:00:00.000000000Z",
        }
        config = {"Image": image}
        if has_healthcheck:
            config["Healthcheck"] = {"Test": ["CMD", "true"]}
            state["Health"] = {"Status": health or "starting"}
        container = MagicMock()
        container.id = container_id
        container.name = name.lstrip("/")
        container.status = status
        container.image.tags = [image]
        container.attrs = {
            "Id": container_id,
            "Name": name,
            "Image": image,
            "Created": "2026-01-01T00:00:00.000000000Z",
            "State": state,
            "Config": config,
        }
        return container

    def _collect(self, *, client=None, from_env_side_effect=None):
        mock_docker = MagicMock()
        mock_errors = MagicMock()
        mock_errors.APIError = type("APIError", (Exception,), {})
        mock_errors.DockerException = type("DockerException", (Exception,), {})
        if from_env_side_effect is not None:
            mock_docker.from_env.side_effect = from_env_side_effect
        else:
            mock_docker.from_env.return_value = client

        with patch.dict(
            sys.modules,
            {"docker": mock_docker, "docker.errors": mock_errors},
        ):
            return collect_docker()

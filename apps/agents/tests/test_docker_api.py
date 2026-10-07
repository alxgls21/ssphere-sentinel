import json
from datetime import timedelta

from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.docker_reports import MAX_CONTAINERS_PER_REPORT
from apps.infrastructure.models import (
    DockerContainer,
    DockerHostState,
    Server,
    ServerTelemetry,
)


def valid_docker(**overrides):
    payload = {
        "version": 1,
        "available": True,
        "status": "available",
        "collected_at": timezone.now().isoformat(),
        "containers": [],
    }
    payload.update(overrides)
    return payload


def valid_container(**overrides):
    payload = {
        "container_id": "a" * 64,
        "name": "nginx",
        "image": "nginx:latest",
        "state": "running",
        "health": "none",
        "created_at": timezone.now().isoformat(),
        "started_at": timezone.now().isoformat(),
    }
    payload.update(overrides)
    return payload


class AgentDockerAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(
            name="docker-host",
            hostname="docker.local",
        )
        self.agent, self.raw_token = create_agent(
            server=self.server,
            name="server-agent",
        )

    def _post(self, body=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {self.raw_token}"}
        if body is None:
            return self.client.post(self.url, **headers)
        return self.client.post(
            self.url,
            data=json.dumps(body),
            content_type="application/json",
            **headers,
        )

    def test_heartbeat_without_docker_payload_remains_compatible(self):
        response = self._post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertFalse(DockerHostState.objects.exists())

    def test_valid_docker_payload_accepted(self):
        response = self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container()],
                )
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["docker"], "accepted")

    def test_docker_host_state_created_updated(self):
        self._post({"docker": valid_docker(status="available", available=True)})
        host = DockerHostState.objects.get(server=self.server)
        self.assertTrue(host.available)
        self.assertEqual(host.status, DockerHostState.Status.AVAILABLE)

        self._post(
            {
                "docker": valid_docker(
                    available=False,
                    status="unavailable",
                    containers=[],
                )
            }
        )
        host.refresh_from_db()
        self.assertFalse(host.available)
        self.assertEqual(host.status, DockerHostState.Status.UNAVAILABLE)

    def test_containers_created(self):
        self._post(
            {"docker": valid_docker(containers=[valid_container(name="web")])}
        )
        container = DockerContainer.objects.get(server=self.server)
        self.assertEqual(container.name, "web")
        self.assertTrue(container.present)
        self.assertEqual(container.state, "running")

    def test_subsequent_report_updates_existing_container_by_id(self):
        cid = "b" * 64
        self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container(container_id=cid, name="old")]
                )
            }
        )
        self._post(
            {
                "docker": valid_docker(
                    containers=[
                        valid_container(
                            container_id=cid,
                            name="new",
                            state="exited",
                        )
                    ]
                )
            }
        )
        self.assertEqual(DockerContainer.objects.count(), 1)
        container = DockerContainer.objects.get()
        self.assertEqual(container.name, "new")
        self.assertEqual(container.state, "exited")

    def test_missing_container_after_successful_discovery_becomes_absent(self):
        first = "c" * 64
        second = "d" * 64
        self._post(
            {
                "docker": valid_docker(
                    containers=[
                        valid_container(container_id=first, name="one"),
                        valid_container(container_id=second, name="two"),
                    ]
                )
            }
        )
        self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container(container_id=first, name="one")]
                )
            }
        )
        one = DockerContainer.objects.get(container_id=first)
        two = DockerContainer.objects.get(container_id=second)
        self.assertTrue(one.present)
        self.assertFalse(two.present)

    def test_unavailable_discovery_does_not_mark_containers_absent(self):
        cid = "e" * 64
        self._post(
            {"docker": valid_docker(containers=[valid_container(container_id=cid)])}
        )
        self.assertTrue(DockerContainer.objects.get().present)

        self._post(
            {
                "docker": valid_docker(
                    available=False,
                    status="permission_denied",
                    containers=[],
                )
            }
        )
        container = DockerContainer.objects.get(container_id=cid)
        self.assertTrue(container.present)
        host = DockerHostState.objects.get(server=self.server)
        self.assertEqual(host.status, DockerHostState.Status.PERMISSION_DENIED)

    def test_reappearing_container_marked_present_again(self):
        cid = "f" * 64
        self._post(
            {"docker": valid_docker(containers=[valid_container(container_id=cid)])}
        )
        self._post({"docker": valid_docker(containers=[])})
        self.assertFalse(DockerContainer.objects.get(container_id=cid).present)
        self._post(
            {"docker": valid_docker(containers=[valid_container(container_id=cid)])}
        )
        self.assertTrue(DockerContainer.objects.get(container_id=cid).present)

    def test_duplicate_ids_rejected(self):
        cid = "1" * 64
        response = self._post(
            {
                "docker": valid_docker(
                    containers=[
                        valid_container(container_id=cid, name="a"),
                        valid_container(container_id=cid, name="b"),
                    ]
                )
            }
        )
        self.assertEqual(response.json()["docker"], "rejected")
        self.assertIn("duplicate", response.json()["docker_detail"])
        self.assertFalse(DockerContainer.objects.exists())

    def test_invalid_state_rejected(self):
        response = self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container(state="exploded")]
                )
            }
        )
        self.assertEqual(response.json()["docker"], "rejected")

    def test_invalid_health_rejected(self):
        response = self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container(health="perfect")]
                )
            }
        )
        self.assertEqual(response.json()["docker"], "rejected")

    def test_malformed_timestamp_rejected(self):
        response = self._post(
            {"docker": valid_docker(collected_at="not-a-date")}
        )
        self.assertEqual(response.json()["docker"], "rejected")

    def test_unsupported_version_rejected(self):
        response = self._post({"docker": valid_docker(version=99)})
        self.assertEqual(response.json()["docker"], "rejected")
        self.assertIn("unsupported docker version", response.json()["docker_detail"])

    def test_max_container_count_rejected(self):
        containers = [
            valid_container(container_id=f"{index:064x}", name=f"c{index}")
            for index in range(MAX_CONTAINERS_PER_REPORT + 1)
        ]
        response = self._post({"docker": valid_docker(containers=containers)})
        self.assertEqual(response.json()["docker"], "rejected")
        self.assertIn("maximum", response.json()["docker_detail"])

    def test_invalid_docker_report_does_not_overwrite_last_valid_state(self):
        self._post(
            {
                "docker": valid_docker(
                    containers=[valid_container(name="keep-me")]
                )
            }
        )
        host = DockerHostState.objects.get(server=self.server)
        original_received = host.received_at
        container = DockerContainer.objects.get()

        response = self._post({"docker": valid_docker(version=99)})
        self.assertEqual(response.json()["docker"], "rejected")

        host.refresh_from_db()
        container.refresh_from_db()
        self.assertEqual(host.received_at, original_received)
        self.assertEqual(container.name, "keep-me")
        self.assertTrue(container.present)

    def test_liveness_updates_when_docker_rejected(self):
        earlier = timezone.now() - timedelta(hours=1)
        Server.objects.filter(pk=self.server.pk).update(
            last_seen_at=earlier,
            status=Server.Status.OFFLINE,
        )
        response = self._post({"docker": valid_docker(version=99)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["docker"], "rejected")
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)
        self.assertGreater(self.server.last_seen_at, earlier)

    def test_valid_telemetry_accepted_with_invalid_docker(self):
        response = self._post(
            {
                "telemetry": valid_telemetry(cpu_percent=33.0),
                "docker": valid_docker(version=99),
            }
        )
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["telemetry"], "accepted")
        self.assertEqual(body["docker"], "rejected")
        self.assertEqual(ServerTelemetry.objects.count(), 1)
        self.assertEqual(ServerTelemetry.objects.get().cpu_percent, 33.0)
        self.assertFalse(DockerHostState.objects.exists())

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.infrastructure.models import Server, ServerTelemetry


def valid_telemetry(**overrides):
    payload = {
        "version": 1,
        "collected_at": timezone.now().isoformat(),
        "cpu_percent": 12.5,
        "memory_total_bytes": 16_000,
        "memory_used_bytes": 8_000,
        "memory_percent": 50.0,
        "disk_total_bytes": 100_000,
        "disk_used_bytes": 40_000,
        "disk_percent": 40.0,
        "uptime_seconds": 12345,
    }
    payload.update(overrides)
    return payload


class AgentTelemetryAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(
            name="telemetry-host",
            hostname="telemetry.local",
        )
        self.agent, self.raw_token = create_agent(
            server=self.server,
            name="server-agent",
        )

    def _post(self, body=None, token=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token or self.raw_token}"}
        if body is None:
            return self.client.post(self.url, **headers)
        return self.client.post(
            self.url,
            data=json.dumps(body),
            content_type="application/json",
            **headers,
        )

    def test_heartbeat_without_telemetry_still_works(self):
        response = self._post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertFalse(ServerTelemetry.objects.exists())
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_valid_telemetry_creates_latest_snapshot(self):
        response = self._post({"telemetry": valid_telemetry()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"status": "ok", "telemetry": "accepted"},
        )
        self.assertEqual(ServerTelemetry.objects.count(), 1)
        snap = ServerTelemetry.objects.get(server=self.server)
        self.assertEqual(snap.cpu_percent, 12.5)
        self.assertEqual(snap.memory_total_bytes, 16_000)
        self.assertEqual(snap.memory_used_bytes, 8_000)
        self.assertEqual(snap.memory_percent, 50.0)
        self.assertIsNotNone(snap.received_at)
        self.assertIsNotNone(snap.collected_at)

    def test_subsequent_telemetry_updates_same_row(self):
        self._post({"telemetry": valid_telemetry(cpu_percent=10.0)})
        self._post({"telemetry": valid_telemetry(cpu_percent=22.0)})
        self.assertEqual(ServerTelemetry.objects.count(), 1)
        snap = ServerTelemetry.objects.get(server=self.server)
        self.assertEqual(snap.cpu_percent, 22.0)

    def test_invalid_percentage_rejected_without_overwrite(self):
        self._post({"telemetry": valid_telemetry(cpu_percent=10.0)})
        original = ServerTelemetry.objects.get(server=self.server)
        original_cpu = original.cpu_percent
        original_received = original.received_at

        response = self._post({"telemetry": valid_telemetry(cpu_percent=150.0)})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["telemetry"], "rejected")

        original.refresh_from_db()
        self.assertEqual(original.cpu_percent, original_cpu)
        self.assertEqual(original.received_at, original_received)
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_used_greater_than_total_rejected(self):
        self._post({"telemetry": valid_telemetry()})
        response = self._post(
            {
                "telemetry": valid_telemetry(
                    memory_total_bytes=1000,
                    memory_used_bytes=2000,
                )
            }
        )
        self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertEqual(ServerTelemetry.objects.count(), 1)
        self.assertEqual(
            ServerTelemetry.objects.get().memory_used_bytes,
            8_000,
        )

    def test_invalid_timestamp_rejected(self):
        response = self._post(
            {"telemetry": valid_telemetry(collected_at="not-a-timestamp")}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertFalse(ServerTelemetry.objects.exists())
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_unsupported_version_rejected(self):
        response = self._post({"telemetry": valid_telemetry(version=99)})
        self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertIn("unsupported telemetry version", response.json()["detail"])
        self.assertFalse(ServerTelemetry.objects.exists())

    def test_future_collected_at_rejected(self):
        future = (timezone.now() + timedelta(hours=2)).isoformat()
        response = self._post({"telemetry": valid_telemetry(collected_at=future)})
        self.assertEqual(response.json()["telemetry"], "rejected")

    def test_liveness_updated_when_telemetry_rejected(self):
        earlier = timezone.now() - timedelta(hours=1)
        Server.objects.filter(pk=self.server.pk).update(
            last_seen_at=earlier,
            status=Server.Status.OFFLINE,
        )
        response = self._post({"telemetry": valid_telemetry(cpu_percent=-1)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["telemetry"], "rejected")
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)
        self.assertGreater(self.server.last_seen_at, earlier)

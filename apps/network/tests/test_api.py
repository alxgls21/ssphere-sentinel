import json
import uuid
from datetime import timedelta
from io import StringIO

from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import Server, ServerTelemetry
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.reports import MAX_MEASUREMENTS_PER_REPORT


def valid_measurement(**overrides):
    payload = {
        "measurement_id": str(uuid.uuid4()),
        "target_id": None,
        "measured_at": timezone.now().isoformat(),
        "success": True,
        "latency_ms": 12.5,
        "packet_loss_percentage": 0.0,
        "probe_count": 4,
        "successful_probes": 4,
        "failure_reason": "",
    }
    payload.update(overrides)
    return payload


class NetworkAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="net-host", hostname="net.local")
        self.agent, self.token = create_agent(server=self.server, name="agent")
        self.target = NetworkTarget.objects.create(
            id=uuid.uuid4(),
            name="dns-tcp",
            hostname_or_ip="1.1.1.1",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=self.agent,
        )

    def _post(self, body=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {self.token}"}
        if body is None:
            return self.client.post(self.url, **headers)
        return self.client.post(
            self.url,
            data=json.dumps(body),
            content_type="application/json",
            **headers,
        )

    def test_backwards_compatible_heartbeat_without_network(self):
        response = self._post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_valid_network_measurement_accepted(self):
        measurement = valid_measurement(target_id=str(self.target.id))
        response = self._post({"network": {"version": 1, "measurements": [measurement]}})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["network"], "accepted")
        self.assertEqual(body["network_created"], 1)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)
        row = NetworkMeasurement.objects.get()
        self.assertEqual(row.latency_ms, 12.5)
        self.assertTrue(row.success)

    def test_duplicate_measurement_id_is_idempotent(self):
        measurement_id = str(uuid.uuid4())
        measurement = valid_measurement(
            measurement_id=measurement_id,
            target_id=str(self.target.id),
        )
        first = self._post({"network": {"version": 1, "measurements": [measurement]}})
        second = self._post({"network": {"version": 1, "measurements": [measurement]}})
        self.assertEqual(first.json()["network_created"], 1)
        self.assertEqual(second.json()["network_duplicates"], 1)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_invalid_payload_rejected(self):
        response = self._post({"network": {"version": 99, "measurements": []}})
        self.assertEqual(response.json()["network"], "rejected")
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_wrong_agent_assignment_rejected(self):
        other_server = Server.objects.create(name="other", hostname="other.local")
        other_agent, _token = create_agent(server=other_server, name="other-agent")
        foreign = NetworkTarget.objects.create(
            name="foreign",
            hostname_or_ip="8.8.8.8",
            protocol=NetworkTarget.Protocol.TCP,
            port=53,
            assigned_agent=other_agent,
        )
        response = self._post(
            {
                "network": {
                    "version": 1,
                    "measurements": [
                        valid_measurement(target_id=str(foreign.id)),
                    ],
                }
            }
        )
        self.assertEqual(response.json()["network"], "rejected")
        self.assertIn("not assigned", response.json()["network_detail"])

    def test_liveness_updates_when_network_rejected(self):
        earlier = timezone.now() - timedelta(hours=1)
        Server.objects.filter(pk=self.server.pk).update(
            last_seen_at=earlier,
            status=Server.Status.OFFLINE,
        )
        response = self._post({"network": {"version": 99, "measurements": []}})
        self.assertEqual(response.json()["network"], "rejected")
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.ONLINE)
        self.assertGreater(self.server.last_seen_at, earlier)

    def test_telemetry_accepted_with_invalid_network(self):
        response = self._post(
            {
                "telemetry": valid_telemetry(cpu_percent=21.0),
                "network": {"version": 99, "measurements": []},
            }
        )
        body = response.json()
        self.assertEqual(body["telemetry"], "accepted")
        self.assertEqual(body["network"], "rejected")
        self.assertEqual(ServerTelemetry.objects.get().cpu_percent, 21.0)

    def test_partial_loss_measurement(self):
        measurement = valid_measurement(
            target_id=str(self.target.id),
            success=True,
            latency_ms=30.0,
            packet_loss_percentage=50.0,
            probe_count=4,
            successful_probes=2,
        )
        response = self._post({"network": {"version": 1, "measurements": [measurement]}})
        self.assertEqual(response.json()["network"], "accepted")
        row = NetworkMeasurement.objects.get()
        self.assertEqual(row.packet_loss_percentage, 50.0)
        self.assertEqual(row.successful_probes, 2)

    def test_failed_measurement_without_latency(self):
        measurement = valid_measurement(
            target_id=str(self.target.id),
            success=False,
            latency_ms=None,
            packet_loss_percentage=100.0,
            probe_count=4,
            successful_probes=0,
            failure_reason="timeout",
        )
        response = self._post({"network": {"version": 1, "measurements": [measurement]}})
        self.assertEqual(response.json()["network"], "accepted")
        row = NetworkMeasurement.objects.get()
        self.assertFalse(row.success)
        self.assertIsNone(row.latency_ms)

    def test_too_many_measurements_rejected(self):
        measurements = [
            valid_measurement(target_id=str(self.target.id))
            for _ in range(MAX_MEASUREMENTS_PER_REPORT + 1)
        ]
        response = self._post(
            {"network": {"version": 1, "measurements": measurements}}
        )
        self.assertEqual(response.json()["network"], "rejected")
        self.assertIn("maximum", response.json()["network_detail"])


@override_settings(SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS=7)
class NetworkRetentionCommandTests(TestCase):
    def setUp(self):
        server = Server.objects.create(name="retain-host", hostname="retain.local")
        agent, _token = create_agent(server=server, name="retain-agent")
        target = NetworkTarget.objects.create(
            name="t",
            hostname_or_ip="1.1.1.1",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=agent,
        )
        old = timezone.now() - timedelta(days=10)
        recent = timezone.now() - timedelta(days=1)
        NetworkMeasurement.objects.create(
            id=uuid.uuid4(),
            target=target,
            agent=agent,
            measured_at=old,
            received_at=old,
            success=True,
            latency_ms=1.0,
            packet_loss_percentage=0.0,
            probe_count=1,
            successful_probes=1,
        )
        NetworkMeasurement.objects.create(
            id=uuid.uuid4(),
            target=target,
            agent=agent,
            measured_at=recent,
            received_at=recent,
            success=True,
            latency_ms=2.0,
            packet_loss_percentage=0.0,
            probe_count=1,
            successful_probes=1,
        )

    def test_retention_cleanup(self):
        out = StringIO()
        call_command("purge_network_measurements", stdout=out)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)
        self.assertIn("Deleted", out.getvalue())

    def test_retention_dry_run(self):
        out = StringIO()
        call_command("purge_network_measurements", dry_run=True, stdout=out)
        self.assertEqual(NetworkMeasurement.objects.count(), 2)
        self.assertIn("Would delete", out.getvalue())

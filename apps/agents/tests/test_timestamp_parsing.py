"""Regression tests: naive and malformed timestamps must never cause HTTP 500."""

import json
from datetime import timedelta
from datetime import timezone as dt_timezone

from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import DockerContainer, DockerHostState, Server, ServerTelemetry
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.tests.test_api import valid_measurement

MALFORMED_TIMESTAMPS = (
    "not-a-timestamp",
    "2026-13-45T10:00:00",
    "2026-02-30T10:00:00+00:00",
    "2026-10-01T25:61:00",
    "2026-10-01T10:00:00+99:00",
    "",
    12345,
    None,
)


def naive_utc_timestamp(minutes_ago: int = 1) -> str:
    moment = timezone.now() - timedelta(minutes=minutes_ago)
    return moment.astimezone(dt_timezone.utc).replace(tzinfo=None).isoformat()


class TimestampParsingTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="ts-host", hostname="ts.local")
        self.agent, self.token = create_agent(server=self.server, name="ts-agent")
        self.target = NetworkTarget.objects.create(
            name="ts-target",
            hostname_or_ip="1.1.1.1",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=self.agent,
        )

    def _post(self, body):
        return self.client.post(
            self.url,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )

    def test_naive_telemetry_timestamp_is_accepted_as_utc(self):
        naive = naive_utc_timestamp()
        response = self._post({"telemetry": valid_telemetry(collected_at=naive)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["telemetry"], "accepted")
        stored = ServerTelemetry.objects.get().collected_at
        self.assertEqual(stored.utcoffset(), timedelta(0))
        self.assertEqual(stored.replace(tzinfo=None).isoformat(), naive)

    def test_naive_docker_timestamps_are_accepted(self):
        naive = naive_utc_timestamp()
        container = valid_container(created_at=naive, started_at=naive)
        response = self._post(
            {"docker": valid_docker(collected_at=naive, containers=[container])}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["docker"], "accepted")
        self.assertTrue(DockerHostState.objects.exists())
        self.assertEqual(
            DockerContainer.objects.get().started_at.utcoffset(), timedelta(0)
        )

    def test_naive_network_timestamp_is_accepted(self):
        measurement = valid_measurement(
            target_id=str(self.target.id),
            measured_at=naive_utc_timestamp(),
        )
        response = self._post({"network": {"version": 1, "measurements": [measurement]}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["network"], "accepted")
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_malformed_telemetry_timestamps_rejected_without_500(self):
        for value in MALFORMED_TIMESTAMPS:
            with self.subTest(value=value):
                response = self._post({"telemetry": valid_telemetry(collected_at=value)})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertFalse(ServerTelemetry.objects.exists())

    def test_malformed_docker_timestamps_rejected_without_500(self):
        for value in MALFORMED_TIMESTAMPS:
            with self.subTest(field="collected_at", value=value):
                response = self._post({"docker": valid_docker(collected_at=value)})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["docker"], "rejected")
        for value in MALFORMED_TIMESTAMPS:
            if value in ("", None):
                continue  # optional container timestamps may be empty
            with self.subTest(field="started_at", value=value):
                response = self._post(
                    {"docker": valid_docker(containers=[valid_container(started_at=value)])}
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["docker"], "rejected")
        self.assertFalse(DockerContainer.objects.exists())

    def test_malformed_network_timestamps_rejected_without_500(self):
        for value in MALFORMED_TIMESTAMPS:
            with self.subTest(value=value):
                measurement = valid_measurement(
                    target_id=str(self.target.id), measured_at=value
                )
                response = self._post(
                    {"network": {"version": 1, "measurements": [measurement]}}
                )
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertEqual(body["network"], "rejected")
                self.assertEqual(body["network_rejected"], 1)
                self.assertEqual(
                    body["network_rejections"][0]["measurement_id"],
                    measurement["measurement_id"],
                )
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_malformed_timestamp_does_not_block_other_subsystems(self):
        measurement = valid_measurement(target_id=str(self.target.id))
        response = self._post(
            {
                "telemetry": valid_telemetry(collected_at="2026-13-45T10:00:00"),
                "docker": valid_docker(),
                "network": {"version": 1, "measurements": [measurement]},
            }
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["telemetry"], "rejected")
        self.assertEqual(body["docker"], "accepted")
        self.assertEqual(body["network"], "accepted")
        self.server.refresh_from_db()
        self.assertIsNotNone(self.server.last_seen_at)

    def test_unparseable_measurement_id_is_not_echoed(self):
        measurement = valid_measurement(
            target_id=str(self.target.id), measurement_id="not-a-uuid"
        )
        response = self._post({"network": {"version": 1, "measurements": [measurement]}})
        rejection = response.json()["network_rejections"][0]
        self.assertIsNone(rejection["measurement_id"])
        self.assertIn("measurement_id", rejection["reason"])

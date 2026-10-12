"""Regression tests: hostile or malformed numbers/bodies never cause HTTP 500
or store values PostgreSQL cannot represent (NaN, out-of-range bigint)."""

import json
import math

from django.test import Client, TestCase
from django.urls import reverse

from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import DockerContainer, Server, ServerTelemetry
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.tests.test_api import valid_measurement

BIGINT_OVERFLOW = 2**63


class PayloadHardeningTests(TestCase):
    def setUp(self):
        self.client = Client(raise_request_exception=False)
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="hard-host", hostname="hard.local")
        self.agent, self.token = create_agent(server=self.server, name="hard-agent")
        self.target = NetworkTarget.objects.create(
            name="hard-target",
            hostname_or_ip="192.0.2.10",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=self.agent,
        )

    def _post_raw(self, data: bytes):
        return self.client.post(
            self.url,
            data=data,
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self.token}",
        )

    def _post(self, body):
        # json.dumps emits NaN/Infinity literals, which json.loads accepts.
        return self._post_raw(json.dumps(body).encode())

    def _assert_liveness_recorded(self):
        self.server.refresh_from_db()
        self.assertIsNotNone(self.server.last_seen_at)

    def test_non_finite_telemetry_numbers_are_rejected(self):
        for field in ("cpu_percent", "memory_percent", "disk_percent"):
            for value in (math.nan, math.inf, -math.inf):
                with self.subTest(field=field, value=value):
                    response = self._post({"telemetry": valid_telemetry(**{field: value})})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertFalse(ServerTelemetry.objects.exists())
        self._assert_liveness_recorded()

    def test_telemetry_integers_beyond_bigint_are_rejected(self):
        cases = {
            "memory_total_bytes": {
                "memory_total_bytes": BIGINT_OVERFLOW,
                "memory_used_bytes": 1,
            },
            "disk_total_bytes": {"disk_total_bytes": BIGINT_OVERFLOW, "disk_used_bytes": 1},
            "uptime_seconds": {"uptime_seconds": BIGINT_OVERFLOW},
            "integral float": {"uptime_seconds": 1e300},
        }
        for label, overrides in cases.items():
            with self.subTest(label):
                response = self._post({"telemetry": valid_telemetry(**overrides)})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertFalse(ServerTelemetry.objects.exists())

    def test_non_finite_network_numbers_are_rejected(self):
        cases = (
            {"packet_loss_percentage": math.nan},
            {"latency_ms": math.nan},
            {"latency_ms": math.inf},
        )
        for overrides in cases:
            with self.subTest(overrides):
                item = valid_measurement(target_id=str(self.target.pk), **overrides)
                response = self._post({"network": {"version": 1, "measurements": [item]}})
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertEqual(body["network"], "rejected")
                self.assertFalse(body["network_rejections"][0]["retryable"])
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_ancient_timestamps_are_rejected(self):
        # Year-1 values with a positive offset fall before 0001-01-01 UTC, which
        # PostgreSQL stores but Python cannot load back.
        ancient = "0001-01-01T00:30:00+01:00"
        response = self._post(
            {
                "telemetry": valid_telemetry(collected_at=ancient),
                "docker": valid_docker(containers=[valid_container(started_at=ancient)]),
            }
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["telemetry"], "rejected")
        self.assertEqual(response.json()["docker"], "rejected")
        self.assertFalse(ServerTelemetry.objects.exists())
        self.assertFalse(DockerContainer.objects.exists())

    def test_oversized_integer_literal_is_treated_as_invalid_json(self):
        # Python refuses to convert integer literals over 4300 digits (ValueError,
        # not JSONDecodeError).
        response = self._post_raw(b'{"telemetry": {"version": ' + b"9" * 5000 + b"}}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["detail"], "invalid JSON body")
        self._assert_liveness_recorded()

    def test_invalid_utf8_body_is_treated_as_invalid_json(self):
        response = self._post_raw(b'{"telemetry": "\xff\xfe"}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["detail"], "invalid JSON body")
        self._assert_liveness_recorded()

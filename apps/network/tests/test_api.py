import json
import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.db import IntegrityError
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import Server, ServerTelemetry
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.reports import (
    MAX_MEASUREMENTS_PER_REPORT,
    apply_network_report,
    validate_network_payload,
)


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


class NetworkBatchValidationTests(TestCase):
    """Each measurement is validated and stored independently."""

    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="batch-host", hostname="batch.local")
        self.agent, self.token = create_agent(server=self.server, name="agent")
        self.target = NetworkTarget.objects.create(
            name="ok",
            hostname_or_ip="1.1.1.1",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=self.agent,
        )
        self.disabled = NetworkTarget.objects.create(
            name="disabled",
            hostname_or_ip="1.1.1.2",
            protocol=NetworkTarget.Protocol.TCP,
            port=443,
            assigned_agent=self.agent,
            enabled=False,
        )

    def _post_measurements(self, measurements, token=None, **extra):
        body = {"network": {"version": 1, "measurements": measurements}, **extra}
        return self.client.post(
            self.url,
            data=json.dumps(body),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token or self.token}",
        )

    def _valid(self, **overrides):
        return valid_measurement(target_id=str(self.target.id), **overrides)

    def test_all_valid_reports_counts_without_rejections(self):
        response = self._post_measurements([self._valid(), self._valid()])
        body = response.json()
        self.assertEqual(body["network"], "accepted")
        self.assertEqual(body["network_created"], 2)
        self.assertEqual(body["network_duplicates"], 0)
        self.assertEqual(body["network_accepted"], 2)
        self.assertEqual(body["network_rejected"], 0)
        self.assertNotIn("network_rejections", body)
        self.assertNotIn("network_detail", body)

    def test_one_invalid_measurement_does_not_reject_valid_ones(self):
        valid = [self._valid() for _ in range(9)]
        disabled = valid_measurement(target_id=str(self.disabled.id))
        response = self._post_measurements(valid + [disabled])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["network"], "partial")
        self.assertEqual(body["network_accepted"], 9)
        self.assertEqual(body["network_rejected"], 1)
        self.assertEqual(
            body["network_rejections"],
            [
                {
                    "measurement_id": disabled["measurement_id"],
                    "reason": "target is disabled",
                    "retryable": False,
                }
            ],
        )
        self.assertIn("1 measurement(s) rejected", body["network_detail"])
        self.assertEqual(NetworkMeasurement.objects.count(), 9)
        self.assertFalse(NetworkMeasurement.objects.filter(target=self.disabled).exists())

    def test_mixed_invalid_reasons_are_reported_individually(self):
        unknown = valid_measurement(target_id=str(uuid.uuid4()))
        bad_loss = self._valid(packet_loss_percentage=75.0)
        not_object = "garbage"
        good = self._valid()
        response = self._post_measurements([unknown, bad_loss, not_object, good])
        body = response.json()
        self.assertEqual(body["network"], "partial")
        self.assertEqual(body["network_accepted"], 1)
        self.assertEqual(body["network_rejected"], 3)
        rejections = body["network_rejections"]
        self.assertEqual(rejections[0]["measurement_id"], unknown["measurement_id"])
        self.assertIn("unknown target_id", rejections[0]["reason"])
        self.assertEqual(rejections[1]["measurement_id"], bad_loss["measurement_id"])
        self.assertIn("packet_loss_percentage", rejections[1]["reason"])
        self.assertIsNone(rejections[2]["measurement_id"])
        self.assertEqual(
            NetworkMeasurement.objects.get().pk, uuid.UUID(good["measurement_id"])
        )

    def test_all_invalid_is_rejected_with_counts(self):
        response = self._post_measurements(
            [valid_measurement(target_id=str(self.disabled.id)) for _ in range(3)]
        )
        body = response.json()
        self.assertEqual(body["network"], "rejected")
        self.assertEqual(body["network_accepted"], 0)
        self.assertEqual(body["network_rejected"], 3)
        self.assertEqual(len(body["network_rejections"]), 3)
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_duplicate_id_within_report_rejects_only_the_repeat(self):
        first = self._valid()
        repeat = dict(first)
        response = self._post_measurements([first, repeat])
        body = response.json()
        self.assertEqual(body["network"], "partial")
        self.assertEqual(body["network_created"], 1)
        self.assertEqual(
            body["network_rejections"],
            [
                {
                    "measurement_id": first["measurement_id"],
                    "reason": "duplicate measurement_id in report",
                    "retryable": False,
                }
            ],
        )
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_retry_of_partially_accepted_batch_is_idempotent(self):
        good = self._valid()
        bad = valid_measurement(target_id=str(self.disabled.id))
        self._post_measurements([good, bad])
        response = self._post_measurements([good, bad])
        body = response.json()
        self.assertEqual(body["network"], "partial")
        self.assertEqual(body["network_created"], 0)
        self.assertEqual(body["network_duplicates"], 1)
        self.assertEqual(body["network_accepted"], 1)
        self.assertEqual(body["network_rejected"], 1)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_measurement_id_owned_by_another_agent_is_not_a_duplicate(self):
        other_server = Server.objects.create(name="other", hostname="other.local")
        other_agent, other_token = create_agent(server=other_server, name="other")
        other_target = NetworkTarget.objects.create(
            name="other-target",
            hostname_or_ip="8.8.8.8",
            protocol=NetworkTarget.Protocol.TCP,
            port=53,
            assigned_agent=other_agent,
        )
        shared_id = str(uuid.uuid4())
        self._post_measurements(
            [valid_measurement(measurement_id=shared_id, target_id=str(other_target.id))],
            token=other_token,
        )
        response = self._post_measurements([self._valid(measurement_id=shared_id)])
        body = response.json()
        self.assertEqual(body["network"], "rejected")
        self.assertEqual(body["network_duplicates"], 0)
        self.assertEqual(
            body["network_rejections"],
            [
                {
                    "measurement_id": shared_id,
                    "reason": "measurement_id conflict",
                    "retryable": False,
                }
            ],
        )
        self.assertEqual(NetworkMeasurement.objects.get().agent, other_agent)

    def test_partial_network_keeps_telemetry_and_liveness_isolated(self):
        earlier = timezone.now() - timedelta(hours=1)
        Server.objects.filter(pk=self.server.pk).update(last_seen_at=earlier)
        response = self._post_measurements(
            [self._valid(), valid_measurement(target_id=str(self.disabled.id))],
            telemetry=valid_telemetry(cpu_percent=33.0),
        )
        body = response.json()
        self.assertEqual(body["telemetry"], "accepted")
        self.assertEqual(body["network"], "partial")
        self.assertEqual(ServerTelemetry.objects.get().cpu_percent, 33.0)
        self.server.refresh_from_db()
        self.assertGreater(self.server.last_seen_at, earlier)

    def test_results_identify_every_measurement_exactly(self):
        stored = self._valid()
        self._post_measurements([stored])
        new = self._valid()
        rejected = valid_measurement(target_id=str(self.disabled.id))
        response = self._post_measurements([stored, new, rejected, "garbage"])
        results = {
            entry["measurement_id"]: entry for entry in response.json()["network_results"]
        }
        self.assertEqual(len(results), 3)
        self.assertEqual(results[new["measurement_id"]], {
            "measurement_id": new["measurement_id"], "result": "created",
        })
        self.assertEqual(results[stored["measurement_id"]]["result"], "duplicate")
        self.assertEqual(results[rejected["measurement_id"]], {
            "measurement_id": rejected["measurement_id"],
            "result": "rejected",
            "reason": "target is disabled",
            "retryable": False,
        })

    def test_results_list_each_id_once_for_in_report_duplicates(self):
        first = self._valid()
        response = self._post_measurements([first, dict(first)])
        results = response.json()["network_results"]
        self.assertEqual(
            results, [{"measurement_id": first["measurement_id"], "result": "created"}]
        )

    def test_storage_failure_is_marked_retryable(self):
        measurement = self._valid()
        with patch.object(
            NetworkMeasurement.objects, "create", side_effect=IntegrityError("fk")
        ):
            response = self._post_measurements([measurement])
        entry = response.json()["network_results"][0]
        self.assertEqual(entry["result"], "rejected")
        self.assertEqual(entry["reason"], "measurement could not be stored")
        self.assertTrue(entry["retryable"])

    def test_results_empty_list_for_empty_report(self):
        response = self._post_measurements([])
        body = response.json()
        self.assertEqual(body["network"], "accepted")
        self.assertEqual(body["network_results"], [])

    def test_target_lookups_do_not_scale_with_batch_size(self):
        measurements = [self._valid() for _ in range(MAX_MEASUREMENTS_PER_REPORT)]
        with self.assertNumQueries(1):
            report = validate_network_payload(
                {"version": 1, "measurements": measurements}, agent=self.agent
            )
        result = apply_network_report(self.agent, report)
        self.assertEqual(result.created, MAX_MEASUREMENTS_PER_REPORT)
        self.assertEqual(result.status, "accepted")


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

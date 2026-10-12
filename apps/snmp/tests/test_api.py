import json
import threading
from unittest.mock import patch

from django.db import OperationalError, connection
from django.test import Client, TestCase, TransactionTestCase
from django.urls import reverse
from django.utils import timezone

from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import DockerContainer, Server, ServerTelemetry
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.tests.test_api import valid_measurement
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample
from apps.snmp.tests.helpers import interface, make_agent, make_device, poll, report

SNMP_KEYS = {
    "snmp",
    "snmp_created",
    "snmp_duplicates",
    "snmp_accepted",
    "snmp_rejected",
    "snmp_results",
    "snmp_rejections",
    "snmp_detail",
}


class HeartbeatSnmpTestCase(TestCase):
    def setUp(self):
        self.client = Client(raise_request_exception=False)
        self.url = reverse("agent-heartbeat")
        self.agent, self.token = make_agent()
        self.device = make_device(self.agent)

    def post(self, body=None, token=None, raw=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token or self.token}"}
        if raw is not None:
            return self.client.post(self.url, data=raw, content_type="application/json", **headers)
        return self.client.post(self.url, data=json.dumps(body), content_type="application/json", **headers)

    def snmp(self, *polls, **kwargs):
        return self.post({"snmp": report(list(polls))}, **kwargs)


class BackwardCompatibilityTests(HeartbeatSnmpTestCase):
    def test_heartbeats_without_an_snmp_section_are_unchanged(self):
        for body in (None, {}, {"telemetry": valid_telemetry()}):
            with self.subTest(body=body):
                response = self.client.post(self.url, HTTP_AUTHORIZATION=f"Bearer {self.token}") if body is None else self.post(body)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(SNMP_KEYS & set(response.json()), set())
        self.assertFalse(DevicePoll.objects.exists())
        self.assertFalse(DeviceSnmpState.objects.exists())

    def test_telemetry_docker_and_network_heartbeats_work_with_the_snmp_app_installed(self):
        target = NetworkTarget.objects.create(
            name="t", hostname_or_ip="192.0.2.1", protocol="tcp", port=443, assigned_agent=self.agent
        )
        body = {
            "telemetry": valid_telemetry(),
            "docker": valid_docker(containers=[valid_container()]),
            "network": {"version": 1, "measurements": [valid_measurement(target_id=str(target.pk))]},
        }
        response = self.post(body)
        data = response.json()
        self.assertEqual((data["telemetry"], data["docker"], data["network"]), ("accepted", "accepted", "accepted"))
        self.assertEqual(SNMP_KEYS & set(data), set())
        self.assertTrue(ServerTelemetry.objects.exists())
        self.assertTrue(DockerContainer.objects.exists())
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_an_old_agent_never_has_snmp_data_stored(self):
        # Old agents do not send the section; devices stay inventory-only.
        self.post({"telemetry": valid_telemetry()})
        self.assertFalse(Interface.objects.exists())


class SnmpSectionTests(HeartbeatSnmpTestCase):
    def test_accepted_response_shape(self):
        payload = poll(self.device)
        response = self.snmp(payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["snmp"], "accepted")
        self.assertEqual(
            (data["snmp_created"], data["snmp_duplicates"], data["snmp_accepted"], data["snmp_rejected"]),
            (1, 0, 1, 0),
        )
        self.assertEqual(data["snmp_results"], [{"poll_id": payload["poll_id"], "result": "created"}])
        self.assertNotIn("snmp_rejections", data)
        self.assertNotIn("snmp_detail", data)
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_a_resent_report_is_acknowledged_as_duplicates(self):
        payload = poll(self.device)
        self.snmp(payload)
        data = self.snmp(payload).json()
        self.assertEqual((data["snmp"], data["snmp_created"], data["snmp_duplicates"]), ("accepted", 0, 1))
        self.assertEqual(data["snmp_results"], [{"poll_id": payload["poll_id"], "result": "duplicate"}])
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_partial_report_lists_rejections_with_retryability(self):
        other_agent, _token = make_agent("other")
        foreign = make_device(other_agent, "foreign", management_address="192.0.2.77")
        good, bad = poll(self.device, minutes=3), poll(foreign, minutes=2)
        data = self.snmp(good, bad).json()
        self.assertEqual((data["snmp"], data["snmp_accepted"], data["snmp_rejected"]), ("partial", 1, 1))
        self.assertEqual(
            data["snmp_rejections"],
            [{"poll_id": bad["poll_id"], "reason": "unknown device_id or device not assigned to this agent", "retryable": True}],
        )
        self.assertIn("1 poll(s) rejected; first: unknown device_id", data["snmp_detail"])
        results = {entry["poll_id"]: entry for entry in data["snmp_results"]}
        self.assertEqual(results[good["poll_id"]]["result"], "created")
        self.assertEqual(results[bad["poll_id"]]["result"], "rejected")

    def test_fully_rejected_report(self):
        data = self.snmp(poll(self.device, reachable="maybe")).json()
        self.assertEqual((data["snmp"], data["snmp_accepted"], data["snmp_rejected"]), ("rejected", 0, 1))

    def test_envelope_errors_reject_the_section_but_not_the_heartbeat(self):
        for section in (None, "text", [], {"version": 2, "polls": []}, {"version": 1}, {"version": 1, "polls": "x"}):
            with self.subTest(section=section):
                before = self.agent_last_seen()
                response = self.post({"snmp": section, "telemetry": valid_telemetry()})
                data = response.json()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(data["snmp"], "rejected")
                self.assertIn("snmp_detail", data)
                self.assertNotIn("snmp_results", data)
                self.assertEqual(data["telemetry"], "accepted")  # other subsystems are unaffected
                self.assertGreaterEqual(self.agent_last_seen(), before)
        self.assertFalse(DevicePoll.objects.exists())

    def agent_last_seen(self):
        self.agent.refresh_from_db()
        return self.agent.last_seen_at or timezone.now().replace(year=2000)

    def test_an_invalid_snmp_section_does_not_block_liveness_or_other_sections(self):
        target = NetworkTarget.objects.create(
            name="t", hostname_or_ip="192.0.2.1", protocol="tcp", port=443, assigned_agent=self.agent
        )
        body = {
            "snmp": {"version": 1, "polls": [poll(self.device, reachable="maybe")]},
            "network": {"version": 1, "measurements": [valid_measurement(target_id=str(target.pk))]},
        }
        data = self.post(body).json()
        self.assertEqual((data["snmp"], data["network"]), ("rejected", "accepted"))
        self.assertEqual(NetworkMeasurement.objects.count(), 1)
        server = Server.objects.get(pk=self.agent.server_id)
        self.assertEqual(server.status, "online")

    def test_all_sections_together(self):
        target = NetworkTarget.objects.create(
            name="t", hostname_or_ip="192.0.2.1", protocol="tcp", port=443, assigned_agent=self.agent
        )
        body = {
            "telemetry": valid_telemetry(),
            "docker": valid_docker(containers=[valid_container()]),
            "network": {"version": 1, "measurements": [valid_measurement(target_id=str(target.pk))]},
            "snmp": report([poll(self.device, [interface(1), interface(2)])]),
        }
        data = self.post(body).json()
        self.assertEqual(
            (data["telemetry"], data["docker"], data["network"], data["snmp"]),
            ("accepted", "accepted", "accepted", "accepted"),
        )
        self.assertEqual(InterfaceSample.objects.count(), 2)

    def test_authentication_is_required_and_nothing_is_stored_without_it(self):
        response = self.client.post(
            self.url,
            data=json.dumps({"snmp": report([poll(self.device)])}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer wrong-token",
        )
        self.assertEqual(response.status_code, 401)
        response = self.client.post(self.url, data=json.dumps({"snmp": report([poll(self.device)])}), content_type="application/json")
        self.assertEqual(response.status_code, 401)
        self.assertFalse(DevicePoll.objects.exists())

    def test_a_disabled_agent_cannot_report(self):
        self.agent.enabled = False
        self.agent.save()
        self.assertEqual(self.snmp(poll(self.device)).status_code, 401)
        self.assertFalse(DevicePoll.objects.exists())

    def test_an_agent_cannot_report_for_another_agents_device(self):
        other_agent, other_token = make_agent("other")
        data = self.snmp(poll(self.device), token=other_token).json()
        self.assertEqual((data["snmp"], data["snmp_accepted"]), ("rejected", 0))
        self.assertFalse(DevicePoll.objects.exists())

    def test_a_database_outage_returns_an_error_and_acknowledges_nothing(self):
        with patch.object(DevicePoll.objects, "bulk_create", side_effect=OperationalError("down")), self.assertLogs(
            "django.request", level="ERROR"
        ):
            response = self.snmp(poll(self.device))
        # Non-2xx: the agent keeps every poll queued and resends.
        self.assertEqual(response.status_code, 500)
        self.assertFalse(DevicePoll.objects.exists())

    def test_secrets_in_the_payload_are_not_stored_or_echoed(self):
        secret = "SuperSecretCommunity-42"
        payload = poll(self.device, community=secret, auth_key=secret)
        response = self.snmp(payload)
        self.assertNotIn(secret, response.content.decode())
        for model in (DevicePoll, DeviceSnmpState, Interface, InterfaceSample):
            for row in model.objects.values():
                self.assertNotIn(secret, repr(row))

    def test_rejection_reasons_do_not_echo_payload_values(self):
        payload = poll(self.device)
        payload["measured_at"] = "<script>alert('TopSecret')</script>"
        content = self.snmp(payload).content.decode()
        self.assertNotIn("TopSecret", content)


class ConcurrentHeartbeatTests(TransactionTestCase):
    def test_the_same_snmp_report_sent_concurrently_is_stored_once(self):
        agent, token = make_agent("race")
        device = make_device(agent)
        polls = [poll(device, [interface(i) for i in range(1, 4)], minutes=m) for m in range(1, 9)]
        body = json.dumps({"snmp": report(polls)})
        barrier = threading.Barrier(3)
        responses, errors = [], []

        def worker():
            try:
                barrier.wait(timeout=10)
                response = Client().post(
                    reverse("agent-heartbeat"),
                    data=body,
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {token}",
                )
                responses.append(response.json())
            except Exception as exc:  # noqa: BLE001 - surfaced via assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)

        self.assertEqual(errors, [])
        self.assertEqual(DevicePoll.objects.count(), 8)
        self.assertEqual(InterfaceSample.objects.count(), 24)
        self.assertEqual(sum(r["snmp_created"] for r in responses), 8)
        self.assertEqual(sum(r["snmp_duplicates"] for r in responses), 16)
        for response in responses:
            self.assertEqual(response["snmp"], "accepted")
            self.assertEqual(len(response["snmp_results"]), 8)

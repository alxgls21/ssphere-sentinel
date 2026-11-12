"""Network targets from the console (``apps.console.target_config``): adding, changing, enabling, disabling
and deleting them by the editor gate and the admin's permissions, the entry for the agent's targets file,
and the audit trail. Reading them is ``test_targets_api``."""

from __future__ import annotations

import json
import tempfile
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from django.test import Client, TestCase
from django.utils import timezone

from agent.network_config import load_network_targets
from apps.agents.services import create_agent
from apps.console.models import AuditEntry
from apps.console.tests.helpers import API, grant, make_admin, make_editor, make_server, make_user, send, signed_in_client
from apps.inventory.models import Customer, Site
from apps.network.models import NetworkMeasurement, NetworkTarget

TARGETS = API + "targets/"
MODEL_PERMISSIONS = ("network.add_networktarget", "network.change_networktarget", "network.delete_networktarget")
NOT_A_HOSTNAME = "Expected a host name (letters, digits, hyphens and dots) or an IP address."
DETAIL_KEYS = {"generatedAt", "item", "measurements", "availability24h", "agentEntry"}
# The keys of an entry of agent/network_targets.example.json, no more and no less.
ENTRY_KEYS = {"id", "name", "hostname_or_ip", "protocol", "port", "enabled", "monitoring_interval_seconds", "timeout_seconds", "probe_count"}


class TargetConfigTestCase(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.server = make_server("probe-host", site=self.hq, now=self.now)
        self.agent, self.token = create_agent(server=self.server, name="probe-agent")
        self.editor = make_editor()
        self.client_ = signed_in_client(self.editor)

    def target(self, name="edge-gw", **fields):
        values = {"hostname_or_ip": "192.0.2.10", "protocol": "icmp", "site": self.hq, "assigned_agent": self.agent, **fields}
        return NetworkTarget.objects.create(name=name, **values)

    def measure(self, target, ago):
        return NetworkMeasurement.objects.create(
            id=uuid.uuid4(), target=target, agent=self.agent, measured_at=self.now - timedelta(seconds=ago),
            received_at=self.now, success=True, latency_ms=12.5, packet_loss_percentage=0.0, probe_count=4, successful_probes=4,
        )

    def audit(self, action):
        return list(AuditEntry.objects.filter(action=action).order_by("pk"))


class PermissionTests(TargetConfigTestCase):
    def setUp(self):
        super().setUp()
        self.existing = self.target("existing")

    def writes(self, client: Client):
        return (
            send(client, "post", TARGETS, {"name": "new", "address": "192.0.2.20", "protocol": "icmp"}),
            send(client, "patch", f"{TARGETS}{self.existing.pk}/", {"name": "renamed"}),
            send(client, "delete", f"{TARGETS}{self.existing.pk}/"),
        )

    def assert_refused(self, client, status):
        for response in self.writes(client):
            self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(NetworkTarget.objects.count(), 1)
        self.assertEqual(NetworkTarget.objects.get().name, "existing")
        self.assertFalse(AuditEntry.objects.exists())

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)

    def test_a_reader_may_read_but_not_write(self):
        viewer = signed_in_client(make_user("viewer", all_customers=True))
        self.assertEqual(viewer.get(f"{TARGETS}{self.existing.pk}/").status_code, 200)
        self.assert_refused(viewer, 403)
        self.assertFalse(viewer.get(API + "session/").json()["capabilities"]["manageTargets"])

    def test_the_rule_permission_the_model_permissions_and_every_customer_are_all_needed(self):
        # A restricted account cannot even see the other customer's targets: it has nothing to administer.
        restricted = grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *MODEL_PERMISSIONS)
        self.assert_refused(signed_in_client(restricted), 403)
        self.assert_refused(signed_in_client(grant(make_user("rules-only", all_customers=True), "alerts.change_alertrule")), 403)
        self.assert_refused(signed_in_client(grant(make_user("models-only", all_customers=True), *MODEL_PERMISSIONS)), 403)

    def test_each_write_needs_the_permission_the_admin_asks_for_it(self):
        for codename, expected in (
            ("network.add_networktarget", (201, 403, 403)),
            ("network.change_networktarget", (403, 200, 403)),
            ("network.delete_networktarget", (403, 403, 200)),
        ):
            with self.subTest(permission=codename):
                client = signed_in_client(grant(make_user(codename, all_customers=True), "alerts.change_alertrule", codename))
                self.assertEqual(tuple(r.status_code for r in self.writes(client)), expected)
                self.assertFalse(client.get(API + "session/").json()["capabilities"]["manageTargets"])
                # Put things back for the next account.
                NetworkTarget.objects.filter(name="new").delete()
                NetworkTarget.objects.filter(pk=self.existing.pk).update(name="existing")
                if not NetworkTarget.objects.filter(pk=self.existing.pk).exists():
                    self.existing = self.target("existing")
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["manageTargets"])
        self.assertTrue(signed_in_client(make_admin()).get(API + "session/").json()["capabilities"]["manageTargets"])

    def test_the_refusal_names_the_permission_not_the_target(self):
        response = send(signed_in_client(make_user("plain", all_customers=True)), "patch", f"{TARGETS}{self.existing.pk}/", {"name": "x"})
        self.assertEqual(response.json()["error"], {"code": "forbidden", "message": "This account may not add or change network targets."})

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.editor, enforce_csrf=True)
        for response in self.writes(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(send(client, "patch", f"{TARGETS}{self.existing.pk}/", {"name": "renamed"}, HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.put(TARGETS, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.put(f"{TARGETS}{self.existing.pk}/", "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.post(f"{TARGETS}{self.existing.pk}/", "{}", content_type="application/json").status_code, 405)


class CreateTests(TargetConfigTestCase):
    def test_a_target_is_created_with_its_detail_and_the_agents_entry(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", TARGETS, {
                "name": "  edge-tcp ", "address": "edge.example.net", "protocol": "tcp", "port": 443, "enabled": True,
                "intervalSeconds": 30, "timeoutSeconds": 3, "expectedSlaPercent": 99.5, "customerLabel": "Acme (contract 7)",
                "circuitId": "CIRC-42", "siteId": str(self.hq.pk), "agentId": str(self.agent.pk),
            })
        self.assertEqual(response.status_code, 201, response.content)
        target = NetworkTarget.objects.get(name="edge-tcp")
        self.assertEqual(response["Location"], f"{TARGETS}{target.pk}/")
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertEqual(set(body), DETAIL_KEYS)
        item = body["item"]
        self.assertEqual((item["target"]["name"], item["target"]["address"], item["target"]["protocol"], item["target"]["port"]), ("edge-tcp", "edge.example.net", "tcp", 443))
        self.assertEqual((item["target"]["intervalSeconds"], item["target"]["timeoutSeconds"], item["target"]["circuitId"]), (30, 3, "CIRC-42"))
        self.assertEqual((item["target"]["expectedSlaPercent"], item["target"]["customerLabel"]), (99.5, "Acme (contract 7)"))
        self.assertEqual((item["customerName"], item["siteName"], item["target"]["agent"]["name"]), ("Acme", "HQ", "probe-agent"))
        # The agent has never reported yet: nothing is measured, and the detail says so.
        self.assertEqual((item["health"], item["reason"], item["latest"], body["measurements"]), ("unknown", "agent_offline", None, []))
        self.assertEqual(body["agentEntry"], {
            "id": str(target.pk), "name": "edge-tcp", "hostname_or_ip": "edge.example.net", "protocol": "tcp", "port": 443,
            "enabled": True, "monitoring_interval_seconds": 30, "timeout_seconds": 3, "probe_count": 4,
        })
        self.assertEqual((target.expected_sla_percentage, target.customer_name, target.assigned_agent_id), (Decimal("99.50"), "Acme (contract 7)", self.agent.pk))
        read = self.client_.get(f"{TARGETS}{target.pk}/").json()
        self.assertEqual((body["item"], body["agentEntry"]), (read["item"], read["agentEntry"]))
        [created] = self.audit("target_created")
        self.assertEqual((created.actor_id, created.actor_name, created.target_type, created.target_id, created.target_name), (self.editor.pk, "editor", "target", str(target.pk), "edge-tcp"))
        self.assertEqual(created.changes["address"], {"before": None, "after": "edge.example.net"})
        self.assertEqual(created.changes["agentId"], {"before": None, "after": str(self.agent.pk)})
        self.assertEqual(created.changes["expectedSlaPercent"], {"before": None, "after": "99.50"})
        self.assertEqual(logs.output, [f"INFO:apps.console:Network target created (target={target.pk}, site={self.hq.pk}, agent={self.agent.pk}, user_id={self.editor.pk})"])

    def test_the_agents_entry_is_what_the_agent_reads(self):
        # The entry the console shows is a line of the agent's own targets file: the agent, unchanged, loads it.
        for body in (
            {"name": "gw", "address": "192.0.2.1", "protocol": "icmp"},
            {"name": "dns", "address": "dns.example.net", "protocol": "tcp", "port": 53, "intervalSeconds": 300, "timeoutSeconds": 10, "enabled": False},
        ):
            with self.subTest(body=body):
                entry = send(self.client_, "post", TARGETS, body).json()["agentEntry"]
                self.assertEqual(set(entry), ENTRY_KEYS)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "targets.json"
                    path.write_text(json.dumps({"targets": [entry]}), encoding="utf-8")
                    [loaded] = load_network_targets({"SENTINEL_NETWORK_TARGETS_FILE": str(path)})
                self.assertEqual(str(loaded.id), entry["id"])
                self.assertEqual((loaded.hostname_or_ip, loaded.protocol, loaded.port, loaded.enabled), (body["address"], body["protocol"], body.get("port"), body.get("enabled", True)))
                self.assertEqual((loaded.monitoring_interval_seconds, loaded.timeout_seconds, loaded.probe_count), (body.get("intervalSeconds", 60), body.get("timeoutSeconds", 2), 4))

    def test_only_the_name_the_address_and_the_protocol_are_required(self):
        response = send(self.client_, "post", TARGETS, {"name": "gw", "address": "192.0.2.1", "protocol": "icmp"})
        self.assertEqual(response.status_code, 201, response.content)
        target = NetworkTarget.objects.get(name="gw")
        self.assertEqual(
            (target.port, target.enabled, target.monitoring_interval_seconds, target.timeout_seconds, target.expected_sla_percentage),
            (None, True, 60, 2, Decimal("99.90")),
        )
        self.assertEqual((target.customer_name, target.circuit_identifier, target.site_id, target.assigned_agent_id), ("", "", None, None))
        item = response.json()["item"]
        self.assertEqual((item["target"]["agentAssigned"], item["target"]["agent"], item["health"], item["reason"]), (False, None, "unknown", "no_agent"))
        self.assertEqual((item["target"]["siteId"], item.get("customerName"), item["target"]["circuitId"]), (None, None, None))
        self.assertIsNone(response.json()["agentEntry"]["port"])
        # Explicit nothings are the same.
        self.assertEqual(send(self.client_, "post", TARGETS, {"name": "gw-2", "address": "192.0.2.2", "protocol": "icmp", "port": None, "siteId": None, "agentId": None}).status_code, 201)

    def test_a_target_without_a_site_is_seen_by_every_customer_accounts_only(self):
        lonely = send(self.client_, "post", TARGETS, {"name": "lonely", "address": "192.0.2.1", "protocol": "icmp"}).json()["item"]["target"]["id"]
        placed = send(self.client_, "post", TARGETS, {"name": "placed", "address": "192.0.2.1", "protocol": "icmp", "siteId": str(self.hq.pk)}).json()["item"]["target"]["id"]
        restricted = signed_in_client(make_user("restricted", customers=[self.acme]))
        self.assertEqual(restricted.get(f"{TARGETS}{lonely}/").status_code, 404)
        self.assertEqual(restricted.get(f"{TARGETS}{placed}/").status_code, 200)

    def test_the_body_is_checked_field_by_field(self):
        base = {"name": "gw", "address": "192.0.2.1", "protocol": "icmp"}
        cases = [
            ({}, "name", "Required."),
            ({}, "address", "Required."),
            ({}, "protocol", "Required."),
            ({**base, "name": "  "}, "name", "Required."),
            ({**base, "name": 1}, "name", "Expected text."),
            ({**base, "name": "a" * 256}, "name", "At most 255 characters."),
            ({**base, "name": "gw\x1b[0m"}, "name", "Control characters are not allowed."),
            ({**base, "address": "not a host"}, "address", NOT_A_HOSTNAME),
            ({**base, "address": "web_1"}, "address", NOT_A_HOSTNAME),
            ({**base, "address": "host;rm -rf /"}, "address", NOT_A_HOSTNAME),
            ({**base, "address": ""}, "address", NOT_A_HOSTNAME),
            ({**base, "protocol": "udp"}, "protocol", "Expected one of icmp, tcp."),
            ({**base, "protocol": "tcp"}, "port", "TCP targets require a port."),
            ({**base, "port": 80}, "port", "ICMP targets must not set a port."),
            ({**base, "protocol": "tcp", "port": 0}, "port", "Expected a whole number from 1 to 65535."),
            ({**base, "protocol": "tcp", "port": 65536}, "port", "Expected a whole number from 1 to 65535."),
            ({**base, "protocol": "tcp", "port": "443"}, "port", "Expected a whole number from 1 to 65535."),
            ({**base, "protocol": "tcp", "port": True}, "port", "Expected a whole number from 1 to 65535."),
            ({**base, "enabled": "yes"}, "enabled", "Expected true or false."),
            ({**base, "intervalSeconds": 9}, "intervalSeconds", "Expected a whole number from 10 to 86400."),
            ({**base, "intervalSeconds": 86401}, "intervalSeconds", "Expected a whole number from 10 to 86400."),
            ({**base, "intervalSeconds": 60.5}, "intervalSeconds", "Expected a whole number from 10 to 86400."),
            ({**base, "timeoutSeconds": 0}, "timeoutSeconds", "Expected a whole number from 1 to 30."),
            ({**base, "timeoutSeconds": 31}, "timeoutSeconds", "Expected a whole number from 1 to 30."),
            ({**base, "expectedSlaPercent": 100.01}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "expectedSlaPercent": -1}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "expectedSlaPercent": "NaN"}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "expectedSlaPercent": "1e400"}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "expectedSlaPercent": True}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "expectedSlaPercent": None}, "expectedSlaPercent", "Expected a number from 0 to 100."),
            ({**base, "customerLabel": "c" * 256}, "customerLabel", "At most 255 characters."),
            ({**base, "customerName": "Acme"}, "customerName", "Unknown field."),
            ({**base, "circuitId": 7}, "circuitId", "Expected text."),
            ({**base, "siteId": "not-an-id"}, "siteId", "Expected the id of a site."),
            ({**base, "siteId": str(uuid.uuid4())}, "siteId", "No such site."),
            ({**base, "agentId": "not-an-id"}, "agentId", "Expected the id of an agent."),
            ({**base, "agentId": str(uuid.uuid4())}, "agentId", "No such agent."),
            ({**base, "id": str(uuid.uuid4())}, "id", "Unknown field."),
            ({**base, "probeCount": 4}, "probeCount", "Unknown field."),
            ({**base, "hostname_or_ip": "192.0.2.1"}, "hostname_or_ip", "Unknown field."),
        ]
        for body, field, message in cases:
            with self.subTest(body=body):
                response = send(self.client_, "post", TARGETS, body)
                self.assertEqual(response.status_code, 400, response.content)
                error = response.json()["error"]
                self.assertEqual(error["code"], "validation_error")
                self.assertEqual(error["fields"][field], [message])
        self.assertFalse(NetworkTarget.objects.exists())
        self.assertFalse(AuditEntry.objects.exists())

    def test_the_body_must_be_a_small_json_object(self):
        self.assertEqual(send(self.client_, "post", TARGETS, {"name": "x", "address": "192.0.2.1", "protocol": "icmp", "circuitId": "c" * 8200}).status_code, 413)
        self.assertEqual(self.client_.post(TARGETS, "name=x", content_type="application/x-www-form-urlencoded").status_code, 415)
        self.assertEqual(self.client_.post(TARGETS, "[1]", content_type="application/json").status_code, 400)
        self.assertEqual(self.client_.post(TARGETS + "?x=1", json.dumps({"name": "x", "address": "192.0.2.1", "protocol": "icmp"}), content_type="application/json").status_code, 400)
        self.assertFalse(NetworkTarget.objects.exists())

    def test_an_administrator_may_do_all_of_it(self):
        client = signed_in_client(make_admin())
        response = send(client, "post", TARGETS, {"name": "gw", "address": "192.0.2.1", "protocol": "icmp", "agentId": str(self.agent.pk)})
        self.assertEqual(response.status_code, 201, response.content)
        target_id = response.json()["item"]["target"]["id"]
        self.assertEqual(send(client, "patch", f"{TARGETS}{target_id}/", {"enabled": False}).status_code, 200)
        self.assertEqual(send(client, "delete", f"{TARGETS}{target_id}/").status_code, 200)


class ChangeTests(TargetConfigTestCase):
    def test_the_fields_sent_change_and_the_rest_stays(self):
        target = self.target("gw", customer_name="Acme", circuit_identifier="C-1")
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {
            "name": "gateway", "intervalSeconds": 120, "siteId": str(self.plant.pk), "agentId": None, "expectedSlaPercent": "99",
        })
        self.assertEqual(response.status_code, 200, response.content)
        target.refresh_from_db()
        self.assertEqual((target.name, target.monitoring_interval_seconds, target.site_id, target.assigned_agent_id), ("gateway", 120, self.plant.pk, None))
        self.assertEqual((target.customer_name, target.circuit_identifier, target.expected_sla_percentage), ("Acme", "C-1", Decimal("99.00")))
        item = response.json()["item"]
        self.assertEqual((item["target"]["agentAssigned"], item["siteName"], item["customerName"], item["reason"]), (False, "Plant", "Globex", "no_agent"))
        self.assertEqual((item["target"]["expectedSlaPercent"], item["target"]["customerLabel"]), (99.0, "Acme"))
        self.assertEqual(response.json()["agentEntry"]["monitoring_interval_seconds"], 120)
        [changed] = self.audit("target_changed")
        self.assertEqual(changed.changes, {
            "agentId": {"before": str(self.agent.pk), "after": None},
            "expectedSlaPercent": {"before": "99.90", "after": "99.00"},
            "intervalSeconds": {"before": 60, "after": 120},
            "name": {"before": "gw", "after": "gateway"},
            "siteId": {"before": str(self.hq.pk), "after": str(self.plant.pk)},
        })
        self.assertEqual((changed.target_id, changed.target_name), (str(target.pk), "gateway"))
        # Nothing to change: the detail as it is, and nothing recorded.
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"name": "gateway", "agentId": None}).status_code, 200)
        self.assertEqual(len(self.audit("target_changed")), 1)
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{target.pk}/", {}).status_code, 200)

    def test_enabling_and_disabling_are_recorded_as_such(self):
        target = self.target()
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"enabled": False})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["item"]["health"], response.json()["item"]["reason"]), ("idle", "disabled"))
        self.assertFalse(NetworkTarget.objects.get(pk=target.pk).enabled)
        [disabled] = self.audit("target_disabled")
        self.assertEqual(disabled.changes, {"enabled": {"before": True, "after": False}})
        self.assertEqual(self.audit("target_changed"), [])
        self.assertIn(f"Network target changed (target={target.pk}", "\n".join(logs.output))
        # Switched on and renamed at once: the switch is its own entry, the rest another.
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"enabled": True, "name": "gw-2"}).status_code, 200)
        [enabled] = self.audit("target_enabled")
        self.assertEqual(enabled.changes, {"enabled": {"before": False, "after": True}})
        [changed] = self.audit("target_changed")
        self.assertEqual(changed.changes, {"name": {"before": "edge-gw", "after": "gw-2"}})

    def test_a_tcp_target_needs_its_port_and_an_icmp_target_none(self):
        target = self.target()
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"protocol": "tcp"})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"port": ["TCP targets require a port."]}))
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"protocol": "tcp", "port": 443}).status_code, 200)
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"protocol": "icmp"})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"port": ["ICMP targets must not set a port."]}))
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"protocol": "icmp", "port": None}).status_code, 200)
        target.refresh_from_db()
        self.assertEqual((target.protocol, target.port), ("icmp", None))
        # A refused change leaves no trace.
        self.assertEqual(len(self.audit("target_changed")), 2)

    def test_the_agent_must_be_one_of_a_server_the_account_sees(self):
        target = self.target(assigned_agent=None)
        other, _ = create_agent(server=make_server("other-host", site=self.plant, now=self.now), name="other")
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"agentId": str(other.pk)})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["item"]["target"]["agent"]["serverName"], "other-host")
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"agentId": str(uuid.uuid4())})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"agentId": ["No such agent."]}))
        # The agent's own id is what is asked for, not its server's.
        response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", {"agentId": str(self.server.pk)})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"agentId": ["No such agent."]}))

    def test_an_unknown_or_hidden_target_is_not_found_and_a_restricted_account_refused(self):
        self.assertEqual(send(self.client_, "patch", f"{TARGETS}{uuid.uuid4()}/", {"name": "x"}).status_code, 404)
        self.assertEqual(send(self.client_, "delete", f"{TARGETS}{uuid.uuid4()}/").status_code, 404)
        self.assertEqual(send(self.client_, "patch", TARGETS + "not-a-uuid/", {"name": "x"}).status_code, 404)
        # An account restricted to Acme holds every permission but cannot see Globex: refused before anything is looked up.
        plant = self.target("plant-gw", site=self.plant)
        restricted = signed_in_client(grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *MODEL_PERMISSIONS))
        self.assertEqual(restricted.get(f"{TARGETS}{plant.pk}/").status_code, 404)
        self.assertEqual(send(restricted, "patch", f"{TARGETS}{plant.pk}/", {"name": "x"}).status_code, 403)
        self.assertEqual(send(restricted, "delete", f"{TARGETS}{plant.pk}/").status_code, 403)
        self.assertEqual(NetworkTarget.objects.get(pk=plant.pk).name, "plant-gw")

    def test_a_change_is_checked_as_a_creation_is(self):
        target = self.target()
        for body, field in (
            ({"name": ""}, "name"), ({"address": "a b"}, "address"), ({"timeoutSeconds": 99}, "timeoutSeconds"),
            ({"siteId": str(uuid.uuid4())}, "siteId"), ({"probeCount": 4}, "probeCount"),
        ):
            with self.subTest(body=body):
                response = send(self.client_, "patch", f"{TARGETS}{target.pk}/", body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(NetworkTarget.objects.get(pk=target.pk).name, "edge-gw")


class DeleteTests(TargetConfigTestCase):
    def test_a_target_goes_with_its_measurements_and_is_recorded(self):
        target = self.target()
        kept = self.target("kept")
        for ago in (10, 70, 130):
            self.measure(target, ago)
        self.measure(kept, 10)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "delete", f"{TARGETS}{target.pk}/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["deleted"], {"id": str(target.pk), "name": "edge-gw", "measurements": 3})
        self.assertFalse(NetworkTarget.objects.filter(pk=target.pk).exists())
        self.assertEqual(NetworkMeasurement.objects.filter(target_id=target.pk).count(), 0)
        self.assertEqual(NetworkMeasurement.objects.filter(target=kept).count(), 1)
        [deleted] = self.audit("target_deleted")
        self.assertEqual((deleted.target_id, deleted.target_name), (str(target.pk), "edge-gw"))
        self.assertEqual(deleted.changes["name"], {"before": "edge-gw", "after": None})
        self.assertEqual(deleted.changes["agentId"], {"before": str(self.agent.pk), "after": None})
        self.assertEqual(self.client_.get(f"{TARGETS}{target.pk}/").status_code, 404)
        self.assertEqual(logs.output, [f"INFO:apps.console:Network target deleted (target={target.pk}, measurements=3, user_id={self.editor.pk})"])

    def test_a_deletion_has_no_options(self):
        target = self.target()
        response = send(self.client_, "delete", f"{TARGETS}{target.pk}/", {"force": True})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"force": ["Unknown field: a deletion has no options."]}))
        self.assertTrue(NetworkTarget.objects.filter(pk=target.pk).exists())
        self.assertFalse(AuditEntry.objects.exists())

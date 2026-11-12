"""Changing and deleting monitored hosts from the console (``apps.console.server_config``): ``PATCH`` and
``DELETE /servers/<id>/`` by the editor gate and the admin's permissions, what a deletion takes with it and
what it leaves, and the audit trail. Adding hosts is ``test_enrollment_api``."""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.console.models import AuditEntry
from apps.console.tests.helpers import API, grant, make_admin, make_container, make_editor, make_server, make_user, send, signed_in_client
from apps.infrastructure.models import DockerContainer, Server, ServerTelemetry, ServerTelemetrySample
from apps.inventory.models import Customer, Device, Site
from apps.network.models import NetworkMeasurement, NetworkTarget

SERVERS = API + "servers/"
HEARTBEAT = "/api/v1/agent/heartbeat/"
DELETED_KEYS = {"id", "name", "agent", "telemetrySamples", "containers", "measurementsKept", "targetsUnassigned", "devicesUnassigned"}


def heartbeat(token: str) -> int:
    return Client().post(HEARTBEAT, data="{}", content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}").status_code


class ServerConfigTestCase(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.server = make_server("web-1", site=self.hq, now=self.now, operating_system="Debian 12", ip_address="10.0.0.5", description="front")
        self.editor = make_editor()
        self.client_ = signed_in_client(self.editor)

    def audit(self, action):
        return list(AuditEntry.objects.filter(action=action).order_by("pk"))

    def path(self, server=None):
        return f"{SERVERS}{(server or self.server).pk}/"


class PermissionTests(ServerConfigTestCase):
    def writes(self, client: Client):
        return (
            send(client, "patch", self.path(), {"description": "changed"}),
            send(client, "delete", self.path()),
        )

    def assert_refused(self, client, status):
        for response in self.writes(client):
            self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(Server.objects.get().description, "front")
        self.assertFalse(AuditEntry.objects.exists())

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)

    def test_a_reader_may_read_but_not_write(self):
        viewer = signed_in_client(make_user("viewer", all_customers=True))
        self.assertEqual(viewer.get(self.path()).status_code, 200)
        self.assert_refused(viewer, 403)
        capabilities = viewer.get(API + "session/").json()["capabilities"]
        self.assertEqual((capabilities["editServers"], capabilities["deleteServers"]), (False, False))

    def test_the_rule_permission_the_model_permissions_and_every_customer_are_all_needed(self):
        models = ("infrastructure.change_server", "infrastructure.delete_server")
        restricted = grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *models)
        self.assert_refused(signed_in_client(restricted), 403)
        self.assert_refused(signed_in_client(grant(make_user("rules-only", all_customers=True), "alerts.change_alertrule")), 403)
        self.assert_refused(signed_in_client(grant(make_user("models-only", all_customers=True), *models)), 403)
        # Adding hosts does not include changing or deleting them.
        enroller = grant(make_user("enroller", all_customers=True), "alerts.change_alertrule", "infrastructure.add_server", "agents.add_agent", "agents.change_agent")
        self.assert_refused(signed_in_client(enroller), 403)
        self.assertTrue(signed_in_client(enroller).get(API + "session/").json()["capabilities"]["manageServers"])

    def test_each_write_needs_the_permission_the_admin_asks_for_it(self):
        changer = signed_in_client(grant(make_user("changer", all_customers=True), "alerts.change_alertrule", "infrastructure.change_server"))
        self.assertEqual(tuple(r.status_code for r in self.writes(changer)), (200, 403))
        capabilities = changer.get(API + "session/").json()["capabilities"]
        self.assertEqual((capabilities["editServers"], capabilities["deleteServers"]), (True, False))
        deleter = signed_in_client(grant(make_user("deleter", all_customers=True), "alerts.change_alertrule", "infrastructure.delete_server"))
        self.assertEqual(tuple(r.status_code for r in self.writes(deleter)), (403, 200))
        capabilities = deleter.get(API + "session/").json()["capabilities"]
        self.assertEqual((capabilities["editServers"], capabilities["deleteServers"]), (False, True))
        capabilities = self.client_.get(API + "session/").json()["capabilities"]
        self.assertEqual((capabilities["editServers"], capabilities["deleteServers"]), (True, True))

    def test_the_refusal_names_the_permission_not_the_host(self):
        plain = signed_in_client(make_user("plain", all_customers=True))
        self.assertEqual(send(plain, "patch", self.path(), {"name": "x"}).json()["error"]["message"], "This account may not change monitored hosts.")
        self.assertEqual(send(plain, "delete", self.path()).json()["error"]["message"], "This account may not delete monitored hosts.")

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.editor, enforce_csrf=True)
        for response in self.writes(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertTrue(Server.objects.filter(pk=self.server.pk).exists())
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(send(client, "patch", self.path(), {"description": "changed"}, HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.put(self.path(), "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.post(self.path(), "{}", content_type="application/json").status_code, 405)


class ChangeTests(ServerConfigTestCase):
    def test_the_fields_sent_change_and_the_rest_stays(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "patch", self.path(), {
                "name": " web-01 ", "hostname": "web-01.example.net", "ipAddress": "2001:DB8::1", "siteId": str(self.plant.pk),
            })
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("no-store", response["Cache-Control"])
        server = Server.objects.get(pk=self.server.pk)
        self.assertEqual((server.name, server.hostname, server.ip_address, server.site_id), ("web-01", "web-01.example.net", "2001:db8::1", self.plant.pk))
        self.assertEqual((server.operating_system, server.description), ("Debian 12", "front"))
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "item", "agent", "containers"})
        self.assertEqual((body["item"]["server"]["name"], body["item"]["customerName"], body["item"]["siteName"]), ("web-01", "Globex", "Plant"))
        self.assertEqual(body, self.client_.get(self.path()).json() | {"generatedAt": body["generatedAt"]})
        [changed] = self.audit("server_changed")
        self.assertEqual((changed.actor_id, changed.target_type, changed.target_id, changed.target_name), (self.editor.pk, "server", str(server.pk), "web-01"))
        self.assertEqual(changed.changes, {
            "hostname": {"before": "web-1.internal", "after": "web-01.example.net"},
            "ipAddress": {"before": "10.0.0.5", "after": "2001:db8::1"},
            "name": {"before": "web-1", "after": "web-01"},
            "siteId": {"before": str(self.hq.pk), "after": str(self.plant.pk)},
        })
        self.assertEqual(logs.output, [f"INFO:apps.console:Server changed (server={server.pk}, site={self.plant.pk}, user_id={self.editor.pk})"])
        # Nothing to change: the detail as it is, and nothing recorded.
        self.assertEqual(send(self.client_, "patch", self.path(), {"name": "web-01", "description": "front"}).status_code, 200)
        self.assertEqual(send(self.client_, "patch", self.path(), {}).status_code, 200)
        self.assertEqual(len(self.audit("server_changed")), 1)

    def test_a_blank_hostname_takes_the_name_and_nothings_are_explicit(self):
        response = send(self.client_, "patch", self.path(), {"hostname": "  ", "ipAddress": None, "siteId": None, "operatingSystem": "", "description": ""})
        self.assertEqual(response.status_code, 200, response.content)
        server = Server.objects.get(pk=self.server.pk)
        self.assertEqual((server.hostname, server.ip_address, server.site_id, server.operating_system, server.description), ("web-1", None, None, "", ""))
        self.assertEqual(response.json()["item"].get("customerName"), None)
        [changed] = self.audit("server_changed")
        self.assertEqual(changed.changes["hostname"], {"before": "web-1.internal", "after": "web-1"})
        self.assertEqual(changed.changes["siteId"], {"before": str(self.hq.pk), "after": None})
        # Renamed with a blank hostname: the hostname follows the new name.
        self.assertEqual(send(self.client_, "patch", self.path(), {"name": "web-2", "hostname": ""}).json()["item"]["server"]["hostname"], "web-2")

    def test_moving_a_server_changes_who_sees_it(self):
        restricted = signed_in_client(make_user("acme-only", customers=[self.acme]))
        self.assertEqual(restricted.get(self.path()).status_code, 200)
        self.assertEqual(send(self.client_, "patch", self.path(), {"siteId": str(self.plant.pk)}).status_code, 200)
        self.assertEqual(restricted.get(self.path()).status_code, 404)

    def test_a_name_another_server_has_is_a_conflict(self):
        make_server("db-1", site=self.hq, now=self.now)
        response = send(self.client_, "patch", self.path(), {"name": "db-1"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "server_exists"))
        self.assertEqual(Server.objects.get(pk=self.server.pk).name, "web-1")
        self.assertFalse(AuditEntry.objects.exists())
        # Its own name is not a conflict.
        self.assertEqual(send(self.client_, "patch", self.path(), {"name": "web-1"}).status_code, 200)

    def test_a_change_is_checked_as_a_creation_is(self):
        for body, field, message in (
            ({"name": ""}, "name", "Required."),
            ({"name": "a" * 256}, "name", "At most 255 characters."),
            ({"hostname": "not a host"}, "hostname", "Expected a host name (letters, digits, hyphens and dots) or an IP address."),
            ({"ipAddress": "10.0.0.256"}, "ipAddress", "Expected an IPv4 or IPv6 address."),
            ({"siteId": str(uuid.uuid4())}, "siteId", "No such site."),
            ({"siteId": "not-an-id"}, "siteId", "Expected the id of a site."),
            ({"description": "x\x1b[0m"}, "description", "Control characters are not allowed."),
            ({"status": "online"}, "status", "Unknown field."),
            ({"agent": {"enabled": False}}, "agent", "Unknown field."),
        ):
            with self.subTest(body=body):
                response = send(self.client_, "patch", self.path(), body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["fields"][field], [message])
        self.assertEqual(Server.objects.get(pk=self.server.pk).name, "web-1")
        self.assertEqual(send(self.client_, "patch", self.path(), {"description": "d" * 16 * 1024}).status_code, 413)
        self.assertEqual(self.client_.patch(self.path(), "name=x", content_type="text/plain").status_code, 415)
        self.assertFalse(AuditEntry.objects.exists())

    def test_an_unknown_or_hidden_server_is_not_found_and_a_restricted_account_refused(self):
        self.assertEqual(send(self.client_, "patch", f"{SERVERS}{uuid.uuid4()}/", {"name": "x"}).status_code, 404)
        self.assertEqual(send(self.client_, "delete", f"{SERVERS}{uuid.uuid4()}/").status_code, 404)
        plant = make_server("plant-1", site=self.plant, now=self.now)
        restricted = signed_in_client(grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", "infrastructure.change_server", "infrastructure.delete_server"))
        self.assertEqual(restricted.get(self.path(plant)).status_code, 404)
        self.assertEqual(send(restricted, "patch", self.path(plant), {"name": "x"}).status_code, 403)
        self.assertEqual(send(restricted, "delete", self.path(plant)).status_code, 403)
        self.assertEqual(Server.objects.get(pk=plant.pk).name, "plant-1")


class DeleteTests(ServerConfigTestCase):
    def test_the_server_goes_with_its_agent_telemetry_and_containers_and_the_rest_is_kept(self):
        agent, token = create_agent(server=self.server, name="web-agent")
        for minutes in (1, 2, 3):
            ServerTelemetrySample.objects.create(
                server=self.server, sampled_at=self.now - timedelta(minutes=minutes), cpu_percent=1.0, memory_percent=2.0, disk_percent=3.0,
            )
        make_container(self.server, "nginx", now=self.now)
        make_container(self.server, "redis", now=self.now)
        target = NetworkTarget.objects.create(name="gw", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.hq, assigned_agent=agent)
        other_target = NetworkTarget.objects.create(name="other", hostname_or_ip="192.0.2.2", protocol="icmp", site=self.hq)
        device = Device.objects.create(name="sw", management_address="192.0.2.3", site=self.hq, assigned_agent=agent)
        measurement = NetworkMeasurement.objects.create(
            id=uuid.uuid4(), target=target, agent=agent, measured_at=self.now, received_at=self.now, success=True, latency_ms=1.0,
            packet_loss_percentage=0.0, probe_count=4, successful_probes=4,
        )
        kept = make_server("db-1", site=self.hq, now=self.now)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "delete", self.path())
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "deleted"})
        self.assertEqual(set(body["deleted"]), DELETED_KEYS)
        self.assertEqual(body["deleted"], {
            "id": str(self.server.pk), "name": "web-1", "agent": True, "telemetrySamples": 3, "containers": 2,
            "measurementsKept": 1, "targetsUnassigned": 1, "devicesUnassigned": 1,
        })
        # Gone: the server, its agent (whose token no longer works), its telemetry and its containers.
        self.assertFalse(Server.objects.filter(pk=self.server.pk).exists())
        self.assertFalse(Agent.objects.filter(pk=agent.pk).exists())
        self.assertEqual(heartbeat(token), 401)
        self.assertFalse(ServerTelemetry.objects.filter(server_id=self.server.pk).exists())
        self.assertFalse(ServerTelemetrySample.objects.filter(server_id=self.server.pk).exists())
        self.assertFalse(DockerContainer.objects.filter(server_id=self.server.pk).exists())
        # Kept: the measurements (without their agent), the targets and devices (without their agent), the other server.
        self.assertIsNone(NetworkMeasurement.objects.get(pk=measurement.pk).agent_id)
        self.assertIsNone(NetworkTarget.objects.get(pk=target.pk).assigned_agent_id)
        self.assertIsNone(NetworkTarget.objects.get(pk=other_target.pk).assigned_agent_id)
        self.assertIsNone(Device.objects.get(pk=device.pk).assigned_agent_id)
        self.assertTrue(Server.objects.filter(pk=kept.pk).exists())
        [deleted] = self.audit("server_deleted")
        self.assertEqual((deleted.actor_id, deleted.target_type, deleted.target_id, deleted.target_name), (self.editor.pk, "server", str(self.server.pk), "web-1"))
        self.assertEqual(deleted.changes["name"], {"before": "web-1", "after": None})
        self.assertEqual(deleted.changes["agentDeleted"], {"before": None, "after": True})
        self.assertNotIn(token, str(deleted.changes))
        self.assertNotIn(token, "\n".join(logs.output))
        self.assertEqual(logs.output, [f"INFO:apps.console:Server deleted (server={self.server.pk}, agent=True, samples=3, containers=2, user_id={self.editor.pk})"])
        self.assertEqual(self.client_.get(self.path()).status_code, 404)

    def test_a_server_without_an_agent_goes_too(self):
        response = send(self.client_, "delete", self.path())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["deleted"]["agent"], False)
        self.assertEqual(response.json()["deleted"]["telemetrySamples"], 0)
        self.assertFalse(Server.objects.filter(pk=self.server.pk).exists())

    def test_a_deletion_has_no_options(self):
        response = send(self.client_, "delete", self.path(), {"force": True})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"force": ["Unknown field: a deletion has no options."]}))
        self.assertTrue(Server.objects.filter(pk=self.server.pk).exists())
        self.assertFalse(AuditEntry.objects.exists())

    def test_an_administrator_may_do_all_of_it(self):
        client = signed_in_client(make_admin())
        self.assertEqual(send(client, "patch", self.path(), {"description": "by admin"}).status_code, 200)
        self.assertEqual(send(client, "delete", self.path()).status_code, 200)

"""Inventory devices and their SNMP configuration from the console (``apps.console.device_config``): the list and
the detail by the grants, adding, changing and deleting by the editor gate and the admin's permissions, the
credential profile that is written and never read back, the history that refuses a deletion, the audit trail."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.agents.services import create_agent
from apps.console.models import AuditEntry
from apps.console.tests.helpers import API, grant, make_admin, make_editor, make_server, make_user, send, signed_in_client
from apps.inventory.models import Customer, Device, Site
from apps.snmp.models import DevicePoll, DeviceSnmpState, Interface, InterfaceSample, SnmpConfig

DEVICES = API + "inventory/devices/"
DEVICE_PERMISSIONS = ("inventory.add_device", "inventory.change_device", "inventory.delete_device")
SNMP_PERMISSIONS = ("snmp.add_snmpconfig", "snmp.change_snmpconfig", "snmp.delete_snmpconfig")
ITEM_KEYS = {"id", "name", "type", "address", "enabled", "description", "siteId", "agentAssigned", "agent", "snmp", "hasHistory", "createdAt", "updatedAt"}
SNMP_KEYS = {"version", "port", "pollIntervalSeconds", "timeoutSeconds", "retries"}
PROFILE = "secret-profile-name"


class DeviceConfigTestCase(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.server = make_server("poller-host", site=self.hq, now=self.now)
        self.agent, self.token = create_agent(server=self.server, name="poller")
        self.editor = make_editor()
        self.client_ = signed_in_client(self.editor)

    def device(self, name="core-sw", *, site="hq", agent="default", configured=True, **fields):
        device = Device.objects.create(
            name=name, management_address="192.0.2.10", site={"hq": self.hq, "plant": self.plant, None: None}[site],
            assigned_agent=self.agent if agent == "default" else agent, **fields,
        )
        if configured:
            SnmpConfig.objects.create(device=device, credential_profile=PROFILE, poll_interval_seconds=300, timeout_seconds=5, retries=1)
        return device

    def poll(self, device, ago=10):
        return DevicePoll.objects.create(
            id=uuid.uuid4(), device=device, measured_at=self.now - timedelta(seconds=ago), received_at=self.now, reachable=True, response_ms=1.0,
        )

    def audit(self, action):
        return list(AuditEntry.objects.filter(action=action).order_by("pk"))

    def path(self, device):
        return f"{DEVICES}{device.pk}/"


class PermissionTests(DeviceConfigTestCase):
    def setUp(self):
        super().setUp()
        self.existing = self.device("existing")

    def writes(self, client: Client):
        return (
            send(client, "post", DEVICES, {"name": "new", "address": "192.0.2.20"}),
            send(client, "patch", self.path(self.existing), {"name": "renamed"}),
            send(client, "delete", self.path(self.existing)),
        )

    def assert_refused(self, client, status):
        for response in self.writes(client):
            self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(Device.objects.count(), 1)
        self.assertEqual(Device.objects.get().name, "existing")
        self.assertFalse(AuditEntry.objects.exists())

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)
        self.assertEqual(Client().get(DEVICES).status_code, 401)

    def test_a_reader_may_read_but_not_write(self):
        viewer = signed_in_client(make_user("viewer", all_customers=True))
        self.assertEqual(viewer.get(DEVICES).status_code, 200)
        self.assertEqual(viewer.get(self.path(self.existing)).status_code, 200)
        self.assert_refused(viewer, 403)
        self.assertFalse(viewer.get(API + "session/").json()["capabilities"]["manageDevices"])

    def test_the_rule_permission_the_model_permissions_and_every_customer_are_all_needed(self):
        restricted = grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *DEVICE_PERMISSIONS, *SNMP_PERMISSIONS)
        self.assert_refused(signed_in_client(restricted), 403)
        self.assert_refused(signed_in_client(grant(make_user("rules-only", all_customers=True), "alerts.change_alertrule")), 403)
        self.assert_refused(signed_in_client(grant(make_user("models-only", all_customers=True), *DEVICE_PERMISSIONS, *SNMP_PERMISSIONS)), 403)
        # The device permissions without the SNMP ones: a device carries its SNMP configuration, so neither is enough alone.
        self.assert_refused(signed_in_client(grant(make_user("devices-only", all_customers=True), "alerts.change_alertrule", *DEVICE_PERMISSIONS)), 403)
        self.assert_refused(signed_in_client(grant(make_user("snmp-only", all_customers=True), "alerts.change_alertrule", *SNMP_PERMISSIONS)), 403)

    def test_each_write_needs_the_permissions_the_admin_asks_for_it(self):
        for codenames, expected in (
            (("inventory.add_device", "snmp.add_snmpconfig"), (201, 403, 403)),
            (("inventory.change_device", *SNMP_PERMISSIONS), (403, 200, 403)),
            (("inventory.delete_device", "snmp.delete_snmpconfig"), (403, 403, 200)),
        ):
            with self.subTest(permissions=codenames):
                client = signed_in_client(grant(make_user(codenames[0], all_customers=True), "alerts.change_alertrule", *codenames))
                self.assertEqual(tuple(r.status_code for r in self.writes(client)), expected)
                self.assertFalse(client.get(API + "session/").json()["capabilities"]["manageDevices"])
                Device.objects.filter(name="new").delete()
                Device.objects.filter(pk=self.existing.pk).update(name="existing")
                if not Device.objects.filter(pk=self.existing.pk).exists():
                    self.existing = self.device("existing")
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["manageDevices"])
        self.assertTrue(signed_in_client(make_admin()).get(API + "session/").json()["capabilities"]["manageDevices"])

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.editor, enforce_csrf=True)
        for response in self.writes(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(send(client, "patch", self.path(self.existing), {"name": "renamed"}, HTTP_X_CSRFTOKEN=token).status_code, 200)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.put(DEVICES, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.put(self.path(self.existing), "{}", content_type="application/json").status_code, 405)


class ReadTests(DeviceConfigTestCase):
    def test_every_device_is_listed_with_its_snmp_settings_but_never_the_profile(self):
        polled = self.device("core-sw")
        self.poll(polled)
        self.device("plain-sw", configured=False, device_type="switch", description="no snmp")
        self.device("plant-fw", site="plant", device_type="firewall")
        self.device("free", site=None, agent=None, configured=False)
        with CaptureQueriesContext(connection) as queries:
            body = self.client_.get(DEVICES).json()
        self.assertEqual(set(body), {"generatedAt", "items", "page", "scopeTotal"})
        self.assertEqual([item["name"] for item in body["items"]], ["core-sw", "free", "plain-sw", "plant-fw"])
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (4, 4))
        core, free, plain, plant = body["items"]
        self.assertEqual(set(core), ITEM_KEYS | {"customerName", "siteName"})
        self.assertEqual(set(free), ITEM_KEYS)
        self.assertEqual(set(core["snmp"]), SNMP_KEYS)
        self.assertEqual(core["snmp"], {"version": "3", "port": 161, "pollIntervalSeconds": 300, "timeoutSeconds": 5, "retries": 1})
        self.assertEqual((core["hasHistory"], core["customerName"], core["siteName"], core["agent"]["name"], core["agentAssigned"]), (True, "Acme", "HQ", "poller", True))
        self.assertEqual((plain["snmp"], plain["hasHistory"], plain["type"], plain["description"]), (None, False, "switch", "no snmp"))
        self.assertEqual((free["siteId"], free.get("customerName"), free["agentAssigned"], free["agent"]), (None, None, False, None))
        self.assertEqual((plant["customerName"], plant["type"]), ("Globex", "firewall"))
        text = json.dumps(body)
        self.assertNotIn(PROFILE, text)
        self.assertNotIn("credential", text)
        self.assertNotIn(self.token, text)
        # The profile and the token's hash are never even read: the columns are named.
        for query in queries.captured_queries:
            self.assertNotIn("credential_profile", query["sql"])
            self.assertNotIn("token_hash", query["sql"])

    def test_the_detail_is_the_list_item(self):
        device = self.device()
        with CaptureQueriesContext(connection) as queries:
            response = self.client_.get(self.path(device))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(set(response.json()), {"generatedAt", "item"})
        self.assertEqual(response.json()["item"], self.client_.get(DEVICES).json()["items"][0])
        for query in queries.captured_queries:
            self.assertNotIn("credential_profile", query["sql"])

    def test_a_restricted_account_sees_its_sites_devices_only_and_the_rest_is_not_found(self):
        hq = self.device("hq-sw")
        plant = self.device("plant-sw", site="plant")
        free = self.device("free-sw", site=None, agent=None)
        client = signed_in_client(make_user("acme-only", customers=[self.acme]))
        body = client.get(DEVICES).json()
        self.assertEqual([item["name"] for item in body["items"]], ["hq-sw"])
        # The agent runs on an Acme server: shown. For a plant-only account it would not be.
        self.assertEqual(body["items"][0]["agent"]["serverName"], "poller-host")
        self.assertEqual(client.get(self.path(hq)).status_code, 200)
        for hidden in (plant, free):
            self.assertEqual(client.get(self.path(hidden)).status_code, 404)
        self.assertEqual(client.get(DEVICES, {"customer": str(self.globex.pk)}).status_code, 404)
        self.assertEqual(client.get(f"{DEVICES}{uuid.uuid4()}/").status_code, 404)
        plant_only = signed_in_client(make_user("plant-only", sites=[self.plant]))
        [item] = plant_only.get(DEVICES).json()["items"]
        self.assertEqual((item["name"], item["agentAssigned"], item["agent"]), ("plant-sw", True, None))

    def test_the_list_is_scoped_searched_filtered_sorted_and_paged(self):
        self.device("alpha", device_type="router")
        self.device("Bravo", configured=False, description="spare")
        self.device("charlie", site="plant", device_type="firewall")
        names = lambda **params: [item["name"] for item in self.client_.get(DEVICES, params).json()["items"]]  # noqa: E731
        self.assertEqual(names(), ["alpha", "Bravo", "charlie"])
        self.assertEqual(names(sort="name", dir="desc"), ["charlie", "Bravo", "alpha"])
        self.assertEqual(names(sort="type"), ["charlie", "Bravo", "alpha"])  # firewall, other, router
        self.assertEqual(names(customer=str(self.acme.pk)), ["alpha", "Bravo"])
        self.assertEqual(names(site=str(self.plant.pk)), ["charlie"])
        self.assertEqual(names(q="spare"), ["Bravo"])
        self.assertEqual(names(q="plant"), ["charlie"])  # the site's name
        self.assertEqual(names(snmp="none"), ["Bravo"])
        self.assertEqual(names(snmp="configured"), ["alpha", "charlie"])
        body = self.client_.get(DEVICES, {"snmp": "none"}).json()
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (1, 3))
        body = self.client_.get(DEVICES, {"pageSize": "2", "page": "2"}).json()
        self.assertEqual(([item["name"] for item in body["items"]], body["page"]["pages"]), (["charlie"], 2))
        for params in ({"snmp": "yes"}, {"sort": "size"}, {"dir": "up"}, {"page": "0"}, {"site": "x"}, {"x": "1"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(DEVICES, params).status_code, 400)
        self.assertEqual(self.client_.get(self.path(Device.objects.get(name="alpha")), {"page": "1"}).status_code, 400)


class CreateTests(DeviceConfigTestCase):
    def test_a_device_is_created_with_its_snmp_configuration_and_recorded_without_the_profile(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", DEVICES, {
                "name": "  core-sw ", "type": "switch", "address": "core.example.net", "enabled": True, "description": "first\nsecond",
                "siteId": str(self.hq.pk), "agentId": str(self.agent.pk),
                "snmp": {"version": "2c", "port": 1161, "credentialProfile": PROFILE, "pollIntervalSeconds": 120, "timeoutSeconds": 3, "retries": 2},
            })
        self.assertEqual(response.status_code, 201, response.content)
        device = Device.objects.get(name="core-sw")
        self.assertEqual(response["Location"], f"{DEVICES}{device.pk}/")
        self.assertIn("no-store", response["Cache-Control"])
        item = response.json()["item"]
        self.assertEqual(set(item), ITEM_KEYS | {"customerName", "siteName"})
        self.assertEqual((item["name"], item["type"], item["address"], item["description"], item["siteName"]), ("core-sw", "switch", "core.example.net", "first\nsecond", "HQ"))
        self.assertEqual(item["snmp"], {"version": "2c", "port": 1161, "pollIntervalSeconds": 120, "timeoutSeconds": 3, "retries": 2})
        self.assertEqual((item["agent"]["name"], item["hasHistory"]), ("poller", False))
        config = SnmpConfig.objects.get(device=device)
        self.assertEqual((config.credential_profile, config.version, config.port), (PROFILE, "2c", 1161))
        [created] = self.audit("device_created")
        self.assertEqual((created.actor_id, created.target_type, created.target_id, created.target_name), (self.editor.pk, "device", str(device.pk), "core-sw"))
        self.assertEqual(created.changes["snmp"], {"before": None, "after": True})
        self.assertEqual(created.changes["snmp.version"], {"before": None, "after": "2c"})
        self.assertEqual(created.changes["credentialProfileChanged"], {"before": None, "after": True})
        self.assertEqual(created.changes["agentId"], {"before": None, "after": str(self.agent.pk)})
        self.assertNotIn(PROFILE, json.dumps(created.changes))
        self.assertNotIn("credentialProfile\"", json.dumps(created.changes))
        self.assertNotIn(PROFILE, json.dumps(response.json()))
        self.assertNotIn(PROFILE, "\n".join(logs.output))
        self.assertEqual(logs.output, [f"INFO:apps.console:Device created (device={device.pk}, site={self.hq.pk}, agent={self.agent.pk}, snmp=True, user_id={self.editor.pk})"])
        self.assertEqual(response.json()["item"], self.client_.get(self.path(device)).json()["item"])

    def test_only_the_name_and_the_address_are_required(self):
        response = send(self.client_, "post", DEVICES, {"name": "sw", "address": "192.0.2.1"})
        self.assertEqual(response.status_code, 201, response.content)
        device = Device.objects.get(name="sw")
        self.assertEqual((device.device_type, device.enabled, device.description, device.site_id, device.assigned_agent_id), ("other", True, "", None, None))
        self.assertFalse(SnmpConfig.objects.filter(device=device).exists())
        item = response.json()["item"]
        self.assertEqual((item["snmp"], item["agentAssigned"], item["agent"], item["siteId"]), (None, False, None, None))
        self.assertNotIn("credentialProfileChanged", self.audit("device_created")[0].changes)
        # The SNMP defaults, with just a profile.
        response = send(self.client_, "post", DEVICES, {"name": "sw-2", "address": "192.0.2.2", "snmp": {"credentialProfile": "lab"}})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["item"]["snmp"], {"version": "3", "port": 161, "pollIntervalSeconds": 300, "timeoutSeconds": 5, "retries": 1})

    def test_a_name_is_taken_per_site_whatever_its_case(self):
        self.device("Core-SW")
        self.device("Free", site=None)
        response = send(self.client_, "post", DEVICES, {"name": "core-sw", "address": "192.0.2.1", "siteId": str(self.hq.pk)})
        self.assertEqual((response.status_code, response.json()["error"]["code"], response.json()["error"]["message"]), (409, "device_exists", "This site already has a device with this name."))
        response = send(self.client_, "post", DEVICES, {"name": "free", "address": "192.0.2.1"})
        self.assertEqual((response.status_code, response.json()["error"]["message"]), (409, "An unassigned device with this name already exists."))
        # The same name on another site is fine.
        self.assertEqual(send(self.client_, "post", DEVICES, {"name": "core-sw", "address": "192.0.2.1", "siteId": str(self.plant.pk)}).status_code, 201)
        self.assertEqual(Device.objects.count(), 3)

    def test_the_body_is_checked_field_by_field(self):
        base = {"name": "sw", "address": "192.0.2.1"}
        snmp = {"credentialProfile": "lab"}
        cases = [
            ({}, "name", "Required."),
            ({}, "address", "Required."),
            ({**base, "name": " "}, "name", "Required."),
            ({**base, "name": "a" * 256}, "name", "At most 255 characters."),
            ({**base, "name": "sw\x1b[0m"}, "name", "Control characters are not allowed."),
            ({**base, "address": ""}, "address", "Required."),
            ({**base, "address": "a b"}, "address", "The address must not contain whitespace."),
            ({**base, "address": "host;rm"}, "address", "The address contains forbidden characters."),
            ({**base, "address": "256.1.1.1"}, "address", "This looks like an IP address but is not a valid one."),
            ({**base, "address": "224.0.0.1"}, "address", "The address must be a unicast address (not unspecified or multicast)."),
            ({**base, "type": "modem"}, "type", "Expected one of firewall, other, router, switch."),
            ({**base, "enabled": 1}, "enabled", "Expected true or false."),
            ({**base, "description": "d" * 2001}, "description", "At most 2000 characters."),
            ({**base, "siteId": "x"}, "siteId", "Expected the id of a site."),
            ({**base, "siteId": str(uuid.uuid4())}, "siteId", "No such site."),
            ({**base, "agentId": str(uuid.uuid4())}, "agentId", "No such agent."),
            ({**base, "snmp": "v3"}, "snmp", "Expected an object, or null for a device that is not polled."),
            ({**base, "snmp": {}}, "snmp.credentialProfile", "Required."),
            ({**base, "snmp": {"credentialProfile": ""}}, "snmp.credentialProfile", "Required."),
            ({**base, "snmp": {"credentialProfile": "has space"}}, "snmp.credentialProfile", "Use letters, digits, '.', '_' and '-'."),
            ({**base, "snmp": {"credentialProfile": "-leading"}}, "snmp.credentialProfile", "Use letters, digits, '.', '_' and '-'."),
            ({**base, "snmp": {"credentialProfile": "p" * 65}}, "snmp.credentialProfile", "At most 64 characters."),
            ({**base, "snmp": {**snmp, "version": "1"}}, "snmp.version", "Expected one of 2c, 3."),
            ({**base, "snmp": {**snmp, "port": 0}}, "snmp.port", "Expected a whole number from 1 to 65535."),
            ({**base, "snmp": {**snmp, "pollIntervalSeconds": 29}}, "snmp.pollIntervalSeconds", "Expected a whole number from 30 to 86400."),
            ({**base, "snmp": {**snmp, "timeoutSeconds": 61}}, "snmp.timeoutSeconds", "Expected a whole number from 1 to 60."),
            ({**base, "snmp": {**snmp, "retries": 6}}, "snmp.retries", "Expected a whole number from 0 to 5."),
            ({**base, "snmp": {**snmp, "pollIntervalSeconds": 30, "timeoutSeconds": 10, "retries": 2}}, "snmp.nonField", "timeout × (retries + 1) must be shorter than the poll interval."),
            ({**base, "snmp": {**snmp, "community": "public"}}, "snmp.community", "Unknown field."),
            ({**base, "credentialProfile": "lab"}, "credentialProfile", "Unknown field."),
            ({**base, "id": str(uuid.uuid4())}, "id", "Unknown field."),
        ]
        for body, field, message in cases:
            with self.subTest(body=body):
                response = send(self.client_, "post", DEVICES, body)
                self.assertEqual(response.status_code, 400, response.content)
                error = response.json()["error"]
                self.assertEqual(error["code"], "validation_error")
                self.assertEqual(error["fields"][field], [message])
        self.assertFalse(Device.objects.exists())
        self.assertFalse(SnmpConfig.objects.exists())
        self.assertFalse(AuditEntry.objects.exists())
        self.assertEqual(send(self.client_, "post", DEVICES, {**base, "description": "d" * 16 * 1024}).status_code, 413)
        self.assertEqual(self.client_.post(DEVICES, "name=x", content_type="text/plain").status_code, 415)

    def test_an_administrator_may_do_all_of_it(self):
        client = signed_in_client(make_admin())
        response = send(client, "post", DEVICES, {"name": "sw", "address": "192.0.2.1", "snmp": {"credentialProfile": "lab"}})
        self.assertEqual(response.status_code, 201, response.content)
        device_id = response.json()["item"]["id"]
        self.assertEqual(send(client, "patch", f"{DEVICES}{device_id}/", {"enabled": False}).status_code, 200)
        self.assertEqual(send(client, "delete", f"{DEVICES}{device_id}/").status_code, 200)


class ChangeTests(DeviceConfigTestCase):
    def test_the_fields_sent_change_and_the_rest_stays(self):
        device = self.device(description="kept")
        response = send(self.client_, "patch", self.path(device), {"name": "edge-sw", "type": "router", "siteId": str(self.plant.pk), "agentId": None, "enabled": False})
        self.assertEqual(response.status_code, 200, response.content)
        device.refresh_from_db()
        self.assertEqual((device.name, device.device_type, device.site_id, device.assigned_agent_id, device.enabled, device.description), ("edge-sw", "router", self.plant.pk, None, False, "kept"))
        self.assertEqual(SnmpConfig.objects.get(device=device).credential_profile, PROFILE)  # untouched
        item = response.json()["item"]
        self.assertEqual((item["customerName"], item["agentAssigned"], item["snmp"]["version"]), ("Globex", False, "3"))
        [changed] = self.audit("device_changed")
        self.assertEqual(changed.changes, {
            "agentId": {"before": str(self.agent.pk), "after": None},
            "enabled": {"before": True, "after": False},
            "name": {"before": "core-sw", "after": "edge-sw"},
            "siteId": {"before": str(self.hq.pk), "after": str(self.plant.pk)},
            "type": {"before": "other", "after": "router"},
        })
        # Nothing to change: nothing recorded.
        self.assertEqual(send(self.client_, "patch", self.path(device), {"name": "edge-sw", "snmp": {"version": "3"}}).status_code, 200)
        self.assertEqual(send(self.client_, "patch", self.path(device), {}).status_code, 200)
        self.assertEqual(len(self.audit("device_changed")), 1)

    def test_the_snmp_configuration_is_changed_added_and_removed_and_the_profile_never_recorded(self):
        device = self.device()
        response = send(self.client_, "patch", self.path(device), {"snmp": {"port": 1161, "credentialProfile": "new-profile"}})
        self.assertEqual(response.status_code, 200, response.content)
        config = SnmpConfig.objects.get(device=device)
        self.assertEqual((config.port, config.credential_profile, config.version), (1161, "new-profile", "3"))
        self.assertEqual(response.json()["item"]["snmp"]["port"], 1161)
        [changed] = self.audit("device_changed")
        self.assertEqual(changed.changes, {"credentialProfileChanged": {"before": None, "after": True}, "snmp.port": {"before": 161, "after": 1161}})
        for secret in (PROFILE, "new-profile"):
            self.assertNotIn(secret, json.dumps(changed.changes))
            self.assertNotIn(secret, json.dumps(response.json()))
        # The same profile again is not a change of it.
        self.assertEqual(send(self.client_, "patch", self.path(device), {"snmp": {"credentialProfile": "new-profile"}}).status_code, 200)
        self.assertEqual(len(self.audit("device_changed")), 1)
        # Removed: the device is no longer polled.
        response = send(self.client_, "patch", self.path(device), {"snmp": None})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(SnmpConfig.objects.filter(device=device).exists())
        self.assertIsNone(response.json()["item"]["snmp"])
        removed = self.audit("device_changed")[1]
        self.assertEqual(removed.changes["snmp"], {"before": True, "after": False})
        self.assertEqual(removed.changes["snmp.port"], {"before": 1161, "after": None})
        self.assertNotIn("credentialProfileChanged", removed.changes)
        # Added again: the profile is required for it.
        response = send(self.client_, "patch", self.path(device), {"snmp": {"version": "2c"}})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"snmp.credentialProfile": ["Required."]}))
        response = send(self.client_, "patch", self.path(device), {"snmp": {"version": "2c", "credentialProfile": "lab"}})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["item"]["snmp"], {"version": "2c", "port": 161, "pollIntervalSeconds": 300, "timeoutSeconds": 5, "retries": 1})
        added = self.audit("device_changed")[2]
        self.assertEqual((added.changes["snmp"], added.changes["credentialProfileChanged"]), ({"before": False, "after": True}, {"before": None, "after": True}))
        self.assertNotIn("lab", json.dumps(added.changes))

    def test_a_change_is_checked_as_a_creation_is(self):
        device = self.device()
        taken = self.device("taken")
        for body, field in (
            ({"name": ""}, "name"), ({"address": "a b"}, "address"), ({"type": "modem"}, "type"),
            ({"snmp": {"retries": 9}}, "snmp.retries"), ({"snmp": {"timeoutSeconds": 60, "retries": 5}}, "snmp.nonField"),
            ({"snmp": {"credentialProfile": "bad profile"}}, "snmp.credentialProfile"), ({"polls": []}, "polls"),
        ):
            with self.subTest(body=body):
                response = send(self.client_, "patch", self.path(device), body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        response = send(self.client_, "patch", self.path(device), {"name": "TAKEN"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "device_exists"))
        device.refresh_from_db()
        self.assertEqual((device.name, SnmpConfig.objects.get(device=device).retries), ("core-sw", 1))
        self.assertEqual(Device.objects.get(pk=taken.pk).name, "taken")
        self.assertFalse(AuditEntry.objects.exists())

    def test_an_unknown_or_hidden_device_is_not_found_and_a_restricted_account_refused(self):
        self.assertEqual(send(self.client_, "patch", f"{DEVICES}{uuid.uuid4()}/", {"name": "x"}).status_code, 404)
        self.assertEqual(send(self.client_, "delete", f"{DEVICES}{uuid.uuid4()}/").status_code, 404)
        plant = self.device("plant-sw", site="plant")
        restricted = signed_in_client(grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule", *DEVICE_PERMISSIONS, *SNMP_PERMISSIONS))
        self.assertEqual(restricted.get(self.path(plant)).status_code, 404)
        self.assertEqual(send(restricted, "patch", self.path(plant), {"name": "x"}).status_code, 403)
        self.assertEqual(send(restricted, "delete", self.path(plant)).status_code, 403)
        self.assertEqual(Device.objects.get(pk=plant.pk).name, "plant-sw")


class DeleteTests(DeviceConfigTestCase):
    def test_a_device_without_history_goes_with_its_configuration_state_and_interfaces(self):
        device = self.device()
        DeviceSnmpState.objects.create(device=device, reachable=False)
        Interface.objects.create(device=device, if_index=1, name="Gi0/1", admin_status=1, oper_status=1)
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "delete", self.path(device))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["deleted"], {"id": str(device.pk), "name": "core-sw"})
        self.assertFalse(Device.objects.filter(pk=device.pk).exists())
        self.assertFalse(SnmpConfig.objects.filter(device_id=device.pk).exists())
        self.assertFalse(DeviceSnmpState.objects.filter(device_id=device.pk).exists())
        self.assertFalse(Interface.objects.filter(device_id=device.pk).exists())
        [deleted] = self.audit("device_deleted")
        self.assertEqual((deleted.target_id, deleted.target_name, deleted.changes["name"]), (str(device.pk), "core-sw", {"before": "core-sw", "after": None}))
        self.assertEqual(deleted.changes["snmp"], {"before": True, "after": None})
        self.assertNotIn(PROFILE, json.dumps(deleted.changes))
        self.assertNotIn(PROFILE, "\n".join(logs.output))
        self.assertEqual(self.client_.get(self.path(device)).status_code, 404)

    def test_a_device_with_history_is_refused_as_the_admin_refuses_it(self):
        polled = self.device("polled")
        self.poll(polled)
        sampled = self.device("sampled")
        interface = Interface.objects.create(device=sampled, if_index=1, name="Gi0/1", admin_status=1, oper_status=1)
        InterfaceSample.objects.create(
            interface=interface, measured_at=self.now, admin_status=1, oper_status=1, octets_bits=64, delta_state="first",
        )
        for device in (polled, sampled):
            with self.subTest(device=device.name):
                response = send(self.client_, "delete", self.path(device))
                self.assertEqual(response.status_code, 409, response.content)
                self.assertEqual(response.json()["error"]["code"], "device_has_history")
                self.assertIn("purge_snmp_data", response.json()["error"]["message"])
                self.assertTrue(Device.objects.filter(pk=device.pk).exists())
                self.assertTrue(self.client_.get(self.path(device)).json()["item"]["hasHistory"])
        self.assertFalse(AuditEntry.objects.exists())
        # Disabling it is the way, and still possible.
        self.assertEqual(send(self.client_, "patch", self.path(polled), {"enabled": False}).status_code, 200)

    def test_a_deletion_has_no_options(self):
        device = self.device()
        response = send(self.client_, "delete", self.path(device), {"force": True})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"force": ["Unknown field: a deletion has no options."]}))
        self.assertTrue(Device.objects.filter(pk=device.pk).exists())

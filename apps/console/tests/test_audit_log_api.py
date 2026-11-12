"""The audit trail (``apps.console.audit``, ``apps.console.audit_log``, ``purge_audit_entries``): who may read it,
what a write records and what it never records, the filters and the paging, the rows that are never changed
or deleted by the application, and the retention command."""

from __future__ import annotations

import json
from datetime import timedelta
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.agents.services import create_agent
from apps.console import audit
from apps.console.models import AuditEntry
from apps.console.tests.helpers import API, grant, make_admin, make_editor, make_server, make_user, send, signed_in_client
from apps.inventory.models import Customer, Site

AUDIT_LOG = API + "audit-log/"
ENTRY_KEYS = {"id", "at", "actor", "action", "actionLabel", "targetType", "targetTypeLabel", "targetId", "targetName", "changes"}
GOOD_PASSWORD = "a-long-and-unusual-passphrase-41"


class AuditTestCase(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.acme = Customer.objects.create(name="Acme")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)

    def entry(self, **over):
        values = {"action": "customer_created", "target_type": audit.CUSTOMER, "target_id": self.acme.pk, "target_name": "Acme", "changed": {"name": {"before": None, "after": "Acme"}}}
        return audit.record(self.admin, **{**values, **over})


class PermissionTests(AuditTestCase):
    def test_who_may_read_it(self):
        self.entry()
        self.assertEqual(Client().get(AUDIT_LOG).status_code, 401)
        self.assertEqual(self.client_.get(AUDIT_LOG).status_code, 200)
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["viewAuditLog"])
        # An editor configures monitoring but does not read the trail; the permission can be granted alone, with every customer.
        editor = make_editor()
        self.assertEqual(signed_in_client(editor).get(AUDIT_LOG).status_code, 403)
        self.assertFalse(signed_in_client(editor).get(API + "session/").json()["capabilities"]["viewAuditLog"])
        auditor = grant(make_user("auditor", all_customers=True), "console.view_auditentry")
        self.assertEqual(signed_in_client(auditor).get(AUDIT_LOG).status_code, 200)
        self.assertTrue(signed_in_client(auditor).get(API + "session/").json()["capabilities"]["viewAuditLog"])
        restricted = grant(make_user("restricted", customers=[self.acme]), "console.view_auditentry")
        response = signed_in_client(restricted).get(AUDIT_LOG)
        self.assertEqual((response.status_code, response.json()["error"]["message"]), (403, "This account may not see the audit log."))
        self.assertFalse(signed_in_client(restricted).get(API + "session/").json()["capabilities"]["viewAuditLog"])

    def test_it_is_read_only(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assertEqual(getattr(self.client_, method)(AUDIT_LOG, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.get(f"{AUDIT_LOG}1/").status_code, 404)


class ReadTests(AuditTestCase):
    def test_entries_are_newest_first_with_their_labels_and_the_filters_offered(self):
        first = self.entry()
        second = self.entry(action="customer_changed", changed={"notes": {"before": "", "after": "n"}})
        response = self.client_.get(AUDIT_LOG)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "items", "page", "scopeTotal", "actions", "targetTypes"})
        self.assertEqual([item["id"] for item in body["items"]], [second.pk, first.pk])
        item = body["items"][1]
        self.assertEqual(set(item), ENTRY_KEYS)
        self.assertEqual(item["actor"], {"id": self.admin.pk, "username": "admin"})
        self.assertEqual((item["action"], item["actionLabel"], item["targetType"], item["targetTypeLabel"]), ("customer_created", "Customer created", "customer", "Customer"))
        self.assertEqual((item["targetId"], item["targetName"], item["changes"]), (str(self.acme.pk), "Acme", {"name": {"before": None, "after": "Acme"}}))
        self.assertEqual(body["page"], {"number": 1, "size": 50, "total": 2, "pages": 1})
        self.assertEqual(body["scopeTotal"], 2)
        self.assertEqual(body["actions"][0], {"value": "customer_created", "label": "Customer created"})
        self.assertEqual({option["value"] for option in body["actions"]}, set(audit.ACTIONS))
        self.assertEqual({option["value"] for option in body["targetTypes"]}, set(audit.TARGET_TYPES))

    def test_the_filters_and_the_search(self):
        other = make_admin("other")
        site_entry = audit.record(other, action="site_created", target_type=audit.SITE, target_id=self.hq.pk, target_name="HQ", changed={})
        customer_entry = self.entry()
        deleted_entry = self.entry(action="customer_deleted", target_id="11111111-1111-1111-1111-111111111111", target_name="Gone")
        ids = lambda **params: [item["id"] for item in self.client_.get(AUDIT_LOG, params).json()["items"]]  # noqa: E731
        self.assertEqual(ids(actor=str(other.pk)), [site_entry.pk])
        self.assertEqual(ids(actor="999999"), [])
        self.assertEqual(ids(action="customer_created"), [customer_entry.pk])
        self.assertEqual(ids(targetType="site"), [site_entry.pk])
        self.assertEqual(ids(targetType="customer"), [deleted_entry.pk, customer_entry.pk])
        self.assertEqual(ids(targetType="customer", targetId=str(self.acme.pk)), [customer_entry.pk])
        self.assertEqual(ids(targetId="11111111-1111-1111-1111-111111111111"), [deleted_entry.pk])
        self.assertEqual(ids(q="gone"), [deleted_entry.pk])  # the object's name
        self.assertEqual(ids(q="other"), [site_entry.pk])  # the actor's name
        self.assertEqual(ids(q="1111"), [deleted_entry.pk])  # the object's id
        self.assertEqual(ids(q="admin gone"), [deleted_entry.pk])
        body = self.client_.get(AUDIT_LOG, {"action": "site_created"}).json()
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (1, 3))
        body = self.client_.get(AUDIT_LOG, {"pageSize": "2", "page": "2"}).json()
        self.assertEqual(([item["id"] for item in body["items"]], body["page"]["pages"]), ([site_entry.pk], 2))
        for params in ({"actor": "x"}, {"actor": "0"}, {"action": "login"}, {"targetType": "token"}, {"targetId": ""}, {"targetId": "i" * 65}, {"sort": "at"}, {"page": "0"}, {"q": "a\x00"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(AUDIT_LOG, params).status_code, 400)

    def test_the_account_is_kept_by_name_once_it_is_gone(self):
        other = make_admin("other")
        entry = audit.record(other, action="site_created", target_type=audit.SITE, target_id=self.hq.pk, target_name="HQ")
        get_user_model().objects.filter(pk=other.pk).delete()  # only the admin could; the console never deletes an account
        self.assertEqual(AuditEntry.objects.get(pk=entry.pk).actor_id, None)
        [item] = self.client_.get(AUDIT_LOG, {"targetType": "site"}).json()["items"]
        self.assertEqual(item["actor"], {"id": None, "username": "other"})


class RecordingTests(AuditTestCase):
    def test_every_write_of_an_administrator_is_recorded_and_no_secret_ever(self):
        # One of each kind of secret: a password, an agent token, an SNMP credential profile.
        created = send(self.client_, "post", API + "users/", {"username": "vera", "password": GOOD_PASSWORD, "role": "viewer"})
        self.assertEqual(created.status_code, 201, created.content)
        user_id = created.json()["item"]["id"]
        self.assertEqual(send(self.client_, "post", f"{API}users/{user_id}/password/", {"password": "another-unusual-passphrase-77"}).status_code, 200)
        server = send(self.client_, "post", API + "servers/", {"name": "web-1", "siteId": str(self.hq.pk)})
        self.assertEqual(server.status_code, 201, server.content)
        server_id = server.json()["item"]["server"]["id"]
        enrolled = send(self.client_, "post", f"{API}servers/{server_id}/agents/", {})
        self.assertEqual(enrolled.status_code, 201, enrolled.content)
        token, agent_id = enrolled.json()["token"], enrolled.json()["item"]["id"]
        rotated = send(self.client_, "post", f"{API}agents/{agent_id}/rotate-token/")
        self.assertEqual(rotated.status_code, 200, rotated.content)
        device = send(self.client_, "post", API + "inventory/devices/", {"name": "sw", "address": "192.0.2.1", "snmp": {"credentialProfile": "secret-profile"}})
        self.assertEqual(device.status_code, 201, device.content)
        self.assertEqual(send(self.client_, "post", API + "targets/", {"name": "gw", "address": "192.0.2.1", "protocol": "icmp"}).status_code, 201)
        self.assertEqual(send(self.client_, "post", API + "customers/", {"name": "Globex"}).status_code, 201)

        actions = list(AuditEntry.objects.order_by("pk").values_list("action", flat=True))
        self.assertEqual(actions, [
            "user_created", "user_password_reset", "server_created", "agent_created", "agent_token_rotated", "device_created",
            "target_created", "customer_created",
        ])
        body = self.client_.get(AUDIT_LOG).json()
        self.assertEqual(body["page"]["total"], 8)
        self.assertEqual({item["actor"]["id"] for item in body["items"]}, {self.admin.pk})
        text = json.dumps(body) + json.dumps(list(AuditEntry.objects.values()), default=str)
        for secret in (GOOD_PASSWORD, "another-unusual-passphrase-77", token, rotated.json()["token"], "secret-profile", get_user_model().objects.get(pk=user_id).password):
            self.assertNotIn(secret, text)
        self.assertNotIn("token", json.dumps([item["changes"] for item in body["items"]]))
        by_action = {item["action"]: item for item in body["items"]}
        self.assertEqual(by_action["user_password_reset"]["changes"], {})
        self.assertEqual(by_action["agent_token_rotated"]["changes"], {})
        self.assertEqual(by_action["device_created"]["changes"]["credentialProfileChanged"], {"before": None, "after": True})
        self.assertNotIn("snmp.credentialProfile", by_action["device_created"]["changes"])

    def test_an_entry_is_written_in_the_transaction_of_the_change(self):
        # A write that fails after the entry is recorded leaves neither: the conflict below is raised inside the transaction.
        self.assertEqual(send(self.client_, "post", API + "customers/", {"name": "Globex"}).status_code, 201)
        self.assertEqual(send(self.client_, "post", API + "customers/", {"name": "globex"}).status_code, 409)
        self.assertEqual(AuditEntry.objects.count(), 1)

    def test_unknown_actions_and_targets_are_refused_by_the_recorder(self):
        with self.assertRaises(ValueError):
            audit.record(self.admin, action="user_deleted", target_type=audit.USER, target_id=1, target_name="x")
        with self.assertRaises(ValueError):
            audit.record(self.admin, action="user_created", target_type="token", target_id=1, target_name="x")
        self.assertFalse(AuditEntry.objects.exists())

    def test_values_are_recorded_as_json_can_hold_them(self):
        self.assertEqual(audit.changes({"a": 1, "b": "x", "c": [1, "2"]}, {"a": 1, "b": "y", "d": self.acme.pk}), {
            "b": {"before": "x", "after": "y"},
            "c": {"before": [1, "2"], "after": None},
            "d": {"before": None, "after": str(self.acme.pk)},
        })
        entry = self.entry(target_id="x" * 100, target_name="n" * 300)
        self.assertEqual((len(entry.target_id), len(entry.target_name)), (64, 255))


class ImmutabilityTests(AuditTestCase):
    def test_an_entry_is_never_changed_or_deleted_by_the_application(self):
        entry = self.entry()
        entry.target_name = "changed"
        with self.assertRaisesMessage(ValueError, "never changed"):
            entry.save()
        with self.assertRaisesMessage(ValueError, "never deleted"):
            entry.delete()
        self.assertEqual(AuditEntry.objects.get(pk=entry.pk).target_name, "Acme")

    def test_deleting_the_object_or_the_account_keeps_the_entry(self):
        server = make_server("web-1", site=self.hq, now=self.now)
        agent, _ = create_agent(server=server, name="web-agent")
        entry = audit.record(self.admin, action="agent_created", target_type=audit.AGENT, target_id=agent.pk, target_name="web-agent")
        server.delete()
        self.assertEqual(AuditEntry.objects.get(pk=entry.pk).target_name, "web-agent")


@override_settings(SENTINEL_AUDIT_RETENTION_DAYS=90)
class PurgeTests(AuditTestCase):
    def run_purge(self, *args) -> str:
        out = StringIO()
        call_command("purge_audit_entries", *args, stdout=out)
        return out.getvalue()

    def aged(self, days: int) -> AuditEntry:
        entry = self.entry()
        AuditEntry.objects.filter(pk=entry.pk).update(at=self.now - timedelta(days=days))
        return entry

    def test_rows_older_than_the_retention_go_in_batches_and_the_rest_stays(self):
        old = [self.aged(91), self.aged(400)]
        kept = [self.aged(89), self.aged(0)]
        self.assertIn("Would delete 2 audit entr", self.run_purge("--dry-run"))
        self.assertEqual(AuditEntry.objects.count(), 4)
        message = self.run_purge("--batch-size", "1")
        self.assertIn("Deleted 2 audit entr", message)
        self.assertIn("in 2 batch(es)", message)
        self.assertEqual(set(AuditEntry.objects.values_list("pk", flat=True)), {entry.pk for entry in kept})
        self.assertFalse(AuditEntry.objects.filter(pk__in=[entry.pk for entry in old]).exists())

    def test_the_days_can_be_overridden_for_a_run(self):
        self.aged(10)
        self.aged(2)
        self.run_purge("--days", "5")
        self.assertEqual(AuditEntry.objects.count(), 1)

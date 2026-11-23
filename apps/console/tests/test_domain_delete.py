"""Deleting a monitored domain from the console (``DELETE /domains/<id>/``): administrators only, never during a
verification, recorded in both trails, its verifications with it and nothing else."""

from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from apps.alerts.models import ConfigurationEvent
from apps.console.models import AuditEntry
from apps.console.tests.helpers import API, make_admin, signed_in_client
from apps.console.tests.test_domains_api import DOMAINS, add, domain_admin, post
from apps.inventory.models import Customer
from apps.web.models import DomainVerification, MonitoredDomain

SESSION = API + "session/"


class DomainDeleteTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)
        self.domain_id = add(self.client_, self.acme, "café.example.com").json()["item"]["id"]
        self.path = f"{DOMAINS}{self.domain_id}/"

    def delete(self, client=None, path=None, body=None):
        client = client or self.client_
        if body is None:
            return client.delete(path or self.path)
        return client.delete(path or self.path, json.dumps(body), content_type="application/json")

    def test_an_administrator_deletes_it_and_it_is_recorded(self):
        response = self.delete()
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["deleted"], {
            "id": self.domain_id, "name": "xn--caf-dma.example.com", "displayName": "café.example.com",
            "customer": {"id": str(self.acme.pk), "name": "Acme"},
        })
        self.assertFalse(MonitoredDomain.objects.exists())
        entry = AuditEntry.objects.get(action="domain_deleted")
        self.assertEqual((entry.actor_id, entry.target_id, entry.target_name), (self.admin.pk, self.domain_id, "xn--caf-dma.example.com"))
        self.assertEqual(entry.changes["displayName"], {"before": "café.example.com", "after": None})
        event = ConfigurationEvent.objects.get(action="domain_deleted")
        self.assertEqual((event.actor, event.source, event.target_id), (self.admin, "console", self.domain_id))
        self.assertNotIn("token", json.dumps(entry.changes) + json.dumps(event.changes))
        # Gone: a second deletion, and a read, find nothing.
        self.assertEqual(self.delete().status_code, 404)
        self.assertEqual(self.client_.get(self.path).status_code, 404)
        # The customer it held back may now go.
        self.assertEqual(self.client_.delete(f"{API}customers/{self.acme.pk}/").status_code, 200)

    def test_its_verifications_go_with_it_and_adding_it_again_gives_a_new_record(self):
        before = self.client_.get(self.path).json()["item"]["record"]["value"]
        self.assertEqual(post(self.client_, f"{self.path}verify/").status_code, 202)
        # No verifier took it in time: it expires, and no longer holds the deletion back.
        DomainVerification.objects.update(created_at=timezone.now() - timedelta(minutes=11), expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.delete().status_code, 200)
        self.assertFalse(DomainVerification.objects.exists())
        again = add(self.client_, self.acme, "café.example.com").json()["item"]
        self.assertNotEqual(again["record"]["value"], before)

    def test_not_while_a_verification_waits_or_runs(self):
        self.assertEqual(post(self.client_, f"{self.path}verify/").status_code, 202)
        response = self.delete()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "verification_active"))
        self.assertTrue(response.json()["error"]["message"].endswith("."))
        self.assertTrue(MonitoredDomain.objects.exists())
        self.assertFalse(AuditEntry.objects.filter(action="domain_deleted").exists())
        # Over (here: expired untaken): it may go.
        DomainVerification.objects.update(created_at=timezone.now() - timedelta(minutes=11), expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.delete().status_code, 200)

    def test_a_running_verification_holds_it_back_too(self):
        from apps.console.domains import ACTIVE_VERIFICATIONS

        self.assertEqual(set(ACTIVE_VERIFICATIONS), {DomainVerification.Status.PENDING, DomainVerification.Status.RUNNING})

    def test_only_administrators_and_ids_tell_nothing(self):
        editor = domain_admin("editor")  # may see, add and verify domains: not delete them
        for client, status in ((signed_in_client(editor), 403), (Client(), 401)):
            with self.subTest(status=status):
                self.assertEqual(self.delete(client).status_code, status)
                self.assertEqual(self.delete(client, path=f"{DOMAINS}00000000-0000-0000-0000-000000000000/").status_code, status)
        self.assertTrue(MonitoredDomain.objects.exists())
        self.assertEqual(self.delete(path=f"{DOMAINS}00000000-0000-0000-0000-000000000000/").status_code, 404)
        self.assertEqual(self.delete(body={"force": True}).status_code, 400)
        self.assertEqual(self.client_.delete(self.path + "?x=1").status_code, 400)

    def test_the_session_says_who_may(self):
        self.assertTrue(self.client_.get(SESSION).json()["capabilities"]["deleteDomains"])
        editor = signed_in_client(domain_admin("editor"))
        capabilities = editor.get(SESSION).json()["capabilities"]
        self.assertEqual((capabilities["viewDomains"], capabilities["deleteDomains"]), (True, False))

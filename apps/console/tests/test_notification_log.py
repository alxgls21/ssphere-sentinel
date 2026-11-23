"""The email delivery log (``GET /notifications/``): administrators only, every incident email with why it was
or was not sent, never an address or what the SMTP server said."""

from __future__ import annotations

import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.alerts.models import Notification
from apps.alerts.tests.helpers import make_rule, open_incident
from apps.console.tests.helpers import API, make_admin, make_user, signed_in_client

LOG = API + "notifications/"
KEYS = {"id", "kind", "status", "failure", "recipient", "incident", "attempts", "createdAt", "lastAttemptAt",
        "nextAttemptAt", "sentAt"}


@override_settings(SENTINEL_NOTIFICATION_RETENTION_DAYS=45)
class NotificationLogTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)
        self.vera = make_user("vera", email="vera@example.com", all_customers=True)
        self.bob = make_user("bob", email="bob@example.com", all_customers=True)
        self.web_rule = make_rule("Web down", reason="offline")
        self.db_rule = make_rule("Database container", entity_kind="container", health="critical")
        self.web = open_incident(self.web_rule, label="web-01")
        self.db = open_incident(self.db_rule, label="postgres")

    def email(self, incident, user, status, *, age=60, kind="opened", failure="", **fields):
        created = self.now - timedelta(seconds=age)
        if status == "sent":
            fields["sent_at"] = created + timedelta(seconds=5)
        if status == "sending":
            fields.update(claim="00000000-0000-0000-0000-000000000001", lease_expires_at=self.now + timedelta(minutes=5))
        return Notification.objects.create(
            incident=incident, recipient=user, recipient_name=user.get_username(), kind=kind, status=status,
            created_at=created, next_attempt_at=created + timedelta(minutes=2), failure=failure, **fields,
        )

    def log(self, client=None, **params):
        response = (client or self.client_).get(LOG, params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def test_every_email_with_why_it_was_or_was_not_sent(self):
        sent = self.email(self.web, self.vera, "sent", age=300, attempts=1, last_attempt_at=self.now)
        retrying = self.email(self.web, self.bob, "pending", age=200, failure="connection", attempts=2,
                              last_attempt_at=self.now - timedelta(seconds=30))
        self.email(self.db, self.vera, "failed", age=100, failure="recipient_refused", attempts=1)
        self.email(self.db, self.bob, "cancelled", age=50, failure="not_visible")
        body = self.log()
        self.assertEqual(set(body), {"generatedAt", "items", "page", "counts", "scopeTotal", "retentionDays"})
        self.assertEqual((body["retentionDays"], body["scopeTotal"], body["page"]["total"]), (45, 4, 4))
        self.assertEqual(body["counts"], {"pending": 1, "sending": 0, "sent": 1, "failed": 1, "cancelled": 1})
        items = body["items"]
        self.assertEqual([item["status"] for item in items], ["cancelled", "failed", "pending", "sent"])  # newest first
        by_id = {item["id"]: item for item in items}
        item = by_id[sent.pk]
        self.assertEqual(set(item), KEYS)
        self.assertEqual(item["incident"], {"id": str(self.web.pk), "ruleName": "Web down", "entityKind": "server",
                                            "entityLabel": "web-01", "severity": "critical"})
        self.assertEqual((item["recipient"], item["failure"], item["nextAttemptAt"]), ({"id": self.vera.pk, "username": "vera"}, None, None))
        self.assertIsNotNone(item["sentAt"])
        item = by_id[retrying.pk]
        self.assertEqual(item["failure"], {"category": "connection", "label": "Could not connect to the SMTP server"})
        self.assertEqual((item["attempts"], item["sentAt"]), (2, None))
        self.assertIsNotNone(item["nextAttemptAt"])  # tried again then
        self.assertEqual(items[0]["failure"], {"category": "not_visible", "label": "The recipient may no longer see the incident"})
        # No address, ever.
        self.assertNotIn("@example.com", json.dumps(body))

    def test_filters_search_sort_and_counts(self):
        self.email(self.web, self.vera, "sent", age=400)
        self.email(self.web, self.vera, "sent", age=300, kind="recovered")
        self.email(self.db, self.bob, "failed", age=200, failure="rejected")
        self.email(self.db, self.vera, "pending", age=100)
        ids = lambda **params: [(item["recipient"]["username"], item["status"]) for item in self.log(**params)["items"]]  # noqa: E731
        self.assertEqual(ids(status="sent"), [("vera", "sent"), ("vera", "sent")])
        self.assertEqual(ids(kind="recovered"), [("vera", "sent")])
        self.assertEqual(ids(incident=str(self.db.pk)), [("vera", "pending"), ("bob", "failed")])
        self.assertEqual(ids(recipient=str(self.bob.pk)), [("bob", "failed")])
        self.assertEqual(ids(q="postgres"), [("vera", "pending"), ("bob", "failed")])  # the object's name
        self.assertEqual(ids(q="web down"), [("vera", "sent"), ("vera", "sent")])  # the rule's name, every word
        self.assertEqual(ids(q="bob"), [("bob", "failed")])
        self.assertEqual(ids(sort="created", dir="asc")[0], ("vera", "sent"))
        self.assertEqual(ids(sort="recipient"), [("bob", "failed"), ("vera", "pending"), ("vera", "sent"), ("vera", "sent")])
        body = self.log(status="sent", q="postgres")
        self.assertEqual((body["page"]["total"], body["counts"]["pending"], body["counts"]["failed"], body["scopeTotal"]), (0, 1, 1, 4))
        body = self.log(pageSize="2", page="2")
        self.assertEqual((len(body["items"]), body["page"]["pages"]), (2, 2))
        for params in ({"status": "bounced"}, {"kind": "test"}, {"incident": "x"}, {"recipient": "0"}, {"sort": "rule"},
                       {"limit": "5"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(LOG, params).status_code, 400)

    def test_a_recipient_whose_account_is_gone_keeps_the_name(self):
        gone = make_user("gone", email="gone@example.com")
        self.email(self.web, gone, "cancelled", failure="recipient_unavailable")
        get_user_model().objects.filter(pk=gone.pk).delete()
        (item,) = self.log()["items"]
        self.assertEqual(item["recipient"], {"id": None, "username": "gone"})

    def test_administrators_only(self):
        self.email(self.web, self.vera, "sent")
        auditor = make_user("auditor", all_customers=True)
        for client, status in ((signed_in_client(auditor), 403), (signed_in_client(self.vera), 403), (Client(), 401)):
            with self.subTest(status=status):
                self.assertEqual(client.get(LOG).status_code, status)
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["viewDeliveryLog"])
        self.assertFalse(signed_in_client(self.vera).get(API + "session/").json()["capabilities"]["viewDeliveryLog"])
        self.assertIn("no-store", self.client_.get(LOG)["Cache-Control"])

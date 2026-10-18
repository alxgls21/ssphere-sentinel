"""A console user's own email preferences, and test emails asked for in the console."""

import json
import threading
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.db import connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from apps.alerts.models import ConfigurationEvent, NotificationSubscription, NotifierHeartbeat, TestEmailRequest
from apps.console.tests.helpers import API, make_user, signed_in_client
from apps.inventory.models import Customer

ME = API + "settings/notifications/me/"
TEST_EMAIL = API + "settings/notifications/test-email/"
SMTP_PASSWORD = "Smtp-Secret-3b8e01d4"
SMTP_ON = override_settings(
    SENTINEL_SMTP_HOST="smtp.example.com",
    SENTINEL_EMAIL_FROM="sentinel@example.com",
    SENTINEL_SMTP_USER="smtp-login-name",
    SENTINEL_SMTP_PASSWORD=SMTP_PASSWORD,
)
SMTP_OFF = override_settings(SENTINEL_SMTP_HOST="", SENTINEL_SMTP_USER="", SENTINEL_SMTP_PASSWORD="")


def grant(user, *codenames: str):
    for codename in codenames:
        app, _, name = codename.partition(".")
        user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=name))
    return type(user).objects.get(pk=user.pk)


def put(client: Client, body, **extra):
    return client.put(ME, json.dumps(body), content_type="application/json", **extra)


ON = {"enabled": True, "minSeverity": "warning", "sendRecovery": True}


@SMTP_ON
class PreferencesTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        # A restricted user: their own preferences need nothing more than the console.
        self.user = make_user("alice", email="alice@example.com", customers=[self.acme])
        self.client_ = signed_in_client(self.user)

    def test_without_a_subscription_the_defaults_and_the_account(self):
        body = self.client_.get(ME).json()
        self.assertEqual(body["preferences"], {"enabled": False, "minSeverity": "critical", "sendRecovery": False, "updatedAt": None})
        self.assertEqual(body["account"], {"email": "alice@example.com"})
        self.assertEqual(body["email"], {"available": True, "deliverable": True})
        self.assertEqual(body["testEmail"], {"allowed": False, "latest": None})

    def test_a_user_sets_their_own_preferences_and_the_change_is_recorded(self):
        response = put(self.client_, ON)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            {key: value for key, value in response.json()["preferences"].items() if key != "updatedAt"},
            ON,
        )
        subscription = NotificationSubscription.objects.get(user=self.user)
        self.assertEqual((subscription.enabled, subscription.min_severity, subscription.send_recovery), (True, "warning", True))
        [event] = ConfigurationEvent.objects.all()
        self.assertEqual((event.action, event.source, event.actor, event.target_name), ("subscription_changed", "console", self.user, "alice"))
        self.assertEqual(event.changes["minSeverity"], {"before": None, "after": "warning"})
        put(self.client_, {**ON, "sendRecovery": False})
        latest = ConfigurationEvent.objects.order_by("-id").first()
        self.assertEqual(latest.changes, {"sendRecovery": {"before": True, "after": False}})
        put(self.client_, {**ON, "sendRecovery": False})  # the same again: nothing to record
        self.assertEqual(ConfigurationEvent.objects.count(), 2)

    def test_preferences_are_kept_with_emails_off(self):
        response = put(self.client_, {"enabled": False, "minSeverity": "warning", "sendRecovery": True})
        self.assertEqual(response.status_code, 200)
        preferences = response.json()["preferences"]
        self.assertEqual((preferences["enabled"], preferences["minSeverity"], preferences["sendRecovery"]), (False, "warning", True))
        self.assertIsNotNone(preferences["updatedAt"])
        self.assertEqual(self.client_.get(ME).json()["preferences"]["minSeverity"], "warning")
        self.assertEqual(ConfigurationEvent.objects.get().changes["enabled"], {"before": None, "after": False})

    def test_only_their_own(self):
        other = make_user("bob", email="bob@example.com", all_customers=True)
        NotificationSubscription.objects.create(user=other, min_severity="warning")
        self.assertEqual(self.client_.get(ME).json()["preferences"]["enabled"], False)
        response = put(self.client_, {**ON, "user": other.pk})
        self.assertEqual(response.json()["error"]["fields"], {"user": ["Unknown field."]})
        put(self.client_, {**ON, "enabled": False})
        self.assertEqual(NotificationSubscription.objects.get(user=other).enabled, True)
        self.assertEqual(Client().get(ME).status_code, 401)

    def test_no_arbitrary_address(self):
        response = put(self.client_, {**ON, "email": "attacker@example.net"})
        self.assertEqual((response.status_code, response.json()["error"]["fields"]), (400, {"email": ["Unknown field."]}))
        self.assertEqual(self.client_.get(ME).json()["account"]["email"], "alice@example.com")

    def test_invalid_preferences_are_said_field_by_field(self):
        response = put(self.client_, {"enabled": "yes", "minSeverity": "fatal"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.json()["error"]["fields"]), {"enabled", "minSeverity", "sendRecovery"})
        self.assertFalse(NotificationSubscription.objects.exists())

    def test_an_account_without_an_address(self):
        user = make_user("no-address", all_customers=True)
        client = signed_in_client(user)
        body = client.get(ME).json()
        self.assertEqual((body["account"]["email"], body["email"]["deliverable"]), (None, False))
        response = put(client, ON)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "no_email_address"))
        self.assertEqual(put(client, {**ON, "enabled": False}).status_code, 200)
        self.assertFalse(NotificationSubscription.objects.filter(user=user).exists())
        # A subscription made while it had an address can still be switched off.
        user.email = "was@example.com"
        user.save()
        put(signed_in_client(user), ON)
        type(user).objects.filter(pk=user.pk).update(email="")
        self.assertEqual(put(client, {**ON, "enabled": False}).status_code, 200)
        self.assertFalse(NotificationSubscription.objects.get(user=user).enabled)

    @SMTP_OFF
    def test_email_off_is_said(self):
        self.assertEqual(self.client_.get(ME).json()["email"], {"available": False, "deliverable": False})

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.user, enforce_csrf=True)
        self.assertEqual(put(client, ON).status_code, 403)
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(put(client, ON, HTTP_X_CSRFTOKEN=token).status_code, 200)


@SMTP_ON
class TestEmailRequestTests(TestCase):
    def setUp(self):
        self.user = grant(make_user("alice", email="alice@example.com"), "alerts.send_test_email")
        self.client_ = signed_in_client(self.user)

    def ask(self, **extra):
        return self.client_.post(TEST_EMAIL, **extra)

    def test_a_request_is_queued_for_the_notifier(self):
        response = self.ask()
        self.assertEqual(response.status_code, 202, response.content)
        body = response.json()
        row = TestEmailRequest.objects.get()
        self.assertEqual(body["item"]["id"], str(row.pk))
        self.assertEqual((body["item"]["status"], body["item"]["failure"], body["item"]["finishedAt"]), ("pending", None, None))
        self.assertEqual(body["notifier"], {"state": "never_started"})
        self.assertEqual(response["Location"], f"{TEST_EMAIL}{row.pk}/")
        self.assertEqual(row.expires_at - row.created_at, timedelta(minutes=10))
        self.assertEqual((row.requested_by, row.requested_by_name), (self.user, "alice"))
        [event] = ConfigurationEvent.objects.all()
        self.assertEqual((event.action, event.target_type, event.target_id), ("test_email_requested", "test_email", str(row.pk)))
        status = self.client_.get(response["Location"]).json()
        self.assertEqual(status["item"]["status"], "pending")

    def test_the_permission_is_needed(self):
        plain = make_user("plain", email="plain@example.com", all_customers=True)
        response = signed_in_client(plain).post(TEST_EMAIL)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "forbidden"))
        self.assertEqual(Client().post(TEST_EMAIL).status_code, 401)
        self.assertFalse(TestEmailRequest.objects.exists())

    def test_no_body_whatever_it_says_it_is(self):
        response = self.client_.post(TEST_EMAIL, b"", content_type="application/json", CONTENT_TYPE="application/json")
        self.assertEqual(response.status_code, 202, response.content)
        TestEmailRequest.objects.update(status="sent", finished_at=timezone.now(), created_at=timezone.now() - timedelta(minutes=2))
        response = self.client_.post(TEST_EMAIL, "to=attacker@example.net", content_type="application/x-www-form-urlencoded")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (415, "unsupported_media_type"))

    def test_never_to_another_address(self):
        response = self.client_.post(TEST_EMAIL, json.dumps({"to": "attacker@example.net"}), content_type="application/json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "validation_error"))
        self.assertIn("to", response.json()["error"]["fields"])
        self.assertEqual(self.client_.post(TEST_EMAIL, "{}", content_type="application/json").status_code, 202)

    @SMTP_OFF
    def test_email_off_is_a_clear_answer(self):
        response = self.ask()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "email_disabled"))

    def test_an_account_without_an_address(self):
        type(self.user).objects.filter(pk=self.user.pk).update(email="")
        response = self.ask()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "no_email_address"))

    def test_one_open_at_a_time_and_one_a_minute(self):
        self.assertEqual(self.ask().status_code, 202)
        response = self.ask()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "test_email_pending"))
        row = TestEmailRequest.objects.get()
        TestEmailRequest.objects.filter(pk=row.pk).update(status="sent", finished_at=timezone.now())
        response = self.ask()
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (429, "rate_limited"))
        self.assertTrue(1 <= int(response["Retry-After"]) <= 60)
        TestEmailRequest.objects.filter(pk=row.pk).update(created_at=row.created_at - timedelta(minutes=1))
        self.assertEqual(self.ask().status_code, 202)
        self.assertEqual(TestEmailRequest.objects.count(), 2)

    def test_a_request_no_notifier_took_expires_and_frees_the_slot(self):
        self.ask()
        row = TestEmailRequest.objects.get()
        past = timezone.now() - timedelta(minutes=11)
        TestEmailRequest.objects.filter(pk=row.pk).update(created_at=past, expires_at=past + timedelta(minutes=10))
        body = self.client_.get(f"{TEST_EMAIL}{row.pk}/").json()
        self.assertEqual((body["item"]["status"], body["item"]["failure"]["category"]), ("expired", "expired"))
        self.assertEqual(self.ask().status_code, 202)

    def test_a_request_held_by_a_notifier_that_died_expires_and_frees_the_slot(self):
        self.ask()
        row = TestEmailRequest.objects.get()
        TestEmailRequest.objects.filter(pk=row.pk).update(
            status="sending", claim="00000000-0000-0000-0000-000000000001",
            lease_expires_at=timezone.now() - timedelta(seconds=1), created_at=timezone.now() - timedelta(minutes=2),
        )
        body = self.client_.get(f"{TEST_EMAIL}{row.pk}/").json()
        self.assertEqual((body["item"]["status"], body["item"]["failure"]["category"]), ("expired", "expired"))
        self.assertEqual(self.ask().status_code, 202)

    def test_a_body_too_large_is_refused_before_it_is_read(self):
        response = self.client_.post(TEST_EMAIL, "{}" + " " * 9000, content_type="application/json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (413, "payload_too_large"))

    def test_another_users_request_is_not_found(self):
        self.ask()
        row = TestEmailRequest.objects.get()
        other = grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email")
        self.assertEqual(signed_in_client(other).get(f"{TEST_EMAIL}{row.pk}/").status_code, 404)
        self.assertEqual(self.client_.get(f"{TEST_EMAIL}00000000-0000-0000-0000-000000000000/").status_code, 404)

    def test_the_latest_request_shows_in_the_preferences(self):
        self.ask()
        body = self.client_.get(ME).json()["testEmail"]
        self.assertEqual((body["allowed"], body["latest"]["status"]), (True, "pending"))

    def test_the_notifier_state_comes_with_the_answer(self):
        NotifierHeartbeat.objects.create(started_at=timezone.now(), beat_at=timezone.now(), interval_seconds=15)
        self.assertEqual(self.ask().json()["notifier"], {"state": "running"})

    def test_nothing_secret_in_the_answers(self):
        texts = [self.ask().content.decode(), self.client_.get(ME).content.decode()]
        texts.append(self.client_.get(f"{TEST_EMAIL}{TestEmailRequest.objects.get().pk}/").content.decode())
        for text in texts:
            for secret in (SMTP_PASSWORD, "smtp-login-name"):
                self.assertNotIn(secret, text)

    def test_the_web_process_never_talks_to_the_smtp_server(self):
        with patch("apps.alerts.notifications.smtp_connection", side_effect=AssertionError("SMTP from web")):
            self.assertEqual(self.ask().status_code, 202)
            self.client_.get(ME)

    def test_requests_need_the_csrf_token(self):
        client = signed_in_client(self.user, enforce_csrf=True)
        self.assertEqual(client.post(TEST_EMAIL).status_code, 403)
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(client.post(TEST_EMAIL, HTTP_X_CSRFTOKEN=token).status_code, 202)


@SMTP_ON
class ConcurrentTestEmailRequestTests(TransactionTestCase):
    def test_two_requests_at_once_queue_one(self):
        user = grant(make_user("alice", email="alice@example.com"), "alerts.send_test_email")
        barrier = threading.Barrier(2)
        statuses = []

        def ask():
            try:
                client = signed_in_client(user)
                barrier.wait()
                statuses.append(client.post(TEST_EMAIL).status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=ask) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(statuses), [202, 409])
        self.assertEqual(TestEmailRequest.objects.count(), 1)

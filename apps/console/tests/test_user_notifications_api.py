"""An account's incident emails and sign-in lockouts, seen by an administrator: ``/users/<id>/notifications/``,
what the user list says of both and filters by, and the sign-in summary of ``/system/status/``."""

from __future__ import annotations

import json
from datetime import timedelta

from django.contrib.auth.models import Permission
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.alerts.models import ConfigurationEvent, NotificationSubscription
from apps.console import throttle
from apps.console.models import AuditEntry, LoginThrottle
from apps.console.tests.helpers import API, PINNED, grant, make_admin, make_editor, make_user, send, signed_in_client

USERS = API + "users/"
ME = API + "settings/notifications/me/"
SYSTEM = API + "system/status/"
ON = {"enabled": True, "minSeverity": "warning", "sendRecovery": True}
OFF = {"enabled": False, "minSeverity": "critical", "sendRecovery": False}
THROTTLE = override_settings(SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS=3, SENTINEL_CONSOLE_LOGIN_LOCKOUT_SECONDS=900)
SMTP_ON = override_settings(SENTINEL_SMTP_HOST="smtp.example.com", SENTINEL_EMAIL_FROM="sentinel@example.com")


def fail_sign_ins(user, times: int, now=None):
    now = now or timezone.now()
    for _ in range(times):
        throttle.begin_attempt(throttle.throttle_key(user.get_username(), user.pk), now, user_id=user.pk)


@PINNED
@THROTTLE
@SMTP_ON
class AccountNotificationTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)
        self.vera = make_user("vera", email="vera@example.com", first_name="Vera", last_name="Viewer")

    def path(self, user_or_id):
        return f"{USERS}{getattr(user_or_id, 'pk', user_or_id)}/notifications/"

    def put(self, user, body, client=None):
        return send(client or self.client_, "put", self.path(user), body)

    def test_only_administrators_and_an_unknown_account_is_not_found(self):
        editor = make_editor()
        for client, status in ((signed_in_client(editor), 403), (signed_in_client(self.vera), 403), (Client(), 401)):
            with self.subTest(status=status):
                self.assertEqual(client.get(self.path(self.vera)).status_code, status)
                self.assertEqual(self.put(self.vera, ON, client=client).status_code, status)
                self.assertEqual(client.get(self.path(999999)).status_code, status)  # nothing told about ids
        self.assertFalse(NotificationSubscription.objects.exists())
        self.assertEqual(self.client_.get(self.path(999999)).status_code, 404)
        self.assertEqual(self.put(999999, ON).status_code, 404)
        self.assertEqual(self.client_.get(self.path(self.vera), {"x": "1"}).status_code, 400)

    def test_an_administrator_reads_an_account_s_preferences_without_its_test_emails(self):
        body = self.client_.get(self.path(self.vera)).json()
        self.assertEqual(set(body), {"generatedAt", "preferences", "account", "email", "user", "receiving"})
        self.assertEqual(body["user"], {"id": self.vera.pk, "username": "vera", "displayName": "Vera Viewer", "active": True})
        self.assertEqual(body["preferences"], {**OFF, "updatedAt": None, "changedBy": None})
        self.assertEqual((body["account"], body["email"], body["receiving"]),
                         ({"email": "vera@example.com"}, {"available": True, "deliverable": True}, False))

    def test_an_administrator_turns_emails_on_and_it_is_recorded_and_shown_to_the_user(self):
        response = self.put(self.vera, ON)
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertTrue(body["receiving"])
        self.assertEqual({key: body["preferences"][key] for key in ON}, ON)
        self.assertEqual(body["preferences"]["changedBy"]["username"], "admin")
        self.assertFalse(body["preferences"]["changedBy"]["self"])
        subscription = NotificationSubscription.objects.get(user=self.vera)
        self.assertEqual((subscription.enabled, subscription.min_severity, subscription.send_recovery), (True, "warning", True))
        [event] = ConfigurationEvent.objects.all()
        self.assertEqual((event.actor, event.source, event.target_name), (self.admin, "console", "vera"))
        [entry] = AuditEntry.objects.filter(action="user_notifications_changed")
        self.assertEqual((entry.actor_id, entry.target_type, entry.target_id, entry.target_name), (self.admin.pk, "user", str(self.vera.pk), "vera"))
        self.assertEqual(entry.changes["minSeverity"], {"before": None, "after": "warning"})
        # The user sees who changed them, and changes them back themselves.
        vera = signed_in_client(self.vera)
        changed = vera.get(ME).json()["preferences"]["changedBy"]
        self.assertEqual((changed["username"], changed["self"], changed["source"]), ("admin", False, "console"))
        vera.put(ME, json.dumps(OFF), content_type="application/json")
        changed = vera.get(ME).json()["preferences"]["changedBy"]
        self.assertEqual((changed["username"], changed["self"]), ("vera", True))
        self.assertEqual(AuditEntry.objects.filter(action="user_notifications_changed").count(), 1)  # the user's own: not an administrator's
        # The same again records nothing.
        self.put(self.vera, OFF)
        self.assertEqual(ConfigurationEvent.objects.count(), 2)

    def test_emails_go_only_to_an_account_that_can_receive_them(self):
        no_address = make_user("noaddress")
        inactive = make_user("inactive", email="inactive@example.com", active=False)
        no_console = make_user("noconsole", email="noconsole@example.com", console=False)
        for user, code in ((no_address, "no_email_address"), (inactive, "account_inactive"), (no_console, "no_console_access")):
            with self.subTest(code=code):
                response = self.put(user, ON)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, code))
                # Switching off is accepted, and keeps nothing for an account that cannot receive emails.
                self.assertEqual(self.put(user, OFF).status_code, 200)
        self.assertFalse(NotificationSubscription.objects.exists())
        self.assertFalse(ConfigurationEvent.objects.exists())

    def test_switching_off_is_accepted_whatever_the_account_has_lost(self):
        self.assertEqual(self.put(self.vera, ON).status_code, 200)
        self.vera.user_permissions.remove(Permission.objects.get(codename="use_console"))
        self.vera.email = ""
        self.vera.save()
        response = self.put(self.vera, {**OFF, "minSeverity": "warning"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(NotificationSubscription.objects.get(user=self.vera).enabled)
        self.assertFalse(response.json()["receiving"])

    def test_only_the_preferences_and_never_an_address(self):
        for body in ({**ON, "email": "attacker@example.net"}, {**ON, "user": self.admin.pk}, {"enabled": True}, {**ON, "minSeverity": "info"}):
            with self.subTest(body=body):
                response = self.put(self.vera, body)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "validation_error"))
        self.assertFalse(NotificationSubscription.objects.exists())
        self.assertEqual(self.client_.get(self.path(self.vera)).json()["account"]["email"], "vera@example.com")

    def test_the_list_says_who_is_emailed_and_filters_by_it(self):
        self.put(self.vera, ON)
        quiet = make_user("quiet", email="quiet@example.com")
        self.put(quiet, OFF)
        gone = make_user("gone", email="gone@example.com")
        self.put(gone, ON)
        gone.is_active = False
        gone.save()
        by_name = {item["username"]: item["notifications"] for item in self.client_.get(USERS).json()["items"]}
        self.assertEqual(by_name["vera"], {"enabled": True, "minSeverity": "warning", "receiving": True})
        self.assertEqual(by_name["quiet"], {"enabled": False, "minSeverity": "critical", "receiving": False})
        self.assertEqual(by_name["gone"], {"enabled": True, "minSeverity": "warning", "receiving": False})
        self.assertEqual(by_name["admin"], {"enabled": False, "minSeverity": None, "receiving": False})
        names = lambda **params: [item["username"] for item in self.client_.get(USERS, params).json()["items"]]  # noqa: E731
        self.assertEqual(names(notifications="on"), ["gone", "vera"])
        self.assertEqual(names(notifications="off"), ["admin", "quiet"])
        self.assertEqual(names(notifications="on", active="active"), ["vera"])
        counts = self.client_.get(USERS, {"notifications": "off"}).json()["counts"]
        self.assertEqual(counts, {"active": 2, "inactive": 0, "locked": 0, "notified": 2})
        self.assertEqual(self.client_.get(USERS, {"notifications": "maybe"}).status_code, 400)


@PINNED
@THROTTLE
class LockoutTests(TestCase):
    def setUp(self):
        self.admin = make_admin()
        self.client_ = signed_in_client(self.admin)
        self.vera = make_user("vera")
        self.bob = make_user("bob", active=False)

    def item(self, user):
        return self.client_.get(f"{USERS}{user.pk}/").json()["item"]

    def test_failed_sign_ins_count_until_the_lockout_and_end_with_it(self):
        self.assertEqual((self.item(self.vera)["failedSignIns"], self.item(self.vera)["maxFailedSignIns"]), (0, 3))
        fail_sign_ins(self.vera, 2)
        item = self.item(self.vera)
        self.assertEqual((item["failedSignIns"], item["locked"]), (2, False))
        fail_sign_ins(self.vera, 2)
        item = self.item(self.vera)
        self.assertEqual((item["failedSignIns"], item["locked"]), (3, True))
        # The lockout over: nothing counts any more, as the next attempt starts again from none.
        LoginThrottle.objects.filter(user=self.vera).update(locked_until=timezone.now() - timedelta(seconds=1))
        self.assertEqual((self.item(self.vera)["failedSignIns"], self.item(self.vera)["locked"]), (0, False))
        # A window that is over, without a lockout, too.
        LoginThrottle.objects.all().delete()
        fail_sign_ins(self.vera, 1, now=timezone.now() - timedelta(seconds=901))
        self.assertEqual(self.item(self.vera)["failedSignIns"], 0)

    def test_the_list_filters_and_counts_the_locked_accounts(self):
        fail_sign_ins(self.vera, 4)
        fail_sign_ins(self.bob, 4)
        names = lambda **params: [item["username"] for item in self.client_.get(USERS, params).json()["items"]]  # noqa: E731
        self.assertEqual(names(locked="locked"), ["bob", "vera"])
        self.assertEqual(names(locked="locked", active="active"), ["vera"])
        body = self.client_.get(USERS, {"active": "active"}).json()
        self.assertEqual((body["page"]["total"], body["counts"]), (2, {"active": 2, "inactive": 1, "locked": 1, "notified": 0}))
        body = self.client_.get(USERS, {"locked": "locked"}).json()
        self.assertEqual((body["page"]["total"], body["counts"], body["scopeTotal"]), (2, {"active": 1, "inactive": 1, "locked": 2, "notified": 0}, 3))
        send(self.client_, "post", f"{USERS}{self.vera.pk}/unlock/")
        self.assertEqual(names(locked="locked"), ["bob"])
        for params in ({"locked": "yes"}, {"locked": "unlocked"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(USERS, params).status_code, 400)


@THROTTLE
class SignInStatusTests(TestCase):
    def test_the_system_status_counts_the_lockouts_and_names_nobody(self):
        operator = grant(make_user("operator", all_customers=True), "console.view_system_status")
        client = signed_in_client(operator)
        self.assertEqual(client.get(SYSTEM).json()["signIn"], {
            "lockedAccounts": 0, "lockedUnknownNameBuckets": 0, "unknownNameBuckets": 1024,
            "maxFailedAttempts": 3, "lockoutSeconds": 900,
        })
        vera = make_user("vera")
        fail_sign_ins(vera, 4)
        now = timezone.now()
        for _ in range(4):
            throttle.begin_attempt(throttle.throttle_key("no-such-name", None), now)
        throttle.begin_attempt("setup", now)  # the first-run setup's own key is neither
        body = client.get(SYSTEM).json()
        self.assertEqual((body["signIn"]["lockedAccounts"], body["signIn"]["lockedUnknownNameBuckets"]), (1, 1))
        text = json.dumps(body["signIn"])
        for name in ("vera", "no-such-name", "x:", "u:"):
            self.assertNotIn(name, text)

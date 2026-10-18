"""What the notifier does with the test emails asked for in the console, its heartbeat, the
configuration trail, and the version of an alert rule."""

from __future__ import annotations

import io
import smtplib
import threading
import time
from datetime import timedelta
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth.models import Permission
from django.core import mail
from django.core.management import call_command
from django.db import DatabaseError, OperationalError, connection
from django.http import Http404
from django.test import RequestFactory, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.alerts.management.commands.run_notifier import Notifier
from apps.alerts.models import (
    AlertRule,
    ConfigurationEvent,
    Notification,
    NotificationSubscription,
    NotifierHeartbeat,
    TestEmailRequest,
)
from apps.alerts.notifications import deliver_test_emails, enqueue
from apps.alerts.tests.helpers import make_rule, open_incident
from apps.alerts.tests.test_notifications import FakeSMTP, using, wire
from apps.console.tests.helpers import make_user

SMTP_PASSWORD = "Smtp-Secret-5d1f27c0"
SMTP_ON = override_settings(
    SENTINEL_SMTP_HOST="smtp.example.com",
    SENTINEL_SMTP_PORT=587,
    SENTINEL_SMTP_SECURITY="starttls",
    SENTINEL_EMAIL_FROM="Sentinel <sentinel@example.com>",
    SENTINEL_SMTP_USER="smtp-login-name",
    SENTINEL_SMTP_PASSWORD=SMTP_PASSWORD,
)
NOTIFIER = "apps.alerts.management.commands.run_notifier"


def grant(user, *codenames: str):
    for codename in codenames:
        app, _, name = codename.partition(".")
        user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=name))
    return type(user).objects.get(pk=user.pk)


def ask(user, *, at=None) -> TestEmailRequest:
    created = at or timezone.now()
    return TestEmailRequest.objects.create(
        requested_by=user, requested_by_name=user.get_username(), created_at=created, expires_at=created + timedelta(minutes=10)
    )


@SMTP_ON
class TestEmailDeliveryTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.user = grant(make_user("alice", email="alice@example.com"), "alerts.send_test_email")

    def test_it_is_sent_once_to_the_address_the_account_has_then(self):
        row = ask(self.user)
        type(self.user).objects.filter(pk=self.user.pk).update(email="alice.new@example.com")
        report = deliver_test_emails(self.now)
        self.assertEqual((report.claimed, report.sent), (1, 1))
        [message] = mail.outbox
        self.assertEqual((message.to, message.subject), (["alice.new@example.com"], "[Sentinel] Test email"))
        self.assertIn("smtp.example.com:587 (starttls)", message.body)
        wire(message)  # what the SMTP backend would send
        row.refresh_from_db()
        self.assertEqual((row.status, row.failure, row.claim, row.lease_expires_at), ("sent", "", None, None))
        self.assertIsNotNone(row.finished_at)
        self.assertEqual(deliver_test_emails(self.now).claimed, 0)
        self.assertEqual(len(mail.outbox), 1)

    def test_what_changed_since_the_request_is_checked_before_sending(self):
        User = type(self.user)
        cases = {
            "permission removed": (lambda user: user.user_permissions.remove(Permission.objects.get(codename="send_test_email")),
                                   "not_permitted"),
            "console access removed": (lambda user: user.user_permissions.remove(Permission.objects.get(codename="use_console")),
                                       "recipient_unavailable"),
            "account disabled": (lambda user: User.objects.filter(pk=user.pk).update(is_active=False), "recipient_unavailable"),
            "address removed": (lambda user: User.objects.filter(pk=user.pk).update(email=""), "recipient_unavailable"),
            "account deleted": (lambda user: user.delete(), "recipient_unavailable"),
        }
        for index, (name, (change, failure)) in enumerate(cases.items()):
            with self.subTest(name):
                user = grant(make_user(f"user-{index}", email=f"user{index}@example.com"), "alerts.send_test_email")
                row = ask(user)
                change(user)
                report = deliver_test_emails(self.now)
                row.refresh_from_db()
                self.assertEqual((report.cancelled, row.status, row.failure, mail.outbox), (1, "cancelled", failure, []))

    def test_a_failure_is_the_answer_never_tried_again(self):
        row = ask(self.user)
        error = smtplib.SMTPAuthenticationError(535, f"5.7.8 {SMTP_PASSWORD} rejected for alice@example.com".encode())
        with using(FakeSMTP(errors=[error])), self.assertLogs("apps.alerts.notifier", "WARNING") as logs:
            report = deliver_test_emails(self.now)
        row.refresh_from_db()
        self.assertEqual((report.failed, row.status, row.failure), (1, "failed", "authentication"))
        self.assertEqual(logs.output, [f"WARNING:apps.alerts.notifier:test email for user {self.user.pk} not sent: authentication"])
        with using(FakeSMTP()) as fake:
            self.assertEqual(deliver_test_emails(self.now + timedelta(minutes=2)).claimed, 0)
        self.assertEqual(fake.return_value.calls, 0)

    def test_an_unreachable_server_fails_every_request_of_the_run(self):
        other = grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email")
        ask(self.user)
        ask(other)
        fake = FakeSMTP(open_error=ConnectionRefusedError())
        with using(fake), self.assertLogs("apps.alerts.notifier", "WARNING"):
            report = deliver_test_emails(self.now)
        self.assertEqual((report.failed, fake.opened, fake.calls), (2, 1, 0))
        self.assertEqual(set(TestEmailRequest.objects.values_list("failure", flat=True)), {"connection"})

    def test_requests_no_notifier_took_in_time_expire(self):
        late = ask(self.user, at=self.now - timedelta(minutes=11))
        bob = grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email")
        held = ask(bob, at=self.now - timedelta(minutes=3))
        TestEmailRequest.objects.filter(pk=held.pk).update(
            status="sending", claim="00000000-0000-0000-0000-000000000001", lease_expires_at=self.now - timedelta(seconds=1)
        )
        report = deliver_test_emails(self.now)
        self.assertEqual((report.claimed, mail.outbox), (0, []))
        for row in (late, held):
            row.refresh_from_db()
            self.assertEqual((row.status, row.failure, row.claim), ("expired", "expired", None))

    def test_a_stop_hands_the_rest_back(self):
        other = grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email")
        ask(self.user)
        ask(other)
        report = deliver_test_emails(self.now, should_stop=lambda: len(mail.outbox) >= 1)
        self.assertEqual((report.sent, report.released), (1, 1))
        self.assertEqual(sorted(TestEmailRequest.objects.values_list("status", flat=True)), ["pending", "sent"])

    def test_the_notifier_sends_them_in_its_cycle_and_records_its_heartbeat(self):
        ask(self.user)
        out = io.StringIO()
        call_command("run_notifier", "--once", stdout=out)
        self.assertIn("1 test email(s) sent", out.getvalue())
        self.assertEqual(TestEmailRequest.objects.get().status, "sent")
        beat = NotifierHeartbeat.objects.get()
        self.assertEqual((beat.interval_seconds, beat.server_configured, beat.authentication_configured), (15, True, True))
        self.assertIsNotNone(beat.beat_at)
        self.assertIsNotNone(beat.last_cycle_ms)

    def test_a_failed_cycle_is_recorded_by_its_kind_only(self):
        notifier = Notifier(interval=20)
        with patch(f"{NOTIFIER}.deliver", side_effect=OperationalError(f"password {SMTP_PASSWORD}")), self.assertLogs(
            "apps.alerts.notifier", "ERROR"
        ):
            self.assertEqual(notifier.cycle(), "failed")
        beat = NotifierHeartbeat.objects.get()
        self.assertEqual(
            (beat.last_error_category, beat.last_error_type, beat.interval_seconds, beat.beat_at),
            ("database", "OperationalError", 20, None),
        )
        self.assertNotIn(SMTP_PASSWORD, str(NotifierHeartbeat.objects.values().get()))

    def test_a_cycle_that_cannot_reach_the_smtp_server_is_a_failed_one(self):
        ask(self.user)
        notifier = Notifier(interval=15)
        with using(FakeSMTP(open_error=smtplib.SMTPAuthenticationError(535, b"5.7.8 no"))), self.assertLogs(
            "apps.alerts.notifier", "WARNING"
        ):
            self.assertEqual(notifier.cycle(), "done")
        beat = NotifierHeartbeat.objects.get()
        self.assertEqual((beat.server_error_category, beat.server_reached_at, beat.last_error_at), ("authentication", None, None))
        self.assertIsNotNone(beat.beat_at)  # the notifier itself completed its cycle
        with using(FakeSMTP()):
            ask(grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email"))
            notifier.cycle()
        beat.refresh_from_db()
        self.assertGreater(beat.server_reached_at, beat.server_error_at)

    def test_a_failure_then_a_reach_in_the_same_cycle_clears_it(self):
        ask(self.user)
        NotificationSubscription.objects.create(user=make_user("ops", email="ops@example.com", all_customers=True))
        enqueue(open_incident(make_rule(reason="offline")), "opened", at=timezone.now())
        notifier = Notifier(interval=15)
        refusing, working = FakeSMTP(open_error=ConnectionRefusedError()), FakeSMTP()
        with patch("apps.alerts.notifications.smtp_connection", side_effect=[refusing, working]), self.assertLogs(
            "apps.alerts.notifier", "WARNING"
        ):
            notifier.cycle()
        self.assertEqual((TestEmailRequest.objects.get().status, Notification.objects.get().status), ("failed", "sent"))
        beat = NotifierHeartbeat.objects.get()
        self.assertGreater(beat.server_reached_at, beat.server_error_at)

    def test_a_failure_of_the_notifier_does_not_hide_one_of_the_server(self):
        ask(self.user)
        notifier = Notifier(interval=15)
        with using(FakeSMTP(open_error=ConnectionRefusedError())), patch(
            f"{NOTIFIER}.deliver", side_effect=OperationalError("lost")
        ), self.assertLogs("apps.alerts.notifier", "WARNING"):
            self.assertEqual(notifier.cycle(), "failed")
        beat = NotifierHeartbeat.objects.get()
        self.assertEqual((beat.last_error_category, beat.server_error_category), ("database", "connection"))

    def test_a_failure_of_test_emails_between_incident_emails_does_not_stop_them(self):
        for name in ("ops", "second"):
            NotificationSubscription.objects.create(user=make_user(name, email=f"{name}@example.com", all_customers=True))
        enqueue(open_incident(make_rule(reason="offline")), "opened", at=timezone.now())
        notifier = Notifier(interval=15)
        calls = []

        def deliver_tests(*args, **kwargs):
            calls.append(1)
            if len(calls) > 1:
                raise OperationalError("deadlock detected")
            return deliver_test_emails(*args, **kwargs)

        with patch(f"{NOTIFIER}.deliver_test_emails", side_effect=deliver_tests), patch(
            f"{NOTIFIER}.TEST_EMAIL_POLL", 0
        ), self.assertLogs("apps.alerts.notifier", "ERROR"):
            self.assertEqual(notifier.cycle(), "done")
        self.assertEqual(Notification.objects.filter(status="sent").count(), 2)

    def test_a_failure_of_the_server_before_any_email_is_a_connection_failure(self):
        ask(self.user)
        notifier = Notifier(interval=15)
        with using(FakeSMTP(open_error=smtplib.SMTPResponseException(454, b"4.7.0 TLS not available"))), self.assertLogs(
            "apps.alerts.notifier", "WARNING"
        ):
            notifier.cycle()
        self.assertEqual(TestEmailRequest.objects.get().failure, "connection")
        self.assertEqual(NotifierHeartbeat.objects.get().server_error_category, "connection")

    def test_a_cycle_with_nothing_to_send_does_not_clear_an_smtp_failure(self):
        ask(self.user)
        notifier = Notifier(interval=15)
        with using(FakeSMTP(open_error=ConnectionRefusedError())), self.assertLogs("apps.alerts.notifier", "WARNING"):
            notifier.cycle()
        notifier.cycle()  # nothing due
        beat = NotifierHeartbeat.objects.get()
        self.assertIsNone(beat.server_reached_at)
        self.assertGreater(beat.beat_at, beat.server_error_at)
        ask(grant(make_user("bob", email="bob@example.com"), "alerts.send_test_email"))
        notifier.cycle()  # reaches the server
        beat.refresh_from_db()
        self.assertGreater(beat.server_reached_at, beat.server_error_at)

    def test_a_long_run_shows_signs_of_life_between_emails(self):
        for index in range(3):
            ask(grant(make_user(f"user-{index}", email=f"user{index}@example.com"), "alerts.send_test_email"))
        notifier = Notifier(interval=15)
        seen = []

        def each(messages):
            seen.append(NotifierHeartbeat.objects.values_list("active_at", flat=True).first())

        with using(FakeSMTP(on_send=each)), patch(f"{NOTIFIER}.ACTIVITY_EVERY", 0):
            notifier.cycle()
        self.assertEqual(len(seen), 3)
        self.assertLess(seen[0], seen[1])
        self.assertLess(seen[1], seen[2])
        self.assertIsNotNone(NotifierHeartbeat.objects.get().beat_at)

    def test_an_idle_notifier_waits_its_interval(self):
        notifier = Notifier(interval=40, clock=iter([0, 0, 15, 30, 45]).__next__)
        waits = []
        with patch.object(notifier.stop, "wait", side_effect=lambda seconds: waits.append(seconds) or False):
            notifier.wait()
        self.assertEqual(waits, [15, 15, 10])  # the whole interval, a look for test emails every 15 s

    def test_the_lease_is_taken_again_just_before_sending(self):
        row = ask(self.user)
        leases = []

        def check(messages):
            leases.append(TestEmailRequest.objects.get(pk=row.pk).lease_expires_at)

        with using(FakeSMTP(on_send=check)):
            deliver_test_emails(self.now - timedelta(minutes=14))  # claimed a while ago
        self.assertGreater(leases[0], timezone.now() + timedelta(minutes=14))

    def test_test_emails_asked_for_during_a_long_run_are_sent_in_it(self):
        for name in ("ops", "second"):
            NotificationSubscription.objects.create(user=make_user(name, email=f"{name}@example.com", all_customers=True))

        def asked_meanwhile(messages):
            if not TestEmailRequest.objects.exists():
                ask(self.user)

        enqueue(open_incident(make_rule(reason="offline")), "opened", at=timezone.now())
        notifier = Notifier(interval=15)
        with using(FakeSMTP(on_send=asked_meanwhile)), patch(f"{NOTIFIER}.TEST_EMAIL_POLL", 0):
            notifier.cycle()
        self.assertEqual(Notification.objects.filter(status="sent").count(), 2)
        self.assertEqual(TestEmailRequest.objects.get().status, "sent")
        self.assertEqual(notifier.test_report.sent, 1)

    def test_a_test_email_cuts_the_wait_short(self):
        notifier = Notifier(interval=3600)
        ask(self.user)
        began = time.monotonic()
        with patch(f"{NOTIFIER}.TEST_EMAIL_POLL", 0.01):
            notifier.wait()
        self.assertLess(time.monotonic() - began, 5)

    @override_settings(SENTINEL_SMTP_USER="", SENTINEL_SMTP_PASSWORD="")
    def test_the_heartbeat_says_whether_it_logs_in(self):
        call_command("run_notifier", "--once", stdout=io.StringIO())
        self.assertFalse(NotifierHeartbeat.objects.get().authentication_configured)


@SMTP_ON
class ConcurrentTestEmailDeliveryTests(TransactionTestCase):
    def test_two_notifiers_send_each_test_email_once(self):
        for index in range(6):
            ask(grant(make_user(f"user-{index}", email=f"user{index}@example.com"), "alerts.send_test_email"))
        barrier = threading.Barrier(2)
        sent = []
        errors = []

        def notifier():
            try:
                barrier.wait()
                while (report := deliver_test_emails(timezone.now(), limit=2)).claimed:
                    sent.append(report.sent)
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=notifier) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual((sum(sent), len(mail.outbox)), (6, 6))
        self.assertEqual(sorted(message.to[0] for message in mail.outbox), sorted(f"user{index}@example.com" for index in range(6)))


class RuleVersionTests(TestCase):
    def test_every_save_is_a_new_version_in_the_database(self):
        rule = make_rule("Versioned", reason="offline")
        self.assertEqual(rule.version, 1)
        rule.description = "one"
        rule.save()
        rule.enabled = False
        rule.save(update_fields=["enabled"])
        self.assertEqual(rule.version, 3)
        stale = AlertRule.objects.get(pk=rule.pk)
        rule.save()
        stale.save()  # an older copy saved again still makes a new version
        self.assertEqual(AlertRule.objects.get(pk=rule.pk).version, 5)


class ConfigurationTrailTests(TestCase):
    def setUp(self):
        self.root = make_user("root", superuser=True)
        self.client.force_login(self.root)

    def test_an_event_is_never_changed_or_deleted(self):
        event = ConfigurationEvent.objects.create(
            at=timezone.now(), actor=self.root, actor_name="root", source="admin", action="rule_created",
            target_type="alert_rule", target_id="x", target_name="x",
        )
        event.target_name = "y"
        with self.assertRaises(ValueError):
            event.save()
        with self.assertRaises(ValueError):
            event.delete()
        self.assertEqual(ConfigurationEvent.objects.get().target_name, "x")

    def test_changes_made_in_the_admin_are_recorded(self):
        add = self.client.post(reverse("admin:alerts_alertrule_add"), {
            "name": "Admin rule", "description": "", "enabled": "on", "entity_kind": "server", "health": "critical",
            "reason": "offline", "severity": "critical", "activation_seconds": 60, "recovery_seconds": 120,
        })
        self.assertEqual(add.status_code, 302, add.content[:2000])
        rule = AlertRule.objects.get(name="Admin rule")
        change = self.client.post(reverse("admin:alerts_alertrule_change", args=[rule.pk]), {
            "name": "Admin rule", "description": "", "health": "critical", "reason": "offline", "severity": "warning",
            "activation_seconds": 60, "recovery_seconds": 120,
        })
        self.assertEqual(change.status_code, 302)
        delete = self.client.post(reverse("admin:alerts_alertrule_delete", args=[rule.pk]), {"post": "yes"})
        self.assertEqual(delete.status_code, 302)
        actions = list(ConfigurationEvent.objects.order_by("id").values_list("action", "source", "actor_name"))
        self.assertEqual(actions, [
            ("rule_created", "admin", "root"),
            ("rule_disabled", "admin", "root"),  # the unchecked box
            ("rule_changed", "admin", "root"),
            ("rule_deleted", "admin", "root"),
        ])
        changed = ConfigurationEvent.objects.get(action="rule_changed")
        self.assertEqual(changed.changes, {"severity": {"before": "critical", "after": "warning"}})

    def test_subscription_changes_made_in_the_admin_are_recorded(self):
        ops = make_user("ops", email="ops@example.com", all_customers=True)
        add = self.client.post(reverse("admin:alerts_notificationsubscription_add"), {
            "user": ops.pk, "enabled": "on", "min_severity": "critical",
        })
        self.assertEqual(add.status_code, 302, add.content[:2000])
        subscription = NotificationSubscription.objects.get(user=ops)
        self.client.post(reverse("admin:alerts_notificationsubscription_delete", args=[subscription.pk]), {"post": "yes"})
        events = list(ConfigurationEvent.objects.order_by("id").values_list("action", "target_name"))
        self.assertEqual(events, [("subscription_changed", "ops"), ("subscription_deleted", "ops")])

    def test_a_subscription_stays_with_its_user(self):
        ops = make_user("ops", email="ops@example.com", all_customers=True)
        other = make_user("other", email="other@example.com", all_customers=True)
        subscription = NotificationSubscription.objects.create(user=ops)
        self.client.post(reverse("admin:alerts_notificationsubscription_change", args=[subscription.pk]), {
            "user": other.pk, "enabled": "on", "min_severity": "warning",
        })
        subscription.refresh_from_db()
        self.assertEqual((subscription.user, subscription.min_severity), (ops, "warning"))

    def test_a_bulk_delete_that_fails_leaves_no_record(self):
        rule = make_rule("Bulk", reason="offline")
        changelist = reverse("admin:alerts_alertrule_changelist")
        with patch("django.contrib.admin.options.ModelAdmin.delete_queryset", side_effect=DatabaseError("lost")):
            with self.assertRaises(DatabaseError), self.assertLogs("django.request", "ERROR"):
                self.client.post(changelist, {"action": "delete_selected", "_selected_action": [rule.pk], "post": "yes"})
        self.assertFalse(ConfigurationEvent.objects.exists())
        self.client.post(changelist, {"action": "delete_selected", "_selected_action": [rule.pk], "post": "yes"})
        self.assertEqual(list(ConfigurationEvent.objects.values_list("action", flat=True)), ["rule_deleted"])

    def test_a_save_of_a_row_deleted_meanwhile_is_refused(self):
        rule = make_rule("Gone", reason="offline")
        subscription = NotificationSubscription.objects.create(
            user=make_user("ops", email="ops@example.com", all_customers=True)
        )
        rule_admin = admin.site._registry[AlertRule]
        subscription_admin = admin.site._registry[NotificationSubscription]
        request = RequestFactory().post("/")
        request.user = self.root
        AlertRule.objects.filter(pk=rule.pk).delete()
        NotificationSubscription.objects.filter(pk=subscription.pk).delete()
        for model_admin, obj in ((rule_admin, rule), (subscription_admin, subscription)):
            with self.subTest(model=type(obj).__name__), self.assertRaises(Http404):
                model_admin.save_model(request, obj, None, change=True)
        self.assertFalse(NotificationSubscription.objects.exists())
        self.assertFalse(ConfigurationEvent.objects.exists())

    def test_a_bulk_delete_records_exactly_what_it_deletes(self):
        kept = make_rule("Enabled meanwhile", reason="offline", enabled=False)
        gone = make_rule("Still disabled", reason="offline", enabled=False)
        queryset = AlertRule.objects.filter(enabled=False, pk__in=[kept.pk, gone.pk])
        self.assertEqual(len(queryset), 2)  # read, as the changelist's confirmation reads it
        AlertRule.objects.filter(pk=kept.pk).update(enabled=True)
        request = RequestFactory().post("/")
        request.user = self.root
        admin.site._registry[AlertRule].delete_queryset(request, queryset)
        self.assertEqual(list(AlertRule.objects.filter(pk__in=[kept.pk, gone.pk])), [kept])
        self.assertEqual(list(ConfigurationEvent.objects.values_list("target_name", flat=True)), ["Still disabled"])

    def test_a_subscription_save_the_model_refuses_is_a_form_error(self):
        ops = make_user("ops", email="ops@example.com", all_customers=True)
        subscription = NotificationSubscription.objects.create(user=ops)
        type(ops).objects.filter(pk=ops.pk).update(email="")
        response = self.client.post(reverse("admin:alerts_notificationsubscription_change", args=[subscription.pk]), {
            "min_severity": "critical",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "This user has no email address.")

    def test_bulk_deletes_of_subscriptions_are_recorded_with_the_deletion(self):
        subscriptions = [
            NotificationSubscription.objects.create(user=make_user(name, email=f"{name}@example.com", all_customers=True))
            for name in ("one", "two")
        ]
        changelist = reverse("admin:alerts_notificationsubscription_changelist")
        selected = {"action": "delete_selected", "_selected_action": [str(s.pk) for s in subscriptions], "post": "yes"}
        with patch("django.contrib.admin.options.ModelAdmin.delete_queryset", side_effect=DatabaseError("lost")):
            with self.assertRaises(DatabaseError), self.assertLogs("django.request", "ERROR"):
                self.client.post(changelist, selected)
        self.assertFalse(ConfigurationEvent.objects.exists())
        self.client.post(changelist, selected)
        events = ConfigurationEvent.objects.order_by("target_name")
        self.assertEqual(
            [(event.action, event.actor, event.target_name) for event in events],
            [("subscription_deleted", self.root, "one"), ("subscription_deleted", self.root, "two")],
        )

    def test_a_subscription_deleted_with_its_account_is_recorded(self):
        for index, delete in enumerate((lambda user: user.delete(), lambda user: type(user).objects.filter(pk=user.pk).delete())):
            with self.subTest(index=index):
                user = make_user(f"leaving-{index}", email=f"leaving{index}@example.com", all_customers=True)
                subscription = NotificationSubscription.objects.create(user=user, min_severity="warning")
                delete(user)
                event = ConfigurationEvent.objects.get(target_id=str(subscription.pk))
                self.assertEqual(
                    (event.action, event.source, event.actor, event.actor_name, event.target_name),
                    ("subscription_deleted", "account_deleted", None, "", f"leaving-{index}"),
                )
                self.assertEqual(event.changes["minSeverity"], {"before": "warning", "after": None})

    def test_the_new_records_are_read_only_in_the_admin(self):
        for model in ("testemailrequest", "notifierheartbeat", "configurationevent"):
            with self.subTest(model=model):
                self.assertEqual(self.client.get(reverse(f"admin:alerts_{model}_changelist")).status_code, 200)
                self.assertEqual(self.client.get(reverse(f"admin:alerts_{model}_add")).status_code, 403)

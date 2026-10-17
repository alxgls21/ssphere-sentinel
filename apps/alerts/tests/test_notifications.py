"""Incident emails: who is emailed, the outbox the engine fills in the transaction of
each incident step, the notifier that empties it, the test email, and how long
their records are kept."""

from __future__ import annotations

import email.policy
import hashlib
import io
import json
import os
import signal
import smtplib
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import django
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core import mail
from django.core.exceptions import ValidationError
from django.core.management import CommandError, call_command
from django.db import IntegrityError, OperationalError, connection
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.alerts import engine, notifications
from apps.alerts.management.commands.run_notifier import Notifier
from apps.alerts.models import (
    AlertRule,
    DeliveryFailure,
    Incident,
    IncidentEvent,
    Notification,
    NotificationKind,
    NotificationSubscription,
)
from apps.alerts.notifications import MAX_ATTEMPTS, backoff, claim, classify, compose, deliver, enqueue
from apps.alerts.runtime import alive, mark_alive as real_mark_alive, stopped_by_signals, unapplied_migrations
from apps.alerts.tests.fleet import PINNED, EngineTestCase, Fleet, evaluate, t
from apps.alerts.tests.helpers import make_rule, open_incident
from apps.console.models import CustomerAccess
from apps.console.tests.helpers import make_user
from apps.inventory.models import Customer, Site

OPENED, RECOVERED = NotificationKind.OPENED, NotificationKind.RECOVERED
SMTP_PASSWORD = "Smtp-Secret-7f3c9a1e"
SMTP_ON = override_settings(
    SENTINEL_SMTP_HOST="smtp.example.com",
    SENTINEL_SMTP_PORT=587,
    SENTINEL_SMTP_SECURITY="starttls",
    SENTINEL_SMTP_USER="sentinel@example.com",
    SENTINEL_SMTP_PASSWORD=SMTP_PASSWORD,
    SENTINEL_EMAIL_FROM="Sentinel <sentinel@example.com>",
    SENTINEL_CONSOLE_URL="https://sentinel.example.com",
    SENTINEL_NOTIFICATION_MAX_AGE_HOURS=24,
)
SMTP_OFF = override_settings(SENTINEL_SMTP_HOST="", SENTINEL_SMTP_USER="", SENTINEL_SMTP_PASSWORD="")
NOTIFIER = "apps.alerts.management.commands.run_notifier"
SEND_TEST_EMAIL = "apps.alerts.management.commands.send_test_email"


def console_user(username: str, **options):
    """A console user with an address, as make_user builds one (grants: customers=, sites=, all_customers=)."""
    return make_user(username, email=f"{username}@example.com", **options)


def subscribe(user, **fields) -> NotificationSubscription:
    return NotificationSubscription.objects.create(user=user, **fields)


def rows(**filters) -> list[Notification]:
    return list(Notification.objects.filter(**filters).order_by("pk"))


def recipients(**filters) -> set[str]:
    return set(Notification.objects.filter(**filters).values_list("recipient__username", flat=True))


class FakeSMTP:
    """Django's SMTP backend as the notifier uses it: open once, send, close. Fails as told."""

    def __init__(self, *, open_error: BaseException | None = None, errors=(), on_send=None) -> None:
        self.open_error = open_error
        self.errors = list(errors)  # one per send_messages call: an exception, or None to send
        self.on_send = on_send
        self.sent: list[mail.EmailMessage] = []
        self.calls = self.opened = self.closed = 0

    def open(self):
        self.opened += 1
        if self.open_error is not None:
            raise self.open_error
        return True

    def send_messages(self, messages):
        self.calls += 1
        error = self.errors.pop(0) if self.errors else None
        if error is not None:
            raise error
        self.sent.extend(messages)
        if self.on_send is not None:
            self.on_send(messages)
        return len(messages)

    def close(self):
        self.closed += 1


def wire(message: mail.EmailMessage) -> bytes:
    """The bytes Django's SMTP backend would send for ``message``."""
    if django.VERSION >= (6, 0):
        return message.message(policy=email.policy.SMTP).as_bytes()
    return message.message().as_bytes(linesep="\r\n")


def using(fake: FakeSMTP):
    return patch("apps.alerts.notifications.smtp_connection", return_value=fake)


class Estate:
    """Two customers, three sites, a critical and a warning rule."""

    def __init__(self) -> None:
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.critical = make_rule("Server offline now", reason="offline")
        self.warning = make_rule("Server degraded", health="warning", severity="warning")

    def incident(self, site=None, *, rule=None, label="host-1") -> Incident:
        return open_incident(rule or self.critical, site=site, label=label)


# -- who is emailed -------------------------------------------------------------------


class SubscriptionTests(TestCase):
    def test_a_subscription_is_off_for_warnings_and_recoveries_until_asked(self):
        subscription = subscribe(console_user("ops"))
        self.assertEqual(
            (subscription.enabled, subscription.min_severity, subscription.send_recovery), (True, "critical", False)
        )

    def test_only_a_console_user_with_an_address_can_subscribe(self):
        with self.assertRaisesRegex(ValidationError, "no email address"):
            subscribe(make_user("no-address"))
        with self.assertRaisesRegex(ValidationError, "Only console users"):
            subscribe(make_user("admin-only", email="admin-only@example.com", console=False))
        subscribe(make_user("root", email="root@example.com", console=False, superuser=True))
        self.assertEqual(NotificationSubscription.objects.count(), 1)

    def test_what_a_subscription_asks_for(self):
        critical_only = NotificationSubscription(min_severity="critical")
        warnings_too = NotificationSubscription(min_severity="warning", send_recovery=True)
        off = NotificationSubscription(min_severity="warning", send_recovery=True, enabled=False)
        cases = (
            (critical_only, "critical", OPENED, True),
            (critical_only, "warning", OPENED, False),
            (critical_only, "critical", RECOVERED, False),
            (warnings_too, "warning", OPENED, True),
            (warnings_too, "warning", RECOVERED, True),
            (warnings_too, "critical", RECOVERED, True),
            (off, "critical", OPENED, False),
        )
        for subscription, severity, kind, expected in cases:
            with self.subTest(severity=severity, kind=kind, min_severity=subscription.min_severity):
                self.assertIs(subscription.covers(severity, kind), expected)


@SMTP_ON
class EnqueueTests(TestCase):
    def setUp(self):
        self.estate = Estate()
        self.everything = console_user("everything", all_customers=True)
        self.acme_ops = console_user("acme-ops", customers=[self.estate.acme])
        self.plant_ops = console_user("plant-ops", sites=[self.estate.plant])
        for user in (self.everything, self.acme_ops, self.plant_ops):
            subscribe(user)

    def test_each_subscriber_who_may_see_the_incident_gets_one_email(self):
        incident = self.estate.incident(self.estate.hq)
        self.assertEqual(enqueue(incident, OPENED, at=t(0)), 2)
        self.assertEqual(recipients(), {"everything", "acme-ops"})
        for row in rows():
            self.assertEqual((row.incident, row.kind, row.status, row.attempts), (incident, "opened", "pending", 0))
            self.assertEqual((row.created_at, row.next_attempt_at), (t(0), t(0)))

    def test_an_incident_without_a_site_is_for_those_who_see_every_customer(self):
        enqueue(self.estate.incident(None), OPENED, at=t(0))
        self.assertEqual(recipients(), {"everything"})

    def test_a_superuser_sees_every_incident(self):
        subscribe(make_user("root", email="root@example.com", console=False, superuser=True))
        enqueue(self.estate.incident(self.estate.plant), OPENED, at=t(0))
        self.assertEqual(recipients(), {"everything", "plant-ops", "root"})

    def test_nobody_inactive_unsubscribed_or_without_access_is_emailed(self):
        hq = [self.estate.hq]
        inactive = console_user("inactive", sites=hq)
        subscribe(inactive)
        type(inactive).objects.filter(pk=inactive.pk).update(is_active=False)
        subscribe(console_user("switched-off", sites=hq), enabled=False)
        console_user("not-subscribed", sites=hq)
        no_console = console_user("no-console", sites=hq)
        subscribe(no_console)
        no_console.user_permissions.clear()
        no_address = console_user("no-address", sites=hq)
        subscribe(no_address)
        type(no_address).objects.filter(pk=no_address.pk).update(email="")
        enqueue(self.estate.incident(self.estate.hq), OPENED, at=t(0))
        self.assertEqual(recipients(), {"everything", "acme-ops"})

    def test_warnings_and_recoveries_only_for_those_who_asked(self):
        warnings = console_user("warnings", all_customers=True)
        subscribe(warnings, min_severity="warning")
        recoveries = console_user("recoveries", all_customers=True)
        subscribe(recoveries, send_recovery=True)
        enqueue(self.estate.incident(self.estate.hq, rule=self.estate.warning), OPENED, at=t(0))
        self.assertEqual(recipients(), {"warnings"})
        critical = self.estate.incident(self.estate.hq)
        enqueue(critical, RECOVERED, at=t(10))
        self.assertEqual(recipients(incident=critical), {"recoveries"})

    def test_a_step_is_recorded_once_for_each_recipient(self):
        incident = self.estate.incident(self.estate.hq)
        enqueue(incident, OPENED, at=t(0))
        enqueue(incident, OPENED, at=t(30))  # recorded again: nothing new
        self.assertEqual(Notification.objects.count(), 2)
        self.assertEqual(set(Notification.objects.values_list("created_at", flat=True)), {t(0)})
        with self.assertRaises(IntegrityError):
            Notification.objects.create(
                incident=incident, recipient=self.everything, kind=OPENED, created_at=t(0), next_attempt_at=t(0)
            )

    @SMTP_OFF
    def test_nothing_is_recorded_while_email_is_off(self):
        self.assertEqual(enqueue(self.estate.incident(self.estate.hq), OPENED, at=t(0)), 0)
        self.assertFalse(Notification.objects.exists())


# -- the outbox, in the engine's transaction ----------------------------------------------


@SMTP_ON
class EngineOutboxTests(EngineTestCase):
    def setUp(self):
        super().setUp()
        self.enable("server-offline")
        self.server = self.fleet.server("web-1", site=self.fleet.hq, seen=0)
        self.subscription = subscribe(console_user("ops", all_customers=True), send_recovery=True)

    def open(self) -> Incident:
        evaluate(91)
        evaluate(150)
        return Incident.objects.get()

    def recover(self, incident: Incident) -> Incident:
        self.fleet.heartbeat(self.server, 700)
        evaluate(700)
        self.fleet.heartbeat(self.server, 820)
        evaluate(820)
        incident.refresh_from_db()
        return incident

    def test_an_incident_and_its_emails_are_recorded_together(self):
        incident = self.open()
        [row] = rows()
        self.assertEqual((row.incident, row.kind, row.status, row.created_at), (incident, "opened", "pending", t(150)))

    def test_emails_that_cannot_be_recorded_leave_no_incident_behind(self):
        evaluate(91)
        with patch.object(engine, "enqueue", side_effect=IntegrityError("refused")):
            report = evaluate(150)
        self.assertEqual(report.skipped, 1)
        self.assertFalse(Incident.objects.exists())
        self.assertFalse(IncidentEvent.objects.exists())
        with patch.object(engine, "enqueue", side_effect=RuntimeError("broken")):
            with self.assertRaises(RuntimeError):
                evaluate(160)
        self.assertFalse(Incident.objects.exists())
        # The next cycle opens it, with its email.
        evaluate(170)
        self.assertEqual(rows()[0].incident, Incident.objects.get())

    def test_the_recovery_is_emailed_with_it_to_those_who_asked(self):
        incident = self.recover(self.open())
        self.assertEqual(incident.status, "recovered")
        recovered = rows(kind=RECOVERED)
        self.assertEqual([(row.incident, row.created_at) for row in recovered], [(incident, incident.closed_at)])

    def test_no_recovery_email_unless_asked(self):
        NotificationSubscription.objects.update(send_recovery=False)
        incident = self.recover(self.open())
        self.assertEqual(incident.status, "recovered")
        self.assertEqual([row.kind for row in rows()], ["opened"])

    def test_acknowledging_closing_and_staying_open_email_nothing_more(self):
        incident = self.open()
        incident.acknowledge(make_user("operator"), at=t(160))
        for at in (200, 400, 3600):
            evaluate(at)
        AlertRule.objects.filter(key="server-offline").update(enabled=False)
        evaluate(3700)
        incident.refresh_from_db()
        self.assertEqual(incident.status, "closed")
        self.assertEqual([row.kind for row in rows()], ["opened"])

    @SMTP_OFF
    def test_without_email_incidents_open_and_nothing_is_queued(self):
        self.recover(self.open())
        self.assertFalse(Notification.objects.exists())


# -- delivery ----------------------------------------------------------------------------


@SMTP_ON
class DeliveryTests(TestCase):
    def setUp(self):
        self.estate = Estate()
        self.now = timezone.now().replace(microsecond=0)
        self.ops = console_user("ops", all_customers=True)
        self.subscription = subscribe(self.ops, min_severity="warning", send_recovery=True)
        self.incident = self.estate.incident(self.estate.hq, label="web-1")

    def queue(self, incident=None, kind=OPENED, *, at=None) -> list[Notification]:
        enqueue(incident or self.incident, kind, at=at or self.now)
        return rows()

    def test_a_due_email_is_sent_once_and_recorded(self):
        [row] = self.queue()
        report = deliver(self.now)
        self.assertEqual((report.claimed, report.sent, report.emails), (1, 1, 1))
        [message] = mail.outbox
        self.assertEqual(message.to, ["ops@example.com"])
        self.assertEqual(message.from_email, "Sentinel <sentinel@example.com>")
        self.assertEqual(message.subject, "[Sentinel] CRITICAL: Server offline now - web-1")
        self.assertIn("Site:      Acme / HQ", message.body)
        self.assertIn(f"Details:   https://sentinel.example.com/alerts/{self.incident.pk}", message.body)
        self.assertEqual(message.extra_headers["Auto-Submitted"], "auto-generated")
        self.assertRegex(message.extra_headers["Message-ID"], r"^<sentinel\.[0-9a-f]{32}@example\.com>$")
        row.refresh_from_db()
        self.assertEqual((row.status, row.attempts, row.failure, row.claim, row.lease_expires_at), ("sent", 1, "", None, None))
        self.assertIsNotNone(row.sent_at)
        self.assertEqual(deliver(self.now + timedelta(hours=2)).claimed, 0)
        self.assertEqual(len(mail.outbox), 1)

    def test_an_email_not_yet_due_waits(self):
        self.queue(at=self.now + timedelta(minutes=5))
        self.assertEqual(deliver(self.now).claimed, 0)
        self.assertEqual(deliver(self.now + timedelta(minutes=5)).sent, 1)

    def test_what_is_due_to_one_user_goes_in_one_email(self):
        second = self.estate.incident(self.estate.dc, label="db-1")
        self.queue()
        self.queue(second)
        recovered = self.estate.incident(self.estate.plant, label="fw-1")
        recovered.recover(recovered_at=self.now, at=self.now)
        self.queue(recovered, RECOVERED)
        report = deliver(self.now)
        self.assertEqual((report.sent, report.emails), (3, 1))
        [message] = mail.outbox
        self.assertEqual(message.subject, "[Sentinel] 2 incident(s) opened, 1 recovered")
        self.assertLess(message.body.index("web-1"), message.body.index("fw-1"))
        self.assertIn("Recovered:", message.body)

    def test_a_long_list_is_split_into_several_emails(self):
        for index in range(4):
            self.queue(self.estate.incident(self.estate.hq, label=f"host-{index}"))
        with patch.object(notifications, "MAX_PER_EMAIL", 3):
            report = deliver(self.now)
        self.assertEqual((report.sent, report.emails, len(mail.outbox)), (4, 2, 2))

    def message_id(self, *rows_: Notification) -> str:
        loaded = Notification.objects.select_related("incident__rule", "incident__site__customer").filter(
            pk__in=[row.pk for row in rows_]
        )
        return compose(list(loaded), self.ops).extra_headers["Message-ID"]

    def test_the_message_id_is_the_steps_own_and_keyed_with_the_installation_secret(self):
        [row] = self.queue()
        first = self.message_id(row)
        self.assertEqual(self.message_id(row), first)  # a resend of the same step
        # Made again for the same step (a restored database, another row id): the same id.
        Notification.objects.all().delete()
        [again] = self.queue()
        self.assertNotEqual(again.pk, row.pk)
        self.assertEqual(self.message_id(again), first)
        # Another step, another id; another installation, another id for the same step.
        other = self.queue(self.estate.incident(self.estate.hq, label="db-1"))[-1]
        self.assertNotEqual(self.message_id(other), first)
        with override_settings(SECRET_KEY="another-installation-" + "k" * 40):
            self.assertNotEqual(self.message_id(again), first)
        # Nothing of the row ids, which count every email of every customer.
        key = first.removeprefix("<sentinel.").partition("@")[0]
        for ids in (str(again.pk), f"{again.pk}", f"{again.pk}.{other.pk}"):
            self.assertNotEqual(key, hashlib.sha256(ids.encode()).hexdigest()[:32])

    @override_settings(SENTINEL_EMAIL_FROM="Sentinel <sentinel@bücher.example>")
    def test_a_sender_with_an_internationalized_domain_is_sent(self):
        self.queue()
        fake = FakeSMTP(on_send=lambda messages: wire(messages[0]))
        with using(fake):
            self.assertEqual(deliver(self.now).sent, 1)
        self.assertTrue(fake.sent[0].extra_headers["Message-ID"].endswith("@xn--bcher-kva.example>"))

    def test_names_with_any_kind_of_line_break_are_sent_on_one_line(self):
        self.estate.critical.name = "Offline\u2028now"
        self.estate.critical.save()
        Incident.objects.filter(pk=self.incident.pk).update(entity_label="app\u2029x\x85y\x1cz on host-1 \U0001f469\u200d\U0001f4bb")
        self.queue()
        fake = FakeSMTP(on_send=lambda messages: wire(messages[0]))
        with using(fake):
            self.assertEqual(deliver(self.now).sent, 1)
        # What ends a line becomes a space; a zero-width joiner (in an emoji, a name) stays.
        self.assertEqual(fake.sent[0].subject, "[Sentinel] CRITICAL: Offline now - app x y z on host-1 \U0001f469\u200d\U0001f4bb")

    def test_names_cannot_add_headers_to_an_email(self):
        self.estate.critical.name = "Evil\r\nBcc: someone@example.net"
        self.estate.critical.save()
        Incident.objects.filter(pk=self.incident.pk).update(entity_label="web-1\nX-Injected: yes")
        self.queue()
        deliver(self.now)
        [message] = mail.outbox
        self.assertNotIn("\n", message.subject)
        self.assertNotIn("\r", message.subject)
        headers = message.message().as_string().split("\n\n", 1)[0]
        self.assertNotIn("\nBcc:", headers)
        self.assertNotIn("\nX-Injected:", headers)

    # -- checked again just before sending

    def test_what_no_longer_holds_just_before_sending_is_not_sent_and_says_why(self):
        User = get_user_model()
        cases = {
            "access taken away": (
                {"customers": [self.estate.acme]},
                lambda user: CustomerAccess.objects.filter(user=user).delete(),
                DeliveryFailure.NOT_VISIBLE,
            ),
            "account disabled": ({"all_customers": True}, lambda user: User.objects.filter(pk=user.pk).update(is_active=False),
                                 DeliveryFailure.RECIPIENT_UNAVAILABLE),
            "address removed": ({"all_customers": True}, lambda user: User.objects.filter(pk=user.pk).update(email=""),
                                DeliveryFailure.RECIPIENT_UNAVAILABLE),
            "console access removed": ({"all_customers": True}, lambda user: user.user_permissions.remove(
                Permission.objects.get(codename="use_console")), DeliveryFailure.RECIPIENT_UNAVAILABLE),
            "subscription switched off": ({"all_customers": True},
                                          lambda user: NotificationSubscription.objects.filter(user=user).update(enabled=False),
                                          DeliveryFailure.UNSUBSCRIBED),
            "subscription removed": ({"all_customers": True},
                                     lambda user: NotificationSubscription.objects.filter(user=user).delete(),
                                     DeliveryFailure.UNSUBSCRIBED),
        }
        NotificationSubscription.objects.filter(user=self.ops).update(enabled=False)
        for name, (grants, change, reason) in cases.items():
            with self.subTest(name):
                Notification.objects.all().delete()
                mail.outbox.clear()
                user = console_user(name.replace(" ", "-"), **grants)
                subscribe(user)
                [row] = self.queue()
                change(user)
                report = deliver(self.now)
                self.assertEqual((report.sent, report.cancelled, mail.outbox), (0, 1, []))
                row.refresh_from_db()
                self.assertEqual((row.status, row.failure, row.claim), ("cancelled", reason, None))

    def test_a_changed_preference_is_respected_for_each_email(self):
        self.queue(self.estate.incident(self.estate.hq, rule=self.estate.warning, label="warn-1"))
        recovered = self.estate.incident(self.estate.dc, label="rec-1")
        recovered.recover(recovered_at=self.now, at=self.now)
        self.queue(recovered, RECOVERED)
        self.queue()
        NotificationSubscription.objects.update(min_severity="critical", send_recovery=False)
        report = deliver(self.now)
        self.assertEqual((report.sent, report.cancelled), (1, 2))
        self.assertEqual(set(Notification.objects.filter(status="cancelled").values_list("failure", flat=True)), {"unsubscribed"})
        self.assertIn("web-1", mail.outbox[0].body)

    def test_the_address_is_the_one_the_user_has_when_it_is_sent(self):
        self.queue()
        type(self.ops).objects.filter(pk=self.ops.pk).update(email="new-address@example.com")
        deliver(self.now)
        self.assertEqual(mail.outbox[0].to, ["new-address@example.com"])

    def test_each_recipient_is_checked_right_before_their_own_email(self):
        for name in ("second", "third"):
            subscribe(console_user(name, all_customers=True))
        self.queue()
        User = get_user_model()

        def disable_the_others(messages):  # while the first email is being sent
            User.objects.exclude(email__in=messages[0].to).update(is_active=False)

        fake = FakeSMTP(on_send=disable_the_others)
        with using(fake):
            report = deliver(self.now)
        self.assertEqual((report.sent, report.cancelled, len(fake.sent)), (1, 2, 1))
        self.assertEqual(set(Notification.objects.filter(status="cancelled").values_list("failure", flat=True)),
                         {"recipient_unavailable"})

    # -- failures

    def test_a_temporary_failure_is_tried_again_after_a_growing_wait(self):
        [row] = self.queue()
        fake = FakeSMTP(errors=[smtplib.SMTPResponseException(451, b"4.3.0 try later")])
        with using(fake):
            report = deliver(self.now)
        self.assertEqual((report.retried, report.failures), (1, {"deferred": 1}))
        row.refresh_from_db()
        self.assertEqual((row.status, row.failure, row.attempts, row.claim), ("pending", "deferred", 1, None))
        self.assertEqual(row.next_attempt_at, self.now + timedelta(minutes=1))
        with using(FakeSMTP()):
            self.assertEqual(deliver(self.now + timedelta(seconds=59)).claimed, 0)
        fake = FakeSMTP()
        with using(fake):
            self.assertEqual(deliver(self.now + timedelta(minutes=1)).sent, 1)
        row.refresh_from_db()
        self.assertEqual((row.status, row.attempts, row.failure), ("sent", 2, ""))

    def test_the_wait_doubles_up_to_an_hour(self):
        self.assertEqual(
            [backoff(attempts).total_seconds() for attempts in range(1, 9)], [60, 120, 240, 480, 960, 1920, 3600, 3600]
        )

    def test_after_the_last_attempt_a_temporary_failure_is_final(self):
        [row] = self.queue()
        Notification.objects.filter(pk=row.pk).update(attempts=MAX_ATTEMPTS - 1)
        with using(FakeSMTP(errors=[TimeoutError()])):
            report = deliver(self.now)
        row.refresh_from_db()
        self.assertEqual((report.failed, row.status, row.failure, row.attempts), (1, "failed", "timeout", MAX_ATTEMPTS))

    def test_a_refusal_is_final_at_once(self):
        cases = (
            (smtplib.SMTPResponseException(554, b"5.7.1 message rejected"), "rejected"),
            (smtplib.SMTPRecipientsRefused({"ops@example.com": (550, b"5.1.1 unknown user")}), "recipient_refused"),
        )
        for error, failure in cases:
            with self.subTest(failure):
                Notification.objects.all().delete()
                [row] = self.queue()
                with using(FakeSMTP(errors=[error])):
                    deliver(self.now)
                row.refresh_from_db()
                self.assertEqual((row.status, row.failure, row.attempts), ("failed", failure, 1))

    def test_failures_are_told_apart(self):
        cases = (
            (ConnectionRefusedError(), "connection"),
            (smtplib.SMTPConnectError(421, b"busy"), "connection"),
            (smtplib.SMTPServerDisconnected("gone"), "connection"),
            (OSError("Name or service not known"), "connection"),
            (TimeoutError(), "timeout"),
            (ssl.SSLCertVerificationError("certificate verify failed"), "tls"),
            (smtplib.SMTPNotSupportedError("STARTTLS extension not supported by server."), "tls"),
            (smtplib.SMTPNotSupportedError("SMTP AUTH extension not supported by server."), "authentication"),
            (smtplib.SMTPException("No suitable authentication method found."), "authentication"),
            (smtplib.SMTPHeloError(550, b"bad HELO name"), "connection"),
            (smtplib.SMTPSenderRefused(530, b"5.7.0 Authentication required", "s@example.com"), "authentication"),
            (smtplib.SMTPRecipientsRefused({"a@example.com": (530, b"5.7.0 Authentication required")}), "authentication"),
            (smtplib.SMTPAuthenticationError(535, b"5.7.8 bad credentials"), "authentication"),
            (smtplib.SMTPRecipientsRefused({"a@example.com": (450, b"mailbox busy")}), "deferred"),
            (smtplib.SMTPRecipientsRefused({"a@example.com": (550, b"no"), "b@example.com": (451, b"later")}), "deferred"),
            (smtplib.SMTPSenderRefused(553, b"sender refused", "sentinel@example.com"), "rejected"),
            (smtplib.SMTPDataError(452, b"insufficient storage"), "deferred"),
            (ValueError("bad address"), "internal"),
        )
        for error, failure in cases:
            with self.subTest(error=type(error).__name__, failure=failure):
                self.assertEqual(classify(error), failure)

    def test_an_unavailable_server_puts_off_the_whole_run(self):
        other = console_user("other", all_customers=True)
        subscribe(other)
        gone = console_user("gone", all_customers=True)
        subscribe(gone)
        self.queue()
        type(gone).objects.filter(pk=gone.pk).update(is_active=False)
        fake = FakeSMTP(open_error=ConnectionRefusedError())
        with using(fake):
            report = deliver(self.now)
        self.assertEqual((fake.opened, fake.calls), (1, 0))
        self.assertEqual((report.sent, report.retried, report.cancelled), (0, 2, 1))
        pending = rows(status="pending")
        self.assertEqual({(row.failure, row.attempts) for row in pending}, {("connection", 1)})
        self.assertEqual(rows(status="cancelled")[0].recipient, gone)

    def test_a_connection_lost_during_the_run_puts_off_the_rest(self):
        for name in ("second", "third"):
            subscribe(console_user(name, all_customers=True))
        self.queue()
        fake = FakeSMTP(errors=[smtplib.SMTPServerDisconnected("Connection unexpectedly closed")])
        with using(fake):
            report = deliver(self.now)
        self.assertEqual((fake.calls, report.sent, report.retried), (1, 0, 3))
        self.assertEqual(fake.closed, 1)

    def test_one_refused_recipient_does_not_stop_the_others(self):
        subscribe(console_user("second", all_customers=True))
        self.queue()
        fake = FakeSMTP(errors=[smtplib.SMTPRecipientsRefused({"x@example.com": (550, b"no such user")}), None])
        with using(fake):
            report = deliver(self.now)
        self.assertEqual((report.failed, report.sent, len(fake.sent)), (1, 1, 1))

    def test_an_email_not_sent_in_time_is_given_up(self):
        [row] = self.queue(at=self.now - timedelta(hours=24, seconds=1))
        report = deliver(self.now)
        row.refresh_from_db()
        self.assertEqual((report.failed, row.status, row.failure, mail.outbox), (1, "failed", "expired", []))

    def test_failures_are_logged_by_user_id_and_kind_never_an_address_or_the_servers_words(self):
        self.queue()
        error = smtplib.SMTPResponseException(451, f"4.7.0 ops@example.com {SMTP_PASSWORD}".encode())
        with using(FakeSMTP(errors=[error])), self.assertLogs("apps.alerts.notifier", "WARNING") as logs:
            report = deliver(self.now)
        output = "\n".join(logs.output) + str(report)
        self.assertIn(f"email to user {self.ops.pk} about 1 incident step(s) not sent: deferred", output)
        for secret in ("ops@example.com", SMTP_PASSWORD, "4.7.0"):
            self.assertNotIn(secret, output)

    # -- stopping, and runs that overlap

    def test_a_stop_hands_back_what_the_run_has_not_tried(self):
        subscribe(console_user("second", all_customers=True))
        self.queue()
        report = deliver(self.now, should_stop=lambda: len(mail.outbox) >= 1)  # a stop once one is sent
        self.assertEqual((report.sent, report.released, len(mail.outbox)), (1, 1, 1))
        [handed_back] = rows(status="pending")
        self.assertEqual((handed_back.attempts, handed_back.claim, handed_back.next_attempt_at), (0, None, self.now))

    def test_each_email_to_one_recipient_asks_whether_to_stop(self):
        self.queue(self.estate.incident(self.estate.hq, label="db-1"))
        self.queue()
        with patch.object(notifications, "MAX_PER_EMAIL", 1):
            report = deliver(self.now, should_stop=lambda: len(mail.outbox) >= 1)
        self.assertEqual((report.sent, report.emails, report.released), (1, 1, 1))
        self.assertEqual(len(mail.outbox), 1)

    def test_a_stop_while_the_connection_opens_begins_no_email(self):
        self.queue()
        notifier_stop = threading.Event()

        class SlowToOpen(FakeSMTP):
            def open(self):
                notifier_stop.set()  # SIGTERM while connecting
                return super().open()

        fake = SlowToOpen()
        with using(fake):
            report = deliver(self.now, should_stop=notifier_stop.is_set)
        self.assertEqual((fake.opened, fake.calls, report.sent, report.released), (1, 0, 0, 1))
        self.assertEqual(rows(status="pending")[0].attempts, 0)

    def test_a_refusal_of_the_session_during_the_first_email_is_tried_again(self):
        subscribe(console_user("second", all_customers=True))
        self.queue()
        # Without STARTTLS or credentials, EHLO comes with the first email; MAIL FROM can need a login.
        for error in (
            smtplib.SMTPHeloError(550, b"bad HELO name"),
            smtplib.SMTPSenderRefused(530, b"5.7.0 Authentication required", "s@example.com"),
        ):
            with self.subTest(error=type(error).__name__):
                Notification.objects.update(status="pending", next_attempt_at=self.now, attempts=0, failure="")
                fake = FakeSMTP(errors=[error])
                with using(fake):
                    report = deliver(self.now)
                self.assertEqual((fake.calls, report.failed, report.retried), (1, 0, 2))

    def test_a_refusal_before_any_email_is_tried_again(self):
        [row] = self.queue()
        for error in (
            smtplib.SMTPHeloError(550, b"go away"),
            smtplib.SMTPResponseException(554, b"5.7.0 no STARTTLS here"),
        ):
            with self.subTest(error=type(error).__name__):
                Notification.objects.filter(pk=row.pk).update(status="pending", next_attempt_at=self.now, attempts=0)
                with using(FakeSMTP(open_error=error)):
                    report = deliver(self.now)
                row.refresh_from_db()
                self.assertEqual((row.status, row.failure, report.failed, report.retried), ("pending", "connection", 0, 1))

    def test_the_record_outlives_the_account_and_an_email_still_to_be_sent_is_not_sent(self):
        [row] = self.queue()
        self.assertEqual(row.recipient_name, "ops")
        self.ops.delete()
        row.refresh_from_db()
        self.assertEqual((row.recipient_id, row.recipient_name), (None, "ops"))
        report = deliver(self.now)
        row.refresh_from_db()
        self.assertEqual((report.cancelled, row.status, row.failure, mail.outbox), (1, "cancelled", "recipient_unavailable", []))

    def test_a_run_whose_lease_runs_short_begins_no_email(self):
        self.queue()
        with patch.object(notifications, "LEASE", timedelta(minutes=10)), patch.object(
            notifications, "SEND_MARGIN", timedelta(minutes=10)
        ):
            report = deliver(self.now)
        self.assertEqual((report.sent, report.released, mail.outbox), (0, 1, []))
        self.assertEqual(rows(status="pending")[0].attempts, 0)

    def test_a_run_that_died_is_taken_over_once_its_lease_expires(self):
        [row] = self.queue()
        dead, ids = claim(self.now)  # a notifier claims it and is killed
        self.assertEqual(ids, [row.pk])
        self.assertEqual(deliver(self.now + timedelta(minutes=29)).claimed, 0)
        report = deliver(self.now + notifications.LEASE)
        self.assertEqual(report.sent, 1)
        row.refresh_from_db()
        self.assertEqual((row.status, row.attempts), ("sent", 2))
        # Should the dead run come back to record something, it holds nothing any more.
        self.assertEqual(notifications._finish([row], dead, status="failed", failure="internal"), 0)
        row.refresh_from_db()
        self.assertEqual(row.status, "sent")


# -- several notifiers ------------------------------------------------------------------


@SMTP_ON
class ConcurrentDeliveryTests(TransactionTestCase):
    def setUp(self):
        self.estate = Estate()
        self.now = timezone.now().replace(microsecond=0)
        self.users = [console_user(f"ops-{index}", all_customers=True) for index in range(3)]
        for user in self.users:
            subscribe(user)
        for index in range(20):
            enqueue(self.estate.incident(self.estate.hq, label=f"host-{index}"), OPENED, at=self.now)

    def test_a_row_another_notifier_holds_is_skipped_not_waited_for(self):
        held = list(Notification.objects.order_by("pk").values_list("pk", flat=True)[:5])
        other = connection.get_new_connection(connection.get_connection_params())
        try:
            with other.cursor() as cursor:
                cursor.execute("SELECT id FROM alerts_notification WHERE id = ANY(%s) FOR UPDATE", [held])
            with connection.cursor() as cursor:
                cursor.execute("SET lock_timeout = '5s'")  # waiting would fail the test, not hang it
            _, ids = claim(self.now, limit=1000)
        finally:
            other.rollback()
            other.close()
            with connection.cursor() as cursor:
                cursor.execute("RESET lock_timeout")
        self.assertEqual(len(ids), 55)
        self.assertFalse(set(ids) & set(held))

    def test_two_notifiers_send_each_email_once(self):
        composed: list[list[int]] = []
        original = notifications.compose

        def recording(rows_, user):
            composed.append([row.pk for row in rows_])
            time.sleep(0.005)  # long enough for the other notifier to claim meanwhile
            return original(rows_, user)

        barrier = threading.Barrier(2)
        errors = []

        def notifier():
            try:
                barrier.wait()
                while deliver(self.now, limit=7).claimed:
                    pass
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=notifier) for _ in range(2)]
        with patch.object(notifications, "compose", side_effect=recording):
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(errors, [])
        sent = [pk for chunk in composed for pk in chunk]
        self.assertEqual(sorted(sent), sorted(Notification.objects.values_list("pk", flat=True)))
        self.assertEqual(len(sent), len(set(sent)))
        self.assertEqual(Notification.objects.exclude(status="sent").count(), 0)
        self.assertEqual(len(mail.outbox), len(composed))


@SMTP_ON
@PINNED
class ConcurrentEngineOutboxTests(TransactionTestCase):
    def test_two_engines_at_once_record_each_email_once(self):
        users = [console_user(f"ops-{index}", all_customers=True) for index in range(3)]
        for user in users:
            subscribe(user)
        AlertRule.objects.update(enabled=False)
        AlertRule.objects.create(
            name="Offline at once", entity_kind="server", health="critical", reason="offline", severity="critical",
            activation_seconds=0,
        )
        fleet = Fleet()
        for index in range(10):
            fleet.server(f"web-{index}", site=fleet.hq, seen=0)
        barrier = threading.Barrier(2)

        def evaluator():
            try:
                barrier.wait()
                engine.evaluate(t(200), monitoring_since=t(-86_400))
            finally:
                connection.close()

        threads = [threading.Thread(target=evaluator) for _ in range(2)]
        with patch.object(engine.logger, "warning"):
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(Incident.objects.filter(rule__name="Offline at once").count(), 10)
        self.assertEqual(Notification.objects.count(), 10 * len(users))
        self.assertEqual(Notification.objects.values("incident", "recipient").distinct().count(), 30)


# -- the notifier process ---------------------------------------------------------------


@SMTP_ON
class NotifierCommandTests(TestCase):
    def setUp(self):
        self.estate = Estate()
        self.ops = console_user("ops", all_customers=True)
        subscribe(self.ops)

    def queue(self, label="host-1"):
        enqueue(self.estate.incident(self.estate.hq, label=label), OPENED, at=timezone.now())

    @SMTP_OFF
    def test_it_will_not_start_while_email_is_off(self):
        with self.assertRaisesRegex(CommandError, "Email notifications are off"):
            call_command("run_notifier", "--once")

    def test_it_never_migrates_and_will_not_start_with_migrations_pending(self):
        with patch(f"{NOTIFIER}.unapplied_migrations", return_value=[("alerts", "9999_future")]):
            with self.assertRaisesRegex(CommandError, "1 migration\\(s\\) not applied.*never migrates"):
                call_command("run_notifier", "--once")

    @override_settings(SENTINEL_SMTP_PASSWORD="")
    def test_a_user_name_without_its_password_is_refused(self):
        with self.assertRaisesRegex(CommandError, "SENTINEL_SMTP_USER is set without SENTINEL_SMTP_PASSWORD"):
            call_command("run_notifier", "--once")
        with self.assertRaisesRegex(CommandError, "SENTINEL_SMTP_USER is set without SENTINEL_SMTP_PASSWORD"):
            call_command("send_test_email", "you@example.com")
        self.assertEqual(mail.outbox, [])

    def test_the_interval_and_the_batch_are_bounded(self):
        for arguments, message in ((["--interval", "4"], "--interval"), (["--interval", "3601"], "--interval"),
                                   (["--batch", "0"], "--batch"), (["--batch", "1001"], "--batch")):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(CommandError, message):
                call_command("run_notifier", "--once", *arguments)

    def test_once_sends_what_is_due_and_says_what_it_did(self):
        self.queue()
        out = io.StringIO()
        call_command("run_notifier", "--once", stdout=out)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("Delivered: 1 sent in 1 email(s)", out.getvalue())
        self.assertNotIn(SMTP_PASSWORD, out.getvalue())

    def test_a_failed_run_is_logged_and_the_next_starts_on_a_new_connection(self):
        notifier = Notifier(interval=5)
        with patch(f"{NOTIFIER}.deliver", side_effect=OperationalError("server closed the connection")):
            with self.assertLogs("apps.alerts.notifier", "ERROR"):
                self.assertEqual(notifier.cycle(), "failed")
        with patch(f"{NOTIFIER}.deliver", side_effect=OperationalError("x")), self.assertRaisesRegex(
            CommandError, "Sending failed"
        ), self.assertLogs("apps.alerts.notifier", "ERROR"):
            call_command("run_notifier", "--once")

@SMTP_ON
class NotifierServingTests(TransactionTestCase):
    """The long-running mode, which also looks after its database connection."""

    def setUp(self):
        self.estate = Estate()
        for name in ("ops", "second"):
            subscribe(console_user(name, all_customers=True))

    def test_a_full_batch_is_followed_at_once_by_the_next(self):
        for index in range(3):
            enqueue(self.estate.incident(self.estate.hq, label=f"host-{index}"), OPENED, at=timezone.now())
        notifier = Notifier(interval=3600, batch=2)
        outcomes, waits = [], []
        original = notifier.cycle

        def cycle():
            outcomes.append(original())
            if outcomes[-1] == "done":
                notifier.stop.set()
            return outcomes[-1]

        notifier.cycle = cycle
        with patch.object(notifier.stop, "wait", side_effect=waits.append), self.assertLogs("apps.alerts.notifier", "INFO"):
            notifier.serve()
        self.assertEqual(outcomes, ["full", "full", "full", "done"])
        self.assertEqual(waits, [3600])  # only after the run that found nothing more
        self.assertEqual(Notification.objects.filter(status="sent").count(), 6)

    def test_sigterm_stops_it_after_the_email_in_progress(self):
        enqueue(self.estate.incident(self.estate.hq), OPENED, at=timezone.now())
        notifier = Notifier(interval=5)

        def terminated(messages):
            signal.raise_signal(signal.SIGTERM)

        original = signal.getsignal(signal.SIGTERM)
        with using(FakeSMTP(on_send=terminated)), stopped_by_signals(notifier.stop), self.assertLogs(
            "apps.alerts.notifier", "INFO"
        ):
            notifier.serve()
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)
        self.assertEqual((notifier.report.sent, notifier.report.released), (1, 1))
        [handed_back] = Notification.objects.filter(status="pending")
        self.assertEqual((handed_back.attempts, handed_back.claim), (0, None))

    def test_it_keeps_its_liveness_file_current_between_emails(self):
        enqueue(self.estate.incident(self.estate.hq), OPENED, at=timezone.now())
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "alive")
            notifier = Notifier(interval=5, liveness=path)
            marks = []

            def mark(where, *, within):
                marks.append(within)
                if len(mail.outbox) == 1:  # once the first email is sent: stop
                    notifier.stop.set()
                real_mark_alive(where, within=within)

            with patch(f"{NOTIFIER}.mark_alive", side_effect=mark), self.assertLogs("apps.alerts.notifier", "INFO"):
                notifier.serve()
            # Before the run; for the first recipient, before rechecking and right before the email;
            # for the second, before rechecking, where the stop hands its email back.
            self.assertEqual(marks, [2 * 5 + 600] * 4)
            self.assertTrue(alive(path))
            self.assertEqual(notifier.report.released, 1)


# -- the test email -----------------------------------------------------------------------


@SMTP_ON
class SendTestEmailTests(TestCase):
    def test_it_sends_one_email_and_names_the_server_never_the_credentials(self):
        out = io.StringIO()
        call_command("send_test_email", "you@example.com", stdout=out)
        [message] = mail.outbox
        self.assertEqual((message.to, message.subject), (["you@example.com"], "[Sentinel] Test email"))
        self.assertEqual(out.getvalue().strip(), "Sent a test email to you@example.com through smtp.example.com:587 (starttls).")
        for text in (out.getvalue(), message.body):
            self.assertNotIn(SMTP_PASSWORD, text)

    def test_a_failure_is_reported_by_its_kind_only(self):
        error = smtplib.SMTPAuthenticationError(535, f"5.7.8 {SMTP_PASSWORD} rejected for sentinel@example.com".encode())
        with patch(f"{SEND_TEST_EMAIL}.smtp_connection", return_value=FakeSMTP(errors=[error])), self.assertRaises(
            CommandError
        ) as raised:
            call_command("send_test_email", "you@example.com")
        self.assertEqual(str(raised.exception), "Not sent: Authentication with the SMTP server failed (authentication).")
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)

    def test_an_address_is_required(self):
        with self.assertRaisesRegex(CommandError, "not an email address"):
            call_command("send_test_email", "not an address\nBcc: x@example.net")
        self.assertEqual(mail.outbox, [])

    @SMTP_OFF
    def test_nothing_is_sent_while_email_is_off(self):
        with self.assertRaisesRegex(CommandError, "Email is off"):
            call_command("send_test_email", "you@example.com")


# -- retention ---------------------------------------------------------------------------


@override_settings(
    SENTINEL_INCIDENT_RETENTION_DAYS=365, SENTINEL_NOTIFICATION_RETENTION_DAYS=90, SENTINEL_NOTIFICATION_MAX_AGE_HOURS=24
)
class RetentionTests(TestCase):
    def setUp(self):
        self.estate = Estate()
        self.ops = console_user("ops", all_customers=True)
        self.now = timezone.now()

    def incident(self, *, ended: bool = True, age_days: int = 400, label: str = "host") -> Incident:
        days = -age_days * 86_400
        incident = open_incident(self.estate.critical, site=self.estate.hq, label=label, started=days - 120, opened=days - 60)
        if ended:
            incident.recover(recovered_at=self.now - timedelta(days=age_days), at=self.now - timedelta(days=age_days))
        return incident

    def email(self, incident: Incident, status: str, *, kind=OPENED, age=timedelta(days=400), lease=None) -> Notification:
        """A record ``age`` old; a ``sending`` one held until ``lease`` (by default, a lease that has expired)."""
        created = self.now - age
        fields = {"sent_at": created} if status == "sent" else {}
        if status in ("failed", "cancelled"):
            fields["failure"] = "expired" if status == "failed" else "unsubscribed"
        if status == "sending":
            fields.update(claim=uuid.uuid4(), lease_expires_at=lease or self.now - timedelta(minutes=1))
        return Notification.objects.create(
            incident=incident, recipient=self.ops, recipient_name="ops", kind=kind, status=status, created_at=created,
            next_attempt_at=created, **fields,
        )

    def purge(self, command: str, *arguments: str) -> str:
        out = io.StringIO()
        call_command(command, *arguments, stdout=out)
        return out.getvalue()

    def statuses(self) -> dict[str, tuple[str, str]]:
        return {row.incident.entity_label: (row.status, row.failure) for row in Notification.objects.select_related("incident")}

    def test_ended_incidents_go_with_their_history_and_emails_and_nothing_else(self):
        gone = self.incident(label="gone")
        self.email(gone, "sent")
        self.email(gone, "failed", kind=RECOVERED)
        open_old = self.incident(ended=False, label="still-open")
        acknowledged = self.incident(ended=False, label="acknowledged")
        acknowledged.acknowledge(self.ops, at=self.now - timedelta(days=300))
        self.incident(age_days=30, label="recent")
        # Emails still to be sent keep their incident; emails no notifier will send any more do not.
        self.email(self.incident(label="email-waiting"), "pending", kind=RECOVERED, age=timedelta(hours=1))
        self.email(self.incident(label="email-held"), "sending", lease=self.now + timedelta(minutes=5))
        self.email(self.incident(label="email-abandoned"), "pending", age=timedelta(hours=25))
        self.email(self.incident(label="email-of-a-dead-notifier"), "sending", age=timedelta(days=2))
        self.email(self.incident(ended=False, label="open-email-abandoned"), "pending", age=timedelta(hours=25))
        before = (Incident.objects.count(), IncidentEvent.objects.count(), self.statuses())
        self.assertIn("Would delete 3 incident(s)", self.purge("purge_incidents", "--dry-run"))
        self.assertEqual((Incident.objects.count(), IncidentEvent.objects.count(), self.statuses()), before)
        self.purge("purge_incidents")
        self.assertEqual(
            set(Incident.objects.values_list("entity_label", flat=True)),
            {"still-open", "acknowledged", "recent", "email-waiting", "email-held", "open-email-abandoned"},
        )
        self.assertFalse(IncidentEvent.objects.filter(incident_id=gone.pk).exists())
        # The emails of the incidents it keeps are left as they were (purge_notifications gives them up).
        self.assertEqual(self.statuses(), {
            "email-waiting": ("pending", ""), "email-held": ("sending", ""), "open-email-abandoned": ("pending", ""),
        })
        for kept in (open_old, acknowledged):
            self.assertTrue(Incident.objects.get(pk=kept.pk).is_open)

    def test_the_minimum_retention_of_incidents_is_a_week(self):
        with override_settings(SENTINEL_INCIDENT_RETENTION_DAYS=7):
            self.incident(age_days=6, label="six-days")
            self.incident(age_days=8, label="eight-days")
            self.purge("purge_incidents")
        self.assertEqual(list(Incident.objects.values_list("entity_label", flat=True)), ["six-days"])

    def test_ended_records_go_and_emails_no_notifier_will_send_are_given_up_first(self):
        def email(label, status, **options):
            return self.email(self.incident(ended=False, label=label), status, **options)

        for status in ("sent", "failed", "cancelled"):
            email(f"old-{status}", status)
        email("abandoned-long-ago", "pending")
        email("abandoned", "pending", age=timedelta(hours=25))
        email("dead-notifier", "sending", age=timedelta(days=2))
        email("waiting", "pending", age=timedelta(hours=1))
        email("held", "sending", age=timedelta(hours=1), lease=self.now + timedelta(minutes=5))
        email("recent", "sent", age=timedelta(days=10))
        before = self.statuses()
        self.assertIn(
            "Would give up 3 email(s) not sent in time, and delete 4 email record(s)",
            self.purge("purge_notifications", "--dry-run"),
        )
        self.assertEqual(self.statuses(), before)
        self.assertIn("Gave up 3 email(s) not sent in time. Deleted 4 email record(s)", self.purge("purge_notifications"))
        self.assertEqual(self.statuses(), {
            "abandoned": ("failed", "expired"),
            "dead-notifier": ("failed", "expired"),
            "waiting": ("pending", ""),
            "held": ("sending", ""),
            "recent": ("sent", ""),
        })
        self.assertFalse(Notification.objects.filter(status="failed", claim__isnull=False).exists())
        self.assertEqual(Incident.objects.count(), 9)  # the incidents stay


# -- the worker processes, and the admin -------------------------------------------------

ROOT = Path(__file__).resolve().parents[3]


class RuntimeTests(TestCase):
    def test_the_liveness_file_says_until_when_the_worker_is_alive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "alive")
            self.assertFalse(alive(path))  # never written
            real_mark_alive(path, within=60)
            self.assertTrue(alive(path))
            real_mark_alive(path, within=-1)
            self.assertFalse(alive(path))
            Path(path).write_text("not a time")
            self.assertFalse(alive(path))
            self.assertEqual(os.listdir(directory), ["alive"])  # never a temporary file left behind
        real_mark_alive(None, within=60)  # no file asked for: nothing to do

    def test_the_health_check_runs_without_django(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "alive")

            def check(*arguments: str) -> int:
                return subprocess.run(
                    [sys.executable, "-m", "apps.alerts.runtime", *arguments],
                    cwd=ROOT, env={"PATH": os.environ.get("PATH", "")}, capture_output=True, timeout=60, check=False,
                ).returncode

            self.assertEqual(check(path), 1)
            real_mark_alive(path, within=60)
            self.assertEqual(check(path), 0)
            self.assertEqual(check(), 1)
            self.assertEqual(check(path, "another"), 1)
        loaded = subprocess.run(
            [sys.executable, "-c", "import sys, apps.alerts.runtime; print('django' in sys.modules)"],
            cwd=ROOT, env={"PATH": os.environ.get("PATH", "")}, capture_output=True, text=True, timeout=60, check=True,
        )
        self.assertEqual(loaded.stdout.strip(), "False")

    def test_a_migrated_database_has_nothing_pending_for_the_workers(self):
        self.assertEqual(unapplied_migrations(), [])

    def test_sigterm_and_sigint_set_the_stop_and_the_old_handlers_come_back(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig.name):
                stop = threading.Event()
                before = signal.getsignal(sig)
                with stopped_by_signals(stop):
                    signal.raise_signal(sig)
                self.assertTrue(stop.is_set())
                self.assertEqual(signal.getsignal(sig), before)


@SMTP_ON
class AdminTests(TestCase):
    def setUp(self):
        self.client.force_login(make_user("root", email="root@example.com", superuser=True))
        incident = Estate().incident()
        subscribe(console_user("ops", all_customers=True))
        enqueue(incident, OPENED, at=timezone.now())

    def test_email_records_are_read_only_and_subscriptions_are_managed_there(self):
        notification = Notification.objects.get()
        for url, status in (
            ("/admin/alerts/notification/", 200),
            (f"/admin/alerts/notification/{notification.pk}/change/", 200),
            ("/admin/alerts/notification/add/", 403),
            ("/admin/alerts/notificationsubscription/", 200),
            ("/admin/alerts/notificationsubscription/add/", 200),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, status)
                self.assertNotIn(SMTP_PASSWORD, response.content.decode())
        response = self.client.post(f"/admin/alerts/notification/{notification.pk}/change/", {"status": "sent"})
        self.assertEqual(response.status_code, 403)
        notification.refresh_from_db()
        self.assertEqual(notification.status, "pending")

    def test_a_user_who_was_emailed_can_be_deleted_and_the_record_stays(self):
        ops = get_user_model().objects.get(username="ops")
        meta = ops._meta
        response = self.client.post(reverse(f"admin:{meta.app_label}_{meta.model_name}_delete", args=[ops.pk]), {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertFalse(type(ops).objects.filter(pk=ops.pk).exists())
        self.assertEqual((Notification.objects.get().recipient_id, Notification.objects.get().recipient_name), (None, "ops"))


SETTINGS_REPORT = """
import json, os
os.environ["DJANGO_SETTINGS_MODULE"] = "sentinel.settings"
import django
django.setup()
from apps.alerts.notifications import email_enabled, smtp_connection
backend = smtp_connection()
print(json.dumps({
    "enabled": email_enabled(),
    "backend": f"{type(backend).__module__}.{type(backend).__name__}",
    "options": [backend.host, backend.port, backend.use_tls, backend.use_ssl, backend.timeout, backend.username],
    "password": backend.password == os.environ.get("SENTINEL_SMTP_PASSWORD"),
}))
"""


class SmtpSettingsTests(SimpleTestCase):
    """The SMTP connection the settings make, outside the test runner (which swaps in an in-memory backend)."""

    BASE = {
        "PATH": os.environ.get("PATH", ""),
        "DJANGO_SECRET_KEY": "test-only-secret-key-not-used-anywhere-else-0123456789",
        "AGENT_TOKEN_PEPPER": "test-only-pepper",
        "POSTGRES_DB": "sentinel",
        "POSTGRES_USER": "sentinel",
        "POSTGRES_PASSWORD": "unused",
    }
    SMTP = {
        "SENTINEL_SMTP_HOST": "smtp.example.com",
        "SENTINEL_EMAIL_FROM": "Sentinel <sentinel@example.com>",
        "SENTINEL_SMTP_USER": "sentinel@example.com",
        "SENTINEL_SMTP_PASSWORD": SMTP_PASSWORD,
    }

    def load(self, **settings):
        return subprocess.run(
            [sys.executable, "-c", SETTINGS_REPORT], cwd=ROOT, env={**self.BASE, **settings},
            capture_output=True, text=True, timeout=120, check=False,
        )

    def test_each_kind_of_security_makes_the_smtp_backend_it_says(self):
        cases = (
            ({}, ["smtp.example.com", 587, True, False, 10, "sentinel@example.com"]),
            ({"SENTINEL_SMTP_SECURITY": "tls", "SENTINEL_SMTP_PORT": "465", "SENTINEL_SMTP_TIMEOUT": "30"},
             ["smtp.example.com", 465, False, True, 30, "sentinel@example.com"]),
            ({"SENTINEL_SMTP_SECURITY": "none", "SENTINEL_SMTP_PORT": "25", "SENTINEL_SMTP_USER": "",
              "SENTINEL_SMTP_PASSWORD": ""}, ["smtp.example.com", 25, False, False, 10, ""]),
        )
        for changes, options in cases:
            with self.subTest(changes=changes):
                result = self.load(**{**self.SMTP, **changes})
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["backend"], "django.core.mail.backends.smtp.EmailBackend")
                self.assertEqual((report["enabled"], report["options"], report["password"]), (True, options, True))

    def test_a_sender_may_have_a_name_and_an_internationalized_domain(self):
        senders = (
            "sentinel@example.com",
            "\u03a3\u03cd\u03c3\u03c4\u03b7\u03bc\u03b1 Sentinel <alerts@example.com>",
            "Sentinel Ops <ops+alerts@mail.example.co.uk>",
            "Sentinel <sentinel@b\u00fccher.example>",
        )
        for sender in senders:
            with self.subTest(sender=sender):
                result = self.load(**{**self.SMTP, "SENTINEL_EMAIL_FROM": sender})
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_server_that_does_not_answer_in_time_is_a_timeout(self):
        listener = socket.create_server(("127.0.0.1", 0))  # accepts, and never says a word
        smtp = "django.core.mail.backends.smtp.EmailBackend"
        options = {"host": "127.0.0.1", "port": listener.getsockname()[1], "timeout": 1}
        try:
            # The real SMTP backend, which the test runner replaces (MAILERS on 6.1, EMAIL_BACKEND on 5.2).
            with self.settings(EMAIL_BACKEND=smtp, MAILERS={"default": {"BACKEND": smtp, "OPTIONS": options}}):
                connection = notifications.smtp_connection()
                with self.assertRaises(smtplib.SMTPServerDisconnected) as raised:
                    connection.open()
        finally:
            listener.close()
        self.assertEqual(classify(raised.exception), "timeout")

    def test_without_a_host_email_is_off(self):
        result = self.load()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["enabled"])

    def test_settings_that_cannot_work_are_refused_without_showing_the_password(self):
        cases = (
            ({"SENTINEL_SMTP_SECURITY": "none"}, "would send the SMTP credentials unencrypted"),
            ({"SENTINEL_SMTP_SECURITY": "ssl"}, "SENTINEL_SMTP_SECURITY must be one of"),
            ({"SENTINEL_SMTP_USER": ""}, "SENTINEL_SMTP_PASSWORD is set without SENTINEL_SMTP_USER"),
            ({"SENTINEL_SMTP_TIMEOUT": "61"}, "SENTINEL_SMTP_TIMEOUT must be between 1 and 60"),
            ({"SENTINEL_SMTP_PORT": "0"}, "SENTINEL_SMTP_PORT must be between"),
            ({"SENTINEL_EMAIL_FROM": "Sentinel <sentinel@example.com"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "a@example.com, b@example.com"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": ""}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "Ops: sentinel@example.com;"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "sentinel@example.com,"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "Sentinel <alerts@\u08a0\u0628.example>"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "j\u00f6rg@example.com"}, "SENTINEL_EMAIL_FROM must be one email address"),
            # Forms Django's SMTP backend sends differently, or not at all, from one release to the next.
            ({"SENTINEL_EMAIL_FROM": "Sentinel <sentinel@[192.0.2.1]>"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": '"Ops, team" <ops@example.com>'}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "Sentinel <a@example.com> (\u03a3)"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": "=?utf-8?q?a=3Bb?= <a@example.com>"}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_EMAIL_FROM": '"ops"@example.com'}, "SENTINEL_EMAIL_FROM must be one email address"),
            ({"SENTINEL_SMTP_PASSWORD": "p\u00e4ssw\u00f6rd-" + SMTP_PASSWORD}, "must be ASCII"),
            ({"SENTINEL_CONSOLE_URL": "ftp://sentinel.example.com"}, "SENTINEL_CONSOLE_URL must start with"),
        )
        for changes, message in cases:
            with self.subTest(message=message):
                result = self.load(**{**self.SMTP, **changes})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn(SMTP_PASSWORD, result.stdout + result.stderr)


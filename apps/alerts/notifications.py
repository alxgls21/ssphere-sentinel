"""Incident emails: the outbox the alert engine fills and the notifier empties.

Email is optional and off unless ``SENTINEL_SMTP_HOST`` is set: without it the
engine records no notification at all, and incidents work as before.

Enqueue (the alert engine, in the transaction that opens or recovers an incident):
one ``Notification`` per subscribed console user who would be emailed about it now:
an active account with an email address and console access, whose subscription is
enabled and covers the incident's severity (and, for a recovery, asks for
recoveries), and who may see the incident's site. Opening and recovery are the only
steps that email; nothing is ever sent again as a reminder.

Deliver (the notifier, ``run_notifier``):

1. claim: in one short transaction, the due rows (pending and due, or sending with
   an expired lease) are locked with ``FOR UPDATE SKIP LOCKED``, so two notifiers
   never take the same row, and marked ``sending`` with this run's claim and a
   lease; rows older than ``SENTINEL_NOTIFICATION_MAX_AGE_HOURS`` are given up
   (``expired``) rather than sent late (and by the retention commands, should no
   notifier run any more: ``give_up_overdue``);
2. then recipient by recipient, just before their email, check again everything
   enqueue checked, read afresh (an account disabled, an address changed, a site
   access taken away, a subscription changed since): what no longer holds is
   ``cancelled``, with the reason;
3. send, outside any transaction: one email per recipient for everything due to
   them (at most ``MAX_PER_EMAIL`` incidents in one), through one SMTP connection
   per run with bounded timeouts;
4. record, in a short transaction per email, only on rows this run still holds:
   ``sent``; or, for a failure the SMTP server may get over, ``pending`` again after
   an exponential backoff (``MAX_ATTEMPTS`` at most, then ``failed``); or ``failed``
   for a final refusal (a 5xx answer to an email, a refused recipient). A failure
   of the connection itself, before or between emails, puts off the rest of the
   run the same way, as a failure that is tried again.

A run asked to stop (SIGTERM), or whose lease runs short, hands the rows it has not
tried back as ``pending``, before any email. Delivery is at least once: a notifier
killed between the SMTP server accepting an email and step 4 leaves the lease to
expire, and the email is sent again. Sent again about the same incident steps, it
has the same Message-ID, so a mail client can tell a duplicate (one regrouped with
other emails due by then is a new email).

Nothing here reads or writes SMTP credentials; they stay in the settings, taken from
the environment. Logs name users by id and failures by category, never an address,
a password or a server's message.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
import time
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.utils import parseaddr

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import mail
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.encoding import punycode

from apps.alerts.models import (
    DeliveryFailure,
    Incident,
    Notification,
    NotificationKind,
    NotificationSubscription,
    NotifierErrorCategory,
    NotifierHeartbeat,
    TestEmailFailure,
    TestEmailRequest,
)
from apps.console.access import USE_CONSOLE, Visibility

logger = logging.getLogger("apps.alerts.notifier")

BATCH = 100
# Seconds between the notifier's runs, by default (``run_notifier --interval``).
NOTIFIER_INTERVAL = 15
MAX_PER_EMAIL = 50
MAX_ATTEMPTS = 8
BACKOFF_BASE_SECONDS = 60
BACKOFF_CAP_SECONDS = 3600
# How long a run holds the rows it claimed. It begins no email in the last
# SEND_MARGIN, longer than one email can take (a few SMTP commands, each within
# SENTINEL_SMTP_TIMEOUT, at most a minute), and hands the rest back.
LEASE = timedelta(minutes=30)
SEND_MARGIN = timedelta(minutes=10)

# Failures the SMTP server or the way to it may get over: tried again after a while.
TEMPORARY = {
    DeliveryFailure.CONNECTION,
    DeliveryFailure.TIMEOUT,
    DeliveryFailure.TLS,
    DeliveryFailure.AUTHENTICATION,
    DeliveryFailure.DEFERRED,
    DeliveryFailure.INTERNAL,
}
# "Authentication required" (RFC 4954), whichever command it answers.
AUTHENTICATION_REQUIRED = 530
# Failures of the connection, not of one email: the rest of the run is put off too.
CONNECTION_LEVEL = {DeliveryFailure.CONNECTION, DeliveryFailure.TIMEOUT, DeliveryFailure.TLS, DeliveryFailure.AUTHENTICATION}



# Control characters, lone surrogates, and line and paragraph separators.
_UNSAFE = {"Cc", "Cs", "Zl", "Zp"}


def email_enabled() -> bool:
    return bool(settings.SENTINEL_SMTP_HOST)


def password_missing() -> bool:
    """A user name without its password: Django's backend would then send without logging in.

    Checked by the commands that send, not by the settings: every other process has the
    password blanked on purpose (compose.yml).
    """
    return bool(settings.SENTINEL_SMTP_USER) and not settings.SENTINEL_SMTP_PASSWORD


def smtp_connection():
    """Django's SMTP backend with the settings' options (``MAILERS``), not yet connected."""
    if hasattr(mail, "mailers"):  # Django 6.1 and later
        return mail.mailers.default
    return mail.get_connection(**settings.MAILERS["default"]["OPTIONS"])


# -- who is emailed ---------------------------------------------------------------


def why_not(user, subscription: NotificationSubscription | None, steps: list[tuple[Incident, str]]) -> list[str | None]:
    """For each (incident, kind) step: why ``user`` is not to be emailed about it now, or None.

    To be emailed: an active account with an address and console access (a
    superuser has every permission), a subscription that covers the step, and
    access to the incident's site, as the console grants it.
    """
    if user is None or not user.is_active or not user.email or not user.has_perm(USE_CONSOLE):
        return [DeliveryFailure.RECIPIENT_UNAVAILABLE] * len(steps)
    covered = [subscription is not None and subscription.covers(incident.severity, kind) for incident, kind in steps]
    wanted = {incident.pk for (incident, _), covers in zip(steps, covered) if covers}
    visible = (
        set(
            Visibility.for_user(user)
            .filter(Incident.objects.filter(pk__in=wanted), site_path="site")
            .values_list("pk", flat=True)
        )
        if wanted
        else set()
    )
    return [
        DeliveryFailure.UNSUBSCRIBED if not covers else None if incident.pk in visible else DeliveryFailure.NOT_VISIBLE
        for (incident, _), covers in zip(steps, covered)
    ]


def enqueue(incident: Incident, kind: str, *, at: datetime) -> int:
    """Record the emails ``kind`` of ``incident`` calls for; part of the caller's transaction."""
    if not email_enabled():
        return 0
    subscriptions = NotificationSubscription.objects.filter(enabled=True, user__is_active=True).select_related("user")
    recipients = [
        subscription.user
        for subscription in subscriptions.order_by("pk")
        if why_not(subscription.user, subscription, [(incident, kind)]) == [None]
    ]
    Notification.objects.bulk_create(
        [
            Notification(
                incident=incident,
                recipient=user,
                recipient_name=user.get_username(),
                kind=kind,
                created_at=at,
                next_attempt_at=at,
            )
            for user in recipients
        ],
        ignore_conflicts=True,
    )
    return len(recipients)


# -- delivery -------------------------------------------------------------------------


@dataclass
class DeliveryReport:
    claimed: int = 0
    sent: int = 0
    emails: int = 0
    retried: int = 0
    failed: int = 0
    cancelled: int = 0
    released: int = 0
    failures: dict[str, int] = field(default_factory=dict)
    # The failure of the connection that put off (part of) the run, and when: the SMTP
    # server was not to be had. When the run last reached it (and logged in).
    put_off: str | None = None
    put_off_at: datetime | None = None
    reached_at: datetime | None = None

    def note(self, failure: str, count: int) -> None:
        self.failures[failure] = self.failures.get(failure, 0) + count

    def __str__(self) -> str:
        failures = ", ".join(f"{count} {name}" for name, count in sorted(self.failures.items())) or "none"
        return (
            f"{self.sent} sent in {self.emails} email(s), {self.retried} to retry, {self.failed} failed, "
            f"{self.cancelled} not sent, {self.released} handed back; failures: {failures}"
        )


def classify(error: BaseException) -> str:
    """The category of a sending failure (see ``DeliveryFailure``)."""
    if isinstance(error, smtplib.SMTPRecipientsRefused):
        codes = [code for code, _ in error.recipients.values()]
        if AUTHENTICATION_REQUIRED in codes:
            return DeliveryFailure.AUTHENTICATION
        return DeliveryFailure.RECIPIENT_REFUSED if codes and all(500 <= code < 600 for code in codes) else DeliveryFailure.DEFERRED
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return DeliveryFailure.AUTHENTICATION
    if isinstance(error, smtplib.SMTPResponseException) and error.smtp_code == AUTHENTICATION_REQUIRED:
        return DeliveryFailure.AUTHENTICATION  # to MAIL FROM, without credentials (none were set)
    if isinstance(error, smtplib.SMTPServerDisconnected) and isinstance(error.__context__, TimeoutError):
        return DeliveryFailure.TIMEOUT  # connected, and no answer in time (smtplib reports it as a disconnection)
    # EHLO refused: without STARTTLS or credentials the first EHLO comes with the first email.
    if isinstance(error, (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected, smtplib.SMTPHeloError)):
        return DeliveryFailure.CONNECTION
    if isinstance(error, smtplib.SMTPNotSupportedError):
        # STARTTLS asked for and not offered, or AUTH (credentials are set) not offered.
        return DeliveryFailure.AUTHENTICATION if "AUTH" in str(error) else DeliveryFailure.TLS
    if isinstance(error, smtplib.SMTPResponseException):
        return DeliveryFailure.REJECTED if 500 <= error.smtp_code < 600 else DeliveryFailure.DEFERRED
    if isinstance(error, TimeoutError):
        return DeliveryFailure.TIMEOUT
    if isinstance(error, ssl.SSLError):
        return DeliveryFailure.TLS
    if type(error) is smtplib.SMTPException and "authentication" in str(error):
        return DeliveryFailure.AUTHENTICATION  # no authentication method in common with the server
    if isinstance(error, OSError):
        return DeliveryFailure.CONNECTION  # refused, unreachable, a name that does not resolve
    return DeliveryFailure.INTERNAL


def connection_failure(error: BaseException) -> str:
    """The category of a failure to open the connection: before any email, whatever the
    server said (a 4xx or 5xx to EHLO or STARTTLS too), it is about the connection, and
    the emails are tried again."""
    failure = classify(error)
    return failure if failure in CONNECTION_LEVEL else DeliveryFailure.CONNECTION


def backoff(attempts: int) -> timedelta:
    """The wait before attempt ``attempts + 1``: 1, 2, 4 ... minutes, at most an hour."""
    return timedelta(seconds=min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** max(attempts - 1, 0)))


def claim(now: datetime, limit: int = BATCH) -> tuple[uuid.UUID, list[int]]:
    """Take the due rows no other notifier holds; mark them sending, for this run."""
    token = uuid.uuid4()
    due = Q(status=Notification.Status.PENDING, next_attempt_at__lte=now) | Q(
        status=Notification.Status.SENDING, lease_expires_at__lte=now
    )
    with transaction.atomic():
        ids = list(
            Notification.objects.select_for_update(skip_locked=True)
            .filter(due)
            .order_by("next_attempt_at", "pk")
            .values_list("pk", flat=True)[:limit]
        )
        if ids:
            Notification.objects.filter(pk__in=ids).update(
                status=Notification.Status.SENDING,
                claim=token,
                lease_expires_at=now + LEASE,
                attempts=F("attempts") + 1,
                last_attempt_at=now,
            )
    return token, ids


def overdue(now: datetime) -> Q:
    """Rows still to be sent that no notifier will send: older than the maximum age, and held by no run."""
    oldest = now - timedelta(hours=settings.SENTINEL_NOTIFICATION_MAX_AGE_HOURS)
    return Q(created_at__lt=oldest) & (
        Q(status=Notification.Status.PENDING) | Q(status=Notification.Status.SENDING, lease_expires_at__lte=now)
    )


def give_up_overdue(now: datetime) -> int:
    """Mark the ``overdue`` rows ``failed`` (``expired``), as a notifier would when it took them.

    For the retention commands, which must not depend on a notifier running (it may
    never run again). The condition is checked again under each row's lock: a row a
    notifier has just claimed is left to it.
    """
    with transaction.atomic():
        return Notification.objects.filter(overdue(now)).update(
            status=Notification.Status.FAILED, failure=DeliveryFailure.EXPIRED, claim=None, lease_expires_at=None
        )


def _finish(rows: list[Notification], token: uuid.UUID, **changes) -> int:
    """Record an outcome on the rows this run still holds (a lease that expired is someone else's now)."""
    with transaction.atomic():
        return Notification.objects.filter(
            pk__in=[row.pk for row in rows], claim=token, status=Notification.Status.SENDING
        ).update(claim=None, lease_expires_at=None, **changes)


def _retry_or_fail(rows: list[Notification], token: uuid.UUID, failure: str, now: datetime, report: DeliveryReport) -> None:
    final = failure not in TEMPORARY
    with transaction.atomic():
        for row in rows:
            held = Notification.objects.filter(pk=row.pk, claim=token, status=Notification.Status.SENDING)
            if final or row.attempts >= MAX_ATTEMPTS:
                if held.update(claim=None, lease_expires_at=None, status=Notification.Status.FAILED, failure=failure):
                    report.failed += 1
            elif held.update(
                claim=None,
                lease_expires_at=None,
                status=Notification.Status.PENDING,
                failure=failure,
                next_attempt_at=now + backoff(row.attempts),
            ):
                report.retried += 1
    report.note(failure, len(rows))


def _clean(text: str) -> str:
    """No line break of any kind (U+2028 included), other control character or lone surrogate,
    which a name could hold, and which would end a header or make the email fail. Format
    characters (a zero-width joiner in a name or an emoji) stay."""
    return "".join(" " if unicodedata.category(char) in _UNSAFE else char for char in text).rstrip()


def _when(value: datetime | None) -> str:
    return value.strftime("%Y-%m-%d %H:%M UTC") if value else "-"


def _message_key(rows: list[Notification]) -> str:
    """The same incident steps to the same recipient, the same key: a resend can be told apart.

    Keyed with the installation's secret, and made of the incidents' random ids: it
    tells a recipient nothing about other emails, and differs between installations.
    """
    steps = "|".join(sorted(f"{row.incident_id}:{row.kind}:{row.recipient_id}" for row in rows))
    return salted_hmac("apps.alerts.notifications.message-id", steps, algorithm="sha256").hexdigest()[:32]


def _message_domain() -> str:
    domain = parseaddr(settings.SENTINEL_EMAIL_FROM)[1].rpartition("@")[2]
    try:
        return punycode(domain) if domain else "sentinel.invalid"
    except UnicodeError:
        return "sentinel.invalid"


def compose(rows: list[Notification], user) -> mail.EmailMessage:
    """One email to ``user`` about ``rows`` (theirs, already checked)."""
    opened = [row for row in rows if row.kind == NotificationKind.OPENED]
    recovered = [row for row in rows if row.kind == NotificationKind.RECOVERED]
    if len(rows) == 1:
        incident = rows[0].incident
        state = incident.severity.upper() if opened else "RECOVERED"
        subject = f"[Sentinel] {state}: {incident.rule.name} - {incident.entity_label}"
    else:
        parts = [f"{len(opened)} incident(s) opened"] if opened else []
        parts += [f"{len(recovered)} recovered"] if recovered else []
        subject = f"[Sentinel] {', '.join(parts)}"
    blocks = []
    for row in sorted(rows, key=lambda item: (item.kind != NotificationKind.OPENED, item.incident.opened_at, item.pk)):
        incident = row.incident
        site = f"{incident.site.customer.name} / {incident.site.name}" if incident.site_id else "no site"
        step = "OPENED" if row.kind == NotificationKind.OPENED else "RECOVERED"
        lines = [
            f"{step}  {incident.severity.upper()}  {incident.rule.name}",
            f"  Object:    {incident.entity_label} ({incident.get_entity_kind_display().lower()})",
            f"  Site:      {site}",
            f"  Started:   {_when(incident.started_at)}, opened {_when(incident.opened_at)}",
        ]
        if row.kind == NotificationKind.RECOVERED:
            lines.append(f"  Recovered: {_when(incident.recovered_at)}")
        if settings.SENTINEL_CONSOLE_URL:
            lines.append(f"  Details:   {settings.SENTINEL_CONSOLE_URL}/alerts/{incident.pk}")
        blocks.append("\n".join(_clean(line) for line in lines))
    body = "\n\n".join(blocks) + (
        "\n\n-- \nSent by SSphere Sentinel because you subscribed to incident emails. "
        "An administrator can change or stop them.\n"
    )
    message_id = f"<sentinel.{_message_key(rows)}@{_message_domain()}>"
    return mail.EmailMessage(
        subject=_clean(subject)[:200],
        body=body,
        from_email=settings.SENTINEL_EMAIL_FROM,
        to=[user.email],
        headers={"Message-ID": message_id, "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All"},
    )


def _recheck(recipient_id, rows: list[Notification], token: uuid.UUID, report: DeliveryReport):
    """Just before sending: the recipient as they are now, and which of ``rows`` they still get.

    The account, its permissions and address, its site access and the subscription
    are all read again here; the rows that no longer qualify are cancelled, with the
    reason.
    """
    user = get_user_model().objects.filter(pk=recipient_id).first()
    subscription = NotificationSubscription.objects.filter(user_id=recipient_id).first()
    reasons = why_not(user, subscription, [(row.incident, row.kind) for row in rows])
    cancelled: dict[str, list[Notification]] = defaultdict(list)
    for row, reason in zip(rows, reasons):
        if reason is not None:
            cancelled[reason].append(row)
    for reason, items in cancelled.items():
        report.cancelled += _finish(items, token, status=Notification.Status.CANCELLED, failure=reason)
        report.note(reason, len(items))
    return user, [row for row, reason in zip(rows, reasons) if reason is None]


def _release(rows: list[Notification], token: uuid.UUID, now: datetime) -> int:
    """Hand back rows this run took and did not try: due again at once, the claim not counted."""
    with transaction.atomic():
        return Notification.objects.filter(
            pk__in=[row.pk for row in rows], claim=token, status=Notification.Status.SENDING
        ).update(
            status=Notification.Status.PENDING,
            claim=None,
            lease_expires_at=None,
            attempts=F("attempts") - 1,
            next_attempt_at=now,
        )


def deliver(now: datetime, *, limit: int = BATCH, should_stop: Callable[[], bool] | None = None) -> DeliveryReport:
    """One notifier run: claim, check again, send, record (see the module docstring).

    ``should_stop`` is asked before each email; once it says so, the rest of the run
    is handed back for the next one. So is what is left when the lease runs short: a
    run never sends on rows another notifier could have claimed.
    """
    report = DeliveryReport()
    began = time.monotonic()
    token, ids = claim(now, limit)
    report.claimed = len(ids)
    if not ids:
        return report
    rows = list(
        Notification.objects.filter(pk__in=ids, claim=token)
        .select_related("incident__rule", "incident__site__customer")
        .order_by("pk")
    )
    oldest = now - timedelta(hours=settings.SENTINEL_NOTIFICATION_MAX_AGE_HOURS)
    expired = [row for row in rows if row.created_at < oldest]
    if expired:
        report.failed += _finish(expired, token, status=Notification.Status.FAILED, failure=DeliveryFailure.EXPIRED)
        report.note(DeliveryFailure.EXPIRED, len(expired))
    by_recipient: dict[object, list[Notification]] = defaultdict(list)
    for row in rows:
        if row.created_at >= oldest:
            by_recipient[row.recipient_id].append(row)
    if not by_recipient:
        return report

    # A new email is begun only while the lease leaves time for it to end.
    sending_time = (LEASE - SEND_MARGIN).total_seconds()

    def stopping() -> bool:
        return (should_stop is not None and should_stop()) or time.monotonic() - began >= sending_time

    connection = None
    put_off: str | None = None
    recipients = list(by_recipient.items())
    try:
        for position, (recipient_id, items) in enumerate(recipients):
            later = [row for _, left in recipients[position + 1 :] for row in left]
            if stopping():
                report.released += _release(items + later, token, now)
                break
            user, items = _recheck(recipient_id, items, token, report)
            if items and put_off is None and connection is None:
                connection = smtp_connection()
                try:
                    # One connection for the run (send_messages would open and close one per call).
                    connection.open()
                    report.reached_at = timezone.now()
                except Exception as error:  # noqa: BLE001 - recorded on every row it puts off
                    put_off, report.put_off_at = connection_failure(error), timezone.now()
                    logger.warning("SMTP server not available: %s; the emails of this run are put off", put_off)
            chunks = [items[start : start + MAX_PER_EMAIL] for start in range(0, len(items), MAX_PER_EMAIL)]
            stopped = False
            for index, chunk in enumerate(chunks):
                if put_off is not None:
                    _retry_or_fail(chunk, token, put_off, now, report)
                    continue
                if stopping():  # right before each email (the check above spares a run that stops the rest)
                    report.released += _release([row for rest in chunks[index:] for row in rest] + later, token, now)
                    stopped = True
                    break
                try:
                    if connection.send_messages([compose(chunk, user)]) != 1:
                        raise RuntimeError("the SMTP backend sent nothing")  # internal
                except Exception as error:  # noqa: BLE001 - every failure is recorded on its rows
                    failure = classify(error)
                    logger.warning(
                        "email to user %s about %d incident step(s) not sent: %s", recipient_id, len(chunk), failure
                    )
                    _retry_or_fail(chunk, token, failure, now, report)
                    if failure in CONNECTION_LEVEL:
                        # The server is not to be had: the rest waits for the next try.
                        put_off, report.put_off_at = failure, timezone.now()
                    continue
                report.reached_at = timezone.now()
                report.sent += _finish(chunk, token, status=Notification.Status.SENT, sent_at=report.reached_at, failure="")
                report.emails += 1
            if stopped:
                break
    finally:
        report.put_off = put_off
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - a connection that broke is closed already
                pass
    return report


# -- test emails (asked for in the console, sent here) ----------------------------------

SEND_TEST_EMAIL = "alerts.send_test_email"
# At most one a minute per user, one open at a time, and given up after ten minutes.
TEST_EMAIL_EVERY = timedelta(minutes=1)
TEST_EMAIL_EXPIRY = timedelta(minutes=10)
TEST_EMAIL_BATCH = 20
# How long a run holds a test email, from the moment it begins sending it (the lease is
# taken again then): longer than one email can take, a dozen SMTP replies within
# SENTINEL_SMTP_TIMEOUT (at most a minute) each.
TEST_EMAIL_LEASE = timedelta(minutes=15)


def test_message(address: str) -> mail.EmailMessage:
    """The test email, from ``send_test_email`` or a console request: it names the server, never a credential."""
    server = f"{settings.SENTINEL_SMTP_HOST}:{settings.SENTINEL_SMTP_PORT} ({settings.SENTINEL_SMTP_SECURITY})"
    return mail.EmailMessage(
        subject="[Sentinel] Test email",
        body=(
            f"This is a test email from SSphere Sentinel, sent at {timezone.now():%Y-%m-%d %H:%M UTC} "
            f"through {server}.\n\nIncident emails will come from this address.\n"
        ),
        from_email=settings.SENTINEL_EMAIL_FROM,
        to=[address],
        headers={"Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All"},
    )


def test_email_refusal(user) -> str | None:
    """Why ``user`` may not have a test email now (``TestEmailFailure``), or None."""
    if user is None or not user.is_active or not user.email or not user.has_perm(USE_CONSOLE):
        return TestEmailFailure.RECIPIENT_UNAVAILABLE
    if not user.has_perm(SEND_TEST_EMAIL):
        return TestEmailFailure.NOT_PERMITTED
    return None


def expire_test_emails(now: datetime, *, user_id=None) -> int:
    """Give up the test emails no notifier sent in time: pending past ``expires_at``, or held by
    a run whose lease ran out (it stopped mid-send; a test email is never sent twice)."""
    requests = TestEmailRequest.objects.all() if user_id is None else TestEmailRequest.objects.filter(requested_by_id=user_id)
    ended = {"status": TestEmailRequest.Status.EXPIRED, "failure": TestEmailFailure.EXPIRED, "finished_at": now}
    with transaction.atomic():
        count = requests.filter(status=TestEmailRequest.Status.PENDING, expires_at__lte=now).update(**ended)
        count += requests.filter(status=TestEmailRequest.Status.SENDING, lease_expires_at__lte=now).update(
            claim=None, lease_expires_at=None, **ended
        )
    return count


@dataclass
class TestEmailReport:
    claimed: int = 0
    sent: int = 0
    failed: int = 0
    cancelled: int = 0
    released: int = 0
    # As for DeliveryReport.
    put_off: str | None = None
    put_off_at: datetime | None = None
    reached_at: datetime | None = None

    def __str__(self) -> str:
        return (
            f"{self.sent} test email(s) sent, {self.failed} failed, {self.cancelled} not sent, "
            f"{self.released} handed back"
        )


def _end_test_email(row: TestEmailRequest, token: uuid.UUID, status: str, failure: str = "") -> int:
    with transaction.atomic():
        return TestEmailRequest.objects.filter(pk=row.pk, claim=token, status=TestEmailRequest.Status.SENDING).update(
            status=status, failure=failure, claim=None, lease_expires_at=None, finished_at=timezone.now()
        )


def deliver_test_emails(
    now: datetime, *, limit: int = TEST_EMAIL_BATCH, should_stop: Callable[[], bool] | None = None
) -> TestEmailReport:
    """Send the test emails asked for: claimed as the outbox is (``FOR UPDATE SKIP LOCKED``), each
    checked again just before it is sent, sent once to the account's address as it is then."""
    report = TestEmailReport()
    expire_test_emails(now)
    token = uuid.uuid4()
    with transaction.atomic():
        ids = list(
            TestEmailRequest.objects.select_for_update(skip_locked=True)
            .filter(status=TestEmailRequest.Status.PENDING, expires_at__gt=now)
            .order_by("created_at", "pk")
            .values_list("pk", flat=True)[:limit]
        )
        if ids:
            TestEmailRequest.objects.filter(pk__in=ids).update(
                status=TestEmailRequest.Status.SENDING, claim=token, lease_expires_at=now + TEST_EMAIL_LEASE
            )
    report.claimed = len(ids)
    if not ids:
        return report
    rows = list(TestEmailRequest.objects.filter(pk__in=ids, claim=token).order_by("created_at", "pk"))
    connection = None
    put_off: str | None = None
    try:
        for position, row in enumerate(rows):
            if should_stop is not None and should_stop():
                with transaction.atomic():
                    report.released = TestEmailRequest.objects.filter(
                        pk__in=[left.pk for left in rows[position:]], claim=token, status=TestEmailRequest.Status.SENDING
                    ).update(status=TestEmailRequest.Status.PENDING, claim=None, lease_expires_at=None)
                break
            user = get_user_model().objects.filter(pk=row.requested_by_id).first()
            refusal = test_email_refusal(user)
            if refusal is not None:
                report.cancelled += _end_test_email(row, token, TestEmailRequest.Status.CANCELLED, refusal)
                continue
            if put_off is None and connection is None:
                connection = smtp_connection()
                try:
                    connection.open()
                    report.reached_at = timezone.now()
                except Exception as error:  # noqa: BLE001 - recorded on each request it fails
                    put_off, report.put_off_at = connection_failure(error), timezone.now()
            failure = put_off
            if failure is None:
                # Held again from now: a slow server never lets another run (or the user's
                # page) take it for one that was not sent. Gone meanwhile: someone gave it up.
                with transaction.atomic():
                    held = TestEmailRequest.objects.filter(
                        pk=row.pk, claim=token, status=TestEmailRequest.Status.SENDING
                    ).update(lease_expires_at=timezone.now() + TEST_EMAIL_LEASE)
                if not held:
                    continue
                try:
                    if connection.send_messages([test_message(user.email)]) != 1:
                        raise RuntimeError("the SMTP backend sent nothing")  # internal
                except Exception as error:  # noqa: BLE001 - recorded on the request, by category
                    failure = classify(error)
                    if failure in CONNECTION_LEVEL:
                        put_off, report.put_off_at = failure, timezone.now()
            if failure is None:
                report.reached_at = timezone.now()
                report.sent += _end_test_email(row, token, TestEmailRequest.Status.SENT)
            else:
                logger.warning("test email for user %s not sent: %s", row.requested_by_id, failure)
                report.failed += _end_test_email(row, token, TestEmailRequest.Status.FAILED, failure)
    finally:
        report.put_off = put_off
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - a connection that broke is closed already
                pass
    return report


# -- the notifier's heartbeat ----------------------------------------------------------


def _configured() -> dict:
    """What the notifier's own settings say: whether email is on, and whether it logs in. Never the values."""
    return {
        "server_configured": email_enabled(),
        "authentication_configured": bool(settings.SENTINEL_SMTP_USER and settings.SENTINEL_SMTP_PASSWORD),
    }


def server_events(reached_at: datetime | None, error_at: datetime | None, error: str | None) -> dict:
    """The heartbeat's fields for what a cycle saw of the SMTP server: only what happened."""
    fields = {}
    if reached_at is not None:
        fields["server_reached_at"] = reached_at
    if error_at is not None:
        fields["server_error_at"] = error_at
        fields["server_error_category"] = error if error in NotifierErrorCategory.values else DeliveryFailure.CONNECTION
    return fields


def record_notifier_beat(
    now: datetime, *, started_at: datetime, interval: int, duration_ms: int, server: dict | None = None
) -> None:
    """A completed cycle, and what it saw of the SMTP server (``server_events``)."""
    NotifierHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "beat_at": now,
            "active_at": now,
            "last_cycle_ms": duration_ms,
            "interval_seconds": interval,
            **(server or {}),
            **_configured(),
        },
    )


def record_notifier_failure(
    now: datetime, *, started_at: datetime, interval: int, error: BaseException, server: dict | None = None
) -> None:
    """A failed cycle: when, its kind and the exception's type (its message could carry a
    value); and what it saw of the SMTP server before it failed."""
    from apps.alerts.engine import error_category  # the engine imports this module

    NotifierHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "interval_seconds": interval,
            "active_at": now,
            "last_error_at": now,
            "last_error_category": error_category(error),
            "last_error_type": type(error).__name__[:100],
            **(server or {}),
            **_configured(),
        },
    )


def record_notifier_activity(now: datetime, *, started_at: datetime, interval: int) -> None:
    """A sign of life: at the start of a cycle and, now and then, between its emails."""
    NotifierHeartbeat.objects.update_or_create(
        pk=1, defaults={"started_at": started_at, "interval_seconds": interval, "active_at": now, **_configured()}
    )

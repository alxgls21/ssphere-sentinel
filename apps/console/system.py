"""The system's status: ``GET /system/status/``, read-only.

Who: ``console.view_system_status`` and global visibility (``view_all_customers``, or a
superuser), else 403: its counts concern every customer.

::

    {"generatedAt",
     "alertEngine": EngineStatus (as /alerts/engine-status/, without generatedAt),
     "notifier": NotifierStatus,
     "outbox": {"pending": int, "sending": int, "oldestPendingAt": str | null, "overdue": int,
                "last24Hours": {"created": int, "sent": int, "failed": int, "cancelled": int,
                                "failures": {category: int}},
                "testEmails": {"open": int, "last24Hours": {status: int}}},
     "environment": {
         "email": {"enabled": bool, "host": str | null, "port": int, "security": starttls | tls | none,
                   "fromAddress": str | null, "timeoutSeconds": int, "maxAgeHours": int,
                   "consoleUrl": str | null},
         "retention": {"incidentDays", "notificationDays", "networkMeasurementDays", "snmpDays",
                       "telemetryDays", "absentContainerDays": int},
         "monitoring": {"offlineThresholdSeconds": int, "thresholds": {...as /session/}}}}

NotifierStatus::

    {"state": running | failed | stale | never_started | disabled, "stale": bool,
     "staleAfterSeconds": int, "intervalSeconds": int | null, "startedAt": str | null,
     "lastSuccessAt": str | null, "lastAttemptAt": str | null, "lastActiveAt": str | null,
     "lastSmtpSuccessAt": str | null, "lastCycleMs": int | null,
     "lastError": {"at", "category": database | internal} | null,
     "lastSmtpError": {"at", "category": connection | timeout | tls | authentication} | null,
     "smtpConfigured": bool | null, "authenticationConfigured": bool | null}

    disabled       email is off here (no SMTP server set): nothing is queued, nothing to send
    running        its latest cycle succeeded, and it is active
    failed         it is active, and its latest cycle failed (``lastError``: its database,
                   or an internal error), or the SMTP server it could not reach or log in
                   to (``lastSmtpError``) has not been reached since, however many cycles
                   found nothing to send meanwhile (its emails wait, and are tried again)
    stale          no sign of life for longer than ``staleAfterSeconds``, or no cycle ended
                   for longer than the longest a cycle can take: stopped, or stuck
    never_started  it has not ended a cycle yet

``lastActiveAt`` is its latest sign of life: a cycle's start or end, and now and then
between the emails of a long cycle. ``lastSmtpSuccessAt`` and ``lastSmtpError`` are when
it last reached the SMTP server, and when it last could not (and why), as they happened.

``smtpConfigured`` and ``authenticationConfigured`` are what the notifier itself
reported (the web process does not hold the SMTP password): whether an SMTP server is
set, and whether it logs in to it; null before its first cycle. ``environment`` is what
the deployment sets (``.env``), shown here and changed there. Never a password, an SMTP
user name, or any other secret.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.conf import settings
from django.db.models import Count, Min
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts.models import Notification, NotifierErrorCategory, NotifierHeartbeat, TestEmailRequest
from apps.alerts.notifications import LEASE, NOTIFIER_INTERVAL, TEST_EMAIL_LEASE, email_enabled
from apps.console.http import console_api
from apps.console.incidents import engine_status_payload
from apps.console.params import QueryParams
from apps.console.permissions import may_view_system_status, require
from apps.console.serializers import iso
from apps.console.thresholds import thresholds
from apps.infrastructure.liveness import offline_threshold_seconds

HEARTBEAT_FIELDS = (
    "started_at",
    "beat_at",
    "active_at",
    "server_reached_at",
    "server_error_at",
    "server_error_category",
    "last_cycle_ms",
    "interval_seconds",
    "last_error_at",
    "last_error_category",
    "server_configured",
    "authentication_configured",
)


def _iso(value: datetime | None) -> str | None:
    return iso(value) if value is not None else None


def notifier_status_payload(now: datetime) -> dict:
    beat = NotifierHeartbeat.objects.filter(pk=1).values(*HEARTBEAT_FIELDS).first()
    known = beat is not None
    beat = beat or dict.fromkeys(HEARTBEAT_FIELDS)
    interval = beat["interval_seconds"] or NOTIFIER_INTERVAL
    # The notifier's own liveness budget (run_notifier): two intervals and a long email.
    stale_after = 2 * interval + 600
    success, failure = beat["beat_at"], beat["last_error_at"]
    attempts = [moment for moment in (success, failure) if moment is not None]
    attempt = max(attempts) if attempts else None
    signs = [moment for moment in (attempt, beat["active_at"]) if moment is not None]
    active = max(signs) if signs else None
    # Alive between emails, yet no cycle ended for longer than one can take: stuck.
    longest_cycle = stale_after + (LEASE + TEST_EMAIL_LEASE).total_seconds()
    stale = (
        active is None
        or (now - active).total_seconds() > stale_after
        or (attempt is not None and (now - attempt).total_seconds() > longest_cycle)
    )
    # The notifier itself: until a cycle completes. The SMTP server: until it is reached again.
    failed = failure is not None and (success is None or failure >= success)
    server_error, server_reached = beat["server_error_at"], beat["server_reached_at"]
    failed = failed or (server_error is not None and (server_reached is None or server_error >= server_reached))
    if not email_enabled():
        state = "disabled"
    elif attempt is None:
        state = "never_started"
    elif stale:
        state = "stale"
    elif failed:
        state = "failed"
    else:
        state = "running"
    last_error = None
    if failure is not None:
        category = beat["last_error_category"]
        if category not in (NotifierErrorCategory.DATABASE, NotifierErrorCategory.INTERNAL):
            category = NotifierErrorCategory.INTERNAL
        last_error = {"at": iso(failure), "category": str(category)}
    last_smtp_error = None
    if server_error is not None:
        category = beat["server_error_category"]
        if category not in NotifierErrorCategory.values or category in ("database", "internal"):
            category = NotifierErrorCategory.CONNECTION
        last_smtp_error = {"at": iso(server_error), "category": str(category)}
    return {
        "state": state,
        "stale": stale,
        "staleAfterSeconds": stale_after,
        "intervalSeconds": beat["interval_seconds"],
        "startedAt": _iso(beat["started_at"]),
        "lastSuccessAt": _iso(success),
        "lastAttemptAt": _iso(attempt),
        "lastActiveAt": _iso(active),
        "lastSmtpSuccessAt": _iso(beat["server_reached_at"]),
        "lastCycleMs": beat["last_cycle_ms"],
        "lastError": last_error,
        "lastSmtpError": last_smtp_error,
        "smtpConfigured": beat["server_configured"] if known else None,
        "authenticationConfigured": beat["authentication_configured"] if known else None,
    }


def outbox_payload(now: datetime) -> dict:
    """Counts only, each over an index: the open rows (partial indexes on pending and sending
    rows), and the last day's (``created_at``); never the whole retained history."""
    pending = Notification.objects.filter(status=Notification.Status.PENDING)
    sending = Notification.objects.filter(status=Notification.Status.SENDING)
    oldest = now - timedelta(hours=settings.SENTINEL_NOTIFICATION_MAX_AGE_HOURS)
    overdue = (
        pending.filter(created_at__lt=oldest).count()
        + sending.filter(created_at__lt=oldest, lease_expires_at__lte=now).count()
    )
    day = Notification.objects.filter(created_at__gte=now - timedelta(hours=24))
    last_day = {"created": 0, "sent": 0, "failed": 0, "cancelled": 0, "failures": {}}
    for row in day.order_by().values("status", "failure").annotate(n=Count("pk")):
        last_day["created"] += row["n"]
        if row["status"] in ("sent", "failed", "cancelled"):
            last_day[row["status"]] += row["n"]
        if row["status"] in ("failed", "cancelled") and row["failure"]:
            last_day["failures"][row["failure"]] = last_day["failures"].get(row["failure"], 0) + row["n"]
    tests = {
        row["status"]: row["n"]
        for row in TestEmailRequest.objects.filter(created_at__gte=now - timedelta(hours=24))
        .order_by()
        .values("status")
        .annotate(n=Count("pk"))
    }
    # Open: still to be sent. A request past its time is expired, whether or not a notifier
    # (or its user) has marked it yet.
    open_tests = (
        TestEmailRequest.objects.filter(status=TestEmailRequest.Status.PENDING, expires_at__gt=now).count()
        + TestEmailRequest.objects.filter(status=TestEmailRequest.Status.SENDING, lease_expires_at__gt=now).count()
    )
    return {
        "pending": pending.count(),
        "sending": sending.count(),
        "oldestPendingAt": _iso(pending.aggregate(oldest=Min("created_at"))["oldest"]),
        "overdue": overdue,
        "last24Hours": last_day,
        "testEmails": {
            "open": open_tests,
            "last24Hours": {str(status): tests.get(status, 0) for status in TestEmailRequest.Status},
        },
    }


def environment_payload() -> dict:
    enabled = email_enabled()
    return {
        "email": {
            "enabled": enabled,
            "host": settings.SENTINEL_SMTP_HOST or None,
            "port": settings.SENTINEL_SMTP_PORT,
            "security": settings.SENTINEL_SMTP_SECURITY,
            "fromAddress": settings.SENTINEL_EMAIL_FROM or None,
            "timeoutSeconds": settings.SENTINEL_SMTP_TIMEOUT,
            "maxAgeHours": settings.SENTINEL_NOTIFICATION_MAX_AGE_HOURS,
            "consoleUrl": settings.SENTINEL_CONSOLE_URL or None,
        },
        "retention": {
            "incidentDays": settings.SENTINEL_INCIDENT_RETENTION_DAYS,
            "notificationDays": settings.SENTINEL_NOTIFICATION_RETENTION_DAYS,
            "networkMeasurementDays": settings.SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS,
            "snmpDays": settings.SENTINEL_SNMP_RETENTION_DAYS,
            "telemetryDays": settings.SENTINEL_TELEMETRY_RETENTION_DAYS,
            "absentContainerDays": settings.SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS,
        },
        "monitoring": {"offlineThresholdSeconds": offline_threshold_seconds(), "thresholds": thresholds()},
    }


@console_api()
def system_status(request):
    now = timezone.now()
    require(may_view_system_status(request.user, request.visibility), "This account may not see the system status.")
    QueryParams(request, ())
    engine = engine_status_payload(now)
    engine.pop("generatedAt")
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "alertEngine": engine,
            "notifier": notifier_status_payload(now),
            "outbox": outbox_payload(now),
            "environment": environment_payload(),
        }
    )

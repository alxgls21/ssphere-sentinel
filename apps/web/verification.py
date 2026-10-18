"""The queue of domain verifications: asked for by the console, answered by the domain verifier.

* ``request_verification`` (the console, in its transaction) adds one, within the limits:
  one open per domain, ``DOMAIN_EVERY`` between two of a domain, ``USER_LIMIT`` per user
  in ``USER_WINDOW``, ``QUEUE_LIMIT`` open across all domains. Each refusal is a
  :class:`Refused` with the seconds to wait when waiting helps.
* ``claim`` (the verifier) takes the oldest open ones with ``FOR UPDATE SKIP LOCKED``:
  several verifiers can run at once, and a request whose verifier died is taken again
  once its lease has run out. Nothing is locked while the DNS is asked.
* ``finish`` records the answer, only while the claim still holds, and with it the
  domain's state and the configuration trail, in one transaction. A domain is
  verified by its first verification that finds the record; a later one that does
  not find it changes nothing but ``last_outcome`` (keeping a domain verified is the
  periodic verification's).
* ``expire_verifications``: a request no verifier took by ``expires_at`` expires.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from django.db import DatabaseError, transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.web import audit
from apps.web import dns_verification as dns
from apps.web.domains import record_value
from apps.web.models import (
    DomainStatus,
    DomainVerification,
    DomainVerifierHeartbeat,
    MonitoredDomain,
    VerificationDetail,
    VerifierErrorCategory,
)

VERIFICATION_EXPIRY = timedelta(minutes=10)
DOMAIN_EVERY = timedelta(seconds=10)
USER_LIMIT = 20
USER_WINDOW = timedelta(minutes=10)
QUEUE_LIMIT = 200
# Longer than any verification (its DNS deadline), with room for recording the answer.
LEASE = timedelta(seconds=dns.LIMITS.deadline + 60)
VERIFIER_INTERVAL = 2
STALE_AFTER = timedelta(seconds=dns.LIMITS.deadline + 60)


class Refused(Exception):
    def __init__(self, status: int, code: str, message: str, *, retry_after: int | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


@dataclass(frozen=True)
class Claimed:
    id: uuid.UUID
    claim: uuid.UUID
    domain_id: uuid.UUID
    domain: str
    token: str

    def values(self) -> list[str]:
        return [record_value(self.token)]


def _wait(until: datetime, now: datetime) -> int:
    return max(1, math.ceil((until - now).total_seconds()))


def expire_verifications(now: datetime, *, domain_id=None) -> int:
    """End the requests no verifier took in time (a running one once its lease has run out too)."""
    rows = DomainVerification.objects.filter(status__in=DomainVerification.OPEN, expires_at__lte=now).filter(
        Q(status=DomainVerification.Status.PENDING) | Q(lease_expires_at__lte=now)
    )
    if domain_id is not None:
        rows = rows.filter(domain_id=domain_id)
    return rows.update(
        status=DomainVerification.Status.EXPIRED,
        detail=VerificationDetail.EXPIRED,
        finished_at=now,
        claim=None,
        lease_expires_at=None,
    )


def request_verification(domain: MonitoredDomain, user, now: datetime) -> DomainVerification:
    """A new request for ``domain`` (locked by the caller's transaction), or :class:`Refused`."""
    expire_verifications(now, domain_id=domain.pk)
    if DomainVerification.objects.filter(domain=domain, status__in=DomainVerification.OPEN).exists():
        raise Refused(409, "verification_active", "A verification of this domain is already waiting or running.")
    latest = (
        DomainVerification.objects.filter(domain=domain).order_by("-created_at").values_list("created_at", flat=True).first()
    )
    if latest is not None and now - latest < DOMAIN_EVERY:
        raise Refused(
            429, "rate_limited", "This domain was verified a moment ago: try again shortly.",
            retry_after=_wait(latest + DOMAIN_EVERY, now),
        )
    recent = list(
        DomainVerification.objects.filter(requested_by=user, created_at__gt=now - USER_WINDOW)
        .order_by("-created_at")
        .values_list("created_at", flat=True)[:USER_LIMIT]
    )
    if len(recent) >= USER_LIMIT:
        raise Refused(
            429, "rate_limited", f"At most {USER_LIMIT} verifications every {USER_WINDOW.seconds // 60} minutes.",
            retry_after=_wait(recent[-1] + USER_WINDOW, now),
        )
    waiting = DomainVerification.objects.filter(status__in=DomainVerification.OPEN, expires_at__gt=now)
    if waiting.count() >= QUEUE_LIMIT:
        raise Refused(503, "queue_full", "Too many verifications are waiting: try again shortly.", retry_after=30)
    row = DomainVerification.objects.create(
        domain=domain,
        requested_by=user,
        requested_by_name=user.get_username(),
        created_at=now,
        expires_at=now + VERIFICATION_EXPIRY,
    )
    audit.verification_requested(user, domain, row)
    return row


def claim(now: datetime, *, limit: int) -> list[Claimed]:
    """Take up to ``limit`` open requests, oldest first (those whose lease ran out included)."""
    with transaction.atomic():
        rows = list(
            DomainVerification.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(status__in=DomainVerification.OPEN, expires_at__gt=now)
            .filter(Q(status=DomainVerification.Status.PENDING) | Q(lease_expires_at__lte=now))
            .select_related("domain")
            .order_by("created_at", "id")[:limit]
        )
        claimed = []
        for row in rows:
            token = uuid.uuid4()
            DomainVerification.objects.filter(pk=row.pk).update(
                status=DomainVerification.Status.RUNNING, claim=token, lease_expires_at=now + LEASE, started_at=now
            )
            claimed.append(Claimed(row.pk, token, row.domain_id, row.domain.name, row.domain.token))
    return claimed


def finish(claimed: Claimed, result: dns.Result, now: datetime) -> bool:
    """Record ``result``; False when the claim no longer holds (another verifier took the request)."""
    with transaction.atomic():
        # The domain first, as the console locks it before its verifications.
        domain = MonitoredDomain.objects.select_for_update(no_key=True).filter(pk=claimed.domain_id).first()
        row = (
            DomainVerification.objects.select_for_update(of=("self",))
            .filter(pk=claimed.id, claim=claimed.claim, status=DomainVerification.Status.RUNNING)
            .first()
        )
        if row is None or domain is None:
            return False
        before = audit.domain_values(domain)
        row.status = DomainVerification.Status.DONE
        row.outcome, row.detail, row.evidence = result.outcome, result.detail, result.evidence
        row.finished_at = now
        row.claim = row.lease_expires_at = None
        row.save(update_fields=["status", "outcome", "detail", "evidence", "finished_at", "claim", "lease_expires_at"])
        domain.last_checked_at = now
        domain.last_outcome = result.outcome
        fields = ["last_checked_at", "last_outcome", "version", "updated_at"]
        if result.outcome == dns.VERIFIED:
            # Found again, a domain that had lost its record has it back, its grace period over.
            domain.status = DomainStatus.VERIFIED
            domain.verified_at = domain.verified_at or now
            domain.last_verified_at = now
            domain.degraded_since = domain.grace_until = None
            fields += ["status", "verified_at", "last_verified_at", "degraded_since", "grace_until"]
        domain.version = F("version") + 1
        domain.updated_at = now
        domain.save(update_fields=fields)
        domain.refresh_from_db(fields=["version"])
        audit.verification_finished(domain, row, before)
    return True


# -- the verifier's heartbeat ------------------------------------------------------------


def record_verifier_beat(now: datetime, *, started_at: datetime, interval: int, duration_ms: int) -> None:
    DomainVerifierHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "beat_at": now,
            "last_cycle_ms": duration_ms,
            "interval_seconds": interval,
        },
    )


def record_verifier_failure(now: datetime, *, started_at: datetime, interval: int, error: BaseException) -> None:
    category = VerifierErrorCategory.DATABASE if isinstance(error, DatabaseError) else VerifierErrorCategory.INTERNAL
    DomainVerifierHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "interval_seconds": interval,
            "last_error_at": now,
            "last_error_category": category,
            "last_error_type": type(error).__name__[:100],
        },
    )


def verifier_state(now: datetime | None = None) -> str:
    """``never_started``, ``running``, ``failed`` (its last cycle failed) or ``stale`` (no cycle lately)."""
    now = now or timezone.now()
    beat = DomainVerifierHeartbeat.objects.filter(pk=1).first()
    if beat is None:
        return "never_started"
    if beat.last_error_at is not None and (beat.beat_at is None or beat.last_error_at > beat.beat_at):
        return "failed"
    if beat.beat_at is None:
        return "never_started"
    interval = timedelta(seconds=beat.interval_seconds or VERIFIER_INTERVAL)
    if now - beat.beat_at > 3 * interval + STALE_AFTER:
        return "stale"
    return "running"

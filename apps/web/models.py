"""Domains a customer has proved are theirs, before any of their websites is monitored.

    MonitoredDomain          a customer's domain, its verification token, and where its
                             verification stands. One per customer and domain: the same
                             domain may be another customer's too, each with its own token.
    DomainVerification       one request to verify a domain, and its answer: the queue
                             the domain verifier works from (``FOR UPDATE SKIP LOCKED``,
                             a claim and a lease), and the domain's history. At most one
                             per domain is open (pending or running) at a time.
    DomainVerifierHeartbeat  the verifier's last cycle, so a stopped verifier shows.

The web process never asks the DNS itself: it records the request, and the verifier
asks the domain's name servers (``apps.web.dns_verification``). The token is public
DNS material, not a credential. ``next_check_at``, ``degraded_since`` and
``grace_until`` are for the periodic verification that keeps a domain verified; nothing
sets them yet.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.db.models.functions import Lower

from apps.web import dns_verification as dns
from apps.web.domains import MAX_DISPLAY_LENGTH, MAX_LENGTH


class DomainStatus(models.TextChoices):
    PENDING = "pending", "Not verified yet"
    VERIFIED = "verified", "Verified"
    DEGRADED = "degraded", "Verification lost, in its grace period"
    SUSPENDED = "suspended", "Suspended"


class VerificationOutcome(models.TextChoices):
    VERIFIED = dns.VERIFIED, "Verified"
    ABSENT = dns.ABSENT, "Record not found"
    PROPAGATION_PENDING = dns.PROPAGATION_PENDING, "Name servers disagree"
    INDETERMINATE = dns.INDETERMINATE, "Could not be determined"


class VerificationDetail(models.TextChoices):
    FOUND = dns.FOUND, "Every name server that answered has the record"
    NOT_FOUND = dns.NOT_FOUND, "No name server that answered has the record"
    SERVERS_DISAGREE = dns.SERVERS_DISAGREE, "Some name servers have the record and some do not"
    INSUFFICIENT_COVERAGE = dns.INSUFFICIENT_COVERAGE, "Too few name servers answered"
    NO_NAMESERVERS = dns.NO_NAMESERVERS, "The domain's zone has no name servers"
    NO_PUBLIC_NAMESERVERS = dns.NO_PUBLIC_NAMESERVERS, "The name servers have no public address that can be used"
    TIMEOUT = dns.TIMEOUT, "The name servers did not answer in time"
    SERVER_FAILURE = dns.SERVER_FAILURE, "The name servers failed to answer (SERVFAIL)"
    REFUSED = dns.REFUSED, "The name servers refused to answer"
    NOT_AUTHORITATIVE = dns.NOT_AUTHORITATIVE, "The name servers' answers were not authoritative"
    NETWORK_ERROR = dns.NETWORK_ERROR, "The name servers could not be reached"
    MALFORMED_RESPONSE = dns.MALFORMED_RESPONSE, "The name servers' answers could not be read"
    ALIAS_LOOP = dns.ALIAS_LOOP, "The record's aliases (CNAME, DNAME) form a loop"
    TOO_MANY_ALIASES = dns.TOO_MANY_ALIASES, "The record is behind too many aliases"
    ALIAS_NOT_PUBLIC = dns.ALIAS_NOT_PUBLIC, "An alias of the record points to a name with no public DNS"
    QUERY_LIMIT = dns.QUERY_LIMIT, "Verifying it would take too many DNS questions"
    RESOLVER_FAILURE = dns.RESOLVER_FAILURE, "The servers of the domain's public suffix could not be found"
    INTERNAL_ERROR = dns.INTERNAL_ERROR, "The verifier failed"
    EXPIRED = "expired", "No verifier took the request in time"


class VerifierErrorCategory(models.TextChoices):
    DATABASE = "database", "Database"
    INTERNAL = "internal", "Internal error"


class MonitoredDomain(models.Model):
    """A customer's domain, verified (or not yet) by a TXT record the customer adds to its DNS.

    ``name`` is the canonical ASCII form (``apps.web.domains.normalize``), the key
    of uniqueness; ``display_name`` the Unicode form. ``version`` grows by one with
    each change. Who added it is kept as a name too, which outlives the account.
    """

    Status = DomainStatus

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    customer = models.ForeignKey("inventory.Customer", on_delete=models.PROTECT, related_name="monitored_domains")
    name = models.CharField(max_length=MAX_LENGTH, editable=False)
    display_name = models.CharField(max_length=MAX_DISPLAY_LENGTH, editable=False)
    token = models.CharField(max_length=64, unique=True, editable=False)
    token_created_at = models.DateTimeField()
    status = models.CharField(max_length=16, choices=DomainStatus.choices, default=DomainStatus.PENDING)
    # The first verification that found the record, and the latest.
    verified_at = models.DateTimeField(null=True, blank=True)
    last_verified_at = models.DateTimeField(null=True, blank=True)
    # The latest verification that ended, whatever it found.
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_outcome = models.CharField(max_length=24, choices=VerificationOutcome.choices, blank=True)
    # The periodic verification and its grace period.
    next_check_at = models.DateTimeField(null=True, blank=True)
    degraded_since = models.DateTimeField(null=True, blank=True)
    grace_until = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1, editable=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_by_name = models.CharField(max_length=150, editable=False)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        ordering = ["name", "id"]
        verbose_name = "monitored domain"
        verbose_name_plural = "monitored domains"
        default_permissions = ("add", "view")
        permissions = [("verify_monitoreddomain", "Can ask for a domain's verification")]
        constraints = [
            models.UniqueConstraint(
                fields=["customer", "name"],
                name="uniq_web_domain_per_customer",
                violation_error_message="This customer already has this domain.",
            ),
            models.CheckConstraint(condition=Q(status__in=DomainStatus.values), name="web_domain_status"),
            models.CheckConstraint(
                condition=Q(last_outcome="") | Q(last_outcome__in=VerificationOutcome.values),
                name="web_domain_last_outcome",
            ),
            # The canonical form only: lowercase ASCII, so equal domains are equal strings.
            models.CheckConstraint(condition=Q(name=Lower("name")) & ~Q(name=""), name="web_domain_name_canonical"),
            models.CheckConstraint(
                condition=~Q(status=DomainStatus.VERIFIED) | Q(verified_at__isnull=False),
                name="web_domain_verified_at",
            ),
        ]
        indexes = [
            # What the periodic verification will take, soonest first.
            models.Index(fields=["next_check_at"], condition=Q(next_check_at__isnull=False), name="web_domain_due"),
            models.Index(fields=["status"], name="web_domain_status_idx"),
        ]

    def __str__(self) -> str:
        return self.display_name


class DomainVerification(models.Model):
    """One verification of a domain: queued by the console, answered by the domain verifier.

    ``pending`` until a verifier claims it (``running``, with a claim and a lease),
    then ``done`` with an outcome and its detail, or ``expired`` when no verifier took
    it by ``expires_at``. ``evidence`` is what the name servers said, by category
    (``apps.web.dns_verification.Result``).
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Waiting"
        RUNNING = "running", "Running"
        DONE = "done", "Done"
        EXPIRED = "expired", "Expired"

    class Trigger(models.TextChoices):
        MANUAL = "manual", "Asked for"
        SCHEDULED = "scheduled", "Scheduled"

    Outcome = VerificationOutcome
    Detail = VerificationDetail
    OPEN = (Status.PENDING, Status.RUNNING)

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    domain = models.ForeignKey(MonitoredDomain, on_delete=models.CASCADE, related_name="verifications")
    trigger = models.CharField(max_length=16, choices=Trigger.choices, default=Trigger.MANUAL)
    # The record outlives the account; the name it had then stays.
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    requested_by_name = models.CharField(max_length=150, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    outcome = models.CharField(max_length=24, choices=VerificationOutcome.choices, blank=True)
    detail = models.CharField(max_length=32, choices=VerificationDetail.choices, blank=True)
    evidence = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    # While running: which verifier holds it, and until when.
    claim = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "domain verification"
        verbose_name_plural = "domain verifications"
        default_permissions = ("view",)
        constraints = [
            models.UniqueConstraint(
                fields=["domain"],
                condition=Q(status__in=["pending", "running"]),
                name="uniq_open_verification_per_domain",
                violation_error_message="A verification of this domain is still waiting.",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "running", "done", "expired"]), name="web_verification_status"
            ),
            models.CheckConstraint(condition=Q(trigger__in=["manual", "scheduled"]), name="web_verification_trigger"),
            models.CheckConstraint(
                condition=Q(status="running", claim__isnull=False, lease_expires_at__isnull=False)
                | (~Q(status="running") & Q(claim__isnull=True, lease_expires_at__isnull=True)),
                name="web_verification_claimed_while_running",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "running"], finished_at__isnull=True, outcome="", detail="")
                | Q(status="done", finished_at__isnull=False, outcome__in=VerificationOutcome.values)
                & ~Q(detail="")
                | Q(status="expired", finished_at__isnull=False, outcome="", detail="expired"),
                name="web_verification_answer",
            ),
            models.CheckConstraint(
                condition=Q(detail="") | Q(detail__in=VerificationDetail.values), name="web_verification_detail"
            ),
            models.CheckConstraint(condition=Q(expires_at__gt=F("created_at")), name="web_verification_expires_later"),
        ]
        indexes = [
            # What the verifier claims, oldest first.
            models.Index(
                fields=["created_at"], condition=Q(status__in=["pending", "running"]), name="web_verification_open"
            ),
            models.Index(fields=["domain", "-created_at"], name="web_verification_by_domain"),
            # A user's recent requests (the rate limit).
            models.Index(fields=["requested_by", "-created_at"], name="web_verification_by_user"),
        ]

    def __str__(self) -> str:
        return f"{self.domain_id}: {self.get_status_display()}"


class DomainVerifierHeartbeat(models.Model):
    """The domain verifier's last cycle: one row, so a stopped verifier shows."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    # When the running verifier started, and when it last completed a cycle (never: null).
    started_at = models.DateTimeField()
    beat_at = models.DateTimeField(null=True, blank=True)
    last_cycle_ms = models.PositiveIntegerField(null=True, blank=True)
    # How often it looks for work: what makes a heartbeat late.
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    # The last failed cycle: when, its kind and the exception's type only.
    last_error_at = models.DateTimeField(null=True, blank=True)
    last_error_category = models.CharField(max_length=16, choices=VerifierErrorCategory.choices, blank=True)
    last_error_type = models.CharField(max_length=100, blank=True)

    class Meta:
        verbose_name = "domain verifier heartbeat"
        verbose_name_plural = "domain verifier heartbeat"
        default_permissions = ("view",)
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="domain_verifier_heartbeat_single_row"),
            models.CheckConstraint(
                condition=Q(last_error_category="") | Q(last_error_category__in=VerifierErrorCategory.values),
                name="domain_verifier_error_category",
            ),
        ]

    def __str__(self) -> str:
        return "domain verifier heartbeat"

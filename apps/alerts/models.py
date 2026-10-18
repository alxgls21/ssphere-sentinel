"""Alert rules, their evaluation, and the incidents they raise.

The lifecycle, and where each part of it lives:

    AlertRule             what to watch: a kind of object, a health condition
                          (optionally narrowed to one reason), a severity, how
                          long the condition must hold before an incident opens
                          (activation) and how long recovery must hold before it
                          closes (recovery), and an optional customer or site.
    AlertEvaluationState  one row per rule and object while something is going
                          on: ``pending`` (the condition holds, not yet for the
                          activation time), ``firing`` (an incident is open),
                          ``recovering`` (an incident is open, recovery is being
                          confirmed) or ``suppressed`` (the condition holds, but
                          is a consequence of another open incident, e.g. a
                          target whose agent's server is offline). No row: the
                          condition does not hold.
    Incident              ``active``, then possibly ``acknowledged`` (still
                          open: acknowledging resolves nothing), then
                          ``recovered`` (recovery confirmed) or ``closed``
                          (monitoring of it ended without a recovery: removed,
                          disabled or stopped, moved, out of scope, rule
                          disabled or changed). Both ends are final. A later
                          failure opens a new incident.
    IncidentEvent         what happened to an incident, in order.
    AlertEngineHeartbeat  when the evaluator last completed a cycle, so a
                          stopped evaluator is visible rather than silent.

At most one incident per rule and object is open: a partial unique index, so
the database itself refuses a duplicate however it is attempted. Unknown or
missing monitoring data is never a recovery: a recovery is something observed.

Visibility follows the console's (``apps.console.access``): an incident has the
site its object was on when it opened, and that never changes. An object that
moves to another site closes its open incident (``entity_moved``) and a new one
opens there, so an incident is only ever seen by those who may see the site it
happened on, and an object's past never follows it to its new owner. Incidents
of objects on no site are visible to users who may see every customer only.

Monitored objects are referred to by kind and reference (``conditions``), not
by foreign key: history outlives the object, and this app depends on no other
monitoring app's tables. Customers and sites are foreign keys (``PROTECT``, as
everywhere else: nothing is deleted implicitly, history included).

Nothing here holds a secret; database triggers are not used.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator
from django.db import models, transaction
from django.db.models import F, Q
from django.db.models.functions import Lower

from apps.alerts.conditions import (
    HEALTH,
    MATCHES,
    REASONS,
    EntityKind,
    HealthCondition,
    Severity,
    entity_ref_q,
    reasons_for,
    rule_condition_q,
)

MAX_DURATION_SECONDS = 86_400


class AlertRule(models.Model):
    """When an object's health is a condition for long enough, open an incident."""

    class Condition(models.TextChoices):
        # What the rule tests. Metric thresholds would be another condition with
        # fields of their own; only health is evaluated.
        HEALTH = "health", "Health"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Set on the rules Sentinel installs, so they are recognized; null on the rest.
    key = models.CharField(max_length=64, unique=True, null=True, blank=True, editable=False)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    enabled = models.BooleanField(default=True)
    entity_kind = models.CharField("object kind", max_length=16, choices=EntityKind.choices)
    condition = models.CharField(max_length=16, choices=Condition.choices, default=Condition.HEALTH)
    health = models.CharField(max_length=16, choices=HealthCondition.choices)
    reason = models.CharField(
        max_length=32,
        blank=True,
        help_text="Only this reason for the status (as the console names it). Empty: any.",
    )
    severity = models.CharField(max_length=16, choices=Severity.choices)
    activation_seconds = models.PositiveIntegerField(
        "activation (seconds)",
        default=60,
        validators=[MaxValueValidator(MAX_DURATION_SECONDS)],
        help_text="How long the condition must hold before an incident opens.",
    )
    recovery_seconds = models.PositiveIntegerField(
        "recovery (seconds)",
        default=120,
        validators=[MaxValueValidator(MAX_DURATION_SECONDS)],
        help_text="How long a recovery must hold before the incident closes. Missing data never counts.",
    )
    # Scope: every object (neither), a customer's sites, or one site. Objects on
    # no site are only in the scope of a rule without one.
    customer = models.ForeignKey(
        "inventory.Customer",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="alert_rules",
    )
    site = models.ForeignKey(
        "inventory.Site",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="alert_rules",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # One more on every save, from the console or the admin: a change the console
    # sends with an older version is refused rather than overwriting this one.
    version = models.PositiveIntegerField(default=1, editable=False)

    class Meta:
        ordering = ["name"]
        verbose_name = "alert rule"
        verbose_name_plural = "alert rules"
        constraints = [
            models.UniqueConstraint(
                Lower("name"),
                name="uniq_alert_rule_name_ci",
                violation_error_message="An alert rule with this name already exists.",
            ),
            models.CheckConstraint(
                condition=Q(entity_kind__in=EntityKind.values),
                name="alert_rule_entity_kind",
            ),
            models.CheckConstraint(
                condition=Q(condition="health", health__in=HealthCondition.values),
                name="alert_rule_health_condition",
            ),
            models.CheckConstraint(
                condition=Q(severity__in=Severity.values),
                name="alert_rule_severity",
            ),
            models.CheckConstraint(
                condition=rule_condition_q(),
                name="alert_rule_condition_fits",
                violation_error_message="This condition, or this reason, can never fire for this kind of object.",
            ),
            models.CheckConstraint(
                condition=Q(activation_seconds__lte=MAX_DURATION_SECONDS, recovery_seconds__lte=MAX_DURATION_SECONDS),
                name="alert_rule_durations",
            ),
            models.CheckConstraint(
                condition=Q(customer__isnull=True) | Q(site__isnull=True),
                name="alert_rule_one_scope",
                violation_error_message="Choose a customer or a site, not both.",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    def clean(self) -> None:
        if isinstance(self.name, str):
            self.name = self.name.strip()
        errors = {}
        known = REASONS.get(self.entity_kind)
        fits = reasons_for(self.entity_kind, self.health)
        if known is not None and self.health in MATCHES:
            if not fits:
                errors["health"] = "Objects of this kind never have this status."
            elif self.reason and self.reason not in known:
                errors["reason"] = f"Not a reason the console gives for this kind: {', '.join(known)}."
            elif self.reason and self.reason not in fits:
                errors["reason"] = f"This reason never comes with that status. For this condition: {', '.join(fits)}."
        if self.customer_id and self.site_id:
            errors["site"] = "Choose a customer or a site, not both."
        if not self._state.adding:
            stored = AlertRule.objects.filter(pk=self.pk).values_list("entity_kind", flat=True).first()
            if stored is not None and stored != self.entity_kind:
                # Its incidents and evaluation states are about objects of that kind.
                errors["entity_kind"] = "The kind of a rule cannot be changed. Disable it and add a new rule."
        if errors:
            raise ValidationError(errors)

    def save(self, *args, **kwargs):
        # Validated on every save (like the inventory), so nothing bypasses the admin's checks.
        self.full_clean()
        if self._state.adding:
            return super().save(*args, **kwargs)
        # In the database, so that two saves never write the same version.
        self.version = F("version") + 1
        if kwargs.get("update_fields") is not None:
            kwargs["update_fields"] = {*kwargs["update_fields"], "version"}
        super().save(*args, **kwargs)
        self.refresh_from_db(fields=["version"])


class IncidentQuerySet(models.QuerySet):
    def open(self):
        return self.filter(status__in=Incident.OPEN)


class ImmutableIncident(ValueError):
    """A change to what an incident is about, or to an incident that has ended."""


class CloseReason(models.TextChoices):
    """Why an incident ended without a recovery."""

    ENTITY_REMOVED = "entity_removed", "The object no longer exists"
    ENTITY_DISABLED = "entity_disabled", "The object was disabled or stopped"
    ENTITY_MOVED = "entity_moved", "The object moved to another site"
    OUT_OF_SCOPE = "out_of_scope", "The object left the rule's scope"
    RULE_DISABLED = "rule_disabled", "The rule was disabled"
    RULE_CHANGED = "rule_changed", "The rule's condition or severity changed"


class Incident(models.Model):
    """One occurrence of a rule's condition on one object, from opening to its end."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ACKNOWLEDGED = "acknowledged", "Acknowledged"
        RECOVERED = "recovered", "Recovered"
        CLOSED = "closed", "Closed"

    CloseReason = CloseReason

    OPEN = (Status.ACTIVE, Status.ACKNOWLEDGED)
    ENDED = (Status.RECOVERED, Status.CLOSED)
    # Fixed when the incident opens.
    IDENTITY = (
        "rule_id",
        "entity_kind",
        "entity_ref",
        "entity_label",
        "site_id",
        "condition_health",
        "condition_reason",
        "severity",
        "started_at",
        "opened_at",
    )
    # Fixed once it has ended, as well.
    OUTCOME = ("status", "acknowledged_at", "acknowledged_by_id", "recovered_at", "closed_at", "close_reason")

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # PROTECT: a rule with history is disabled, not deleted.
    rule = models.ForeignKey(AlertRule, on_delete=models.PROTECT, related_name="incidents")
    entity_kind = models.CharField(max_length=16, choices=EntityKind.choices)
    entity_ref = models.CharField(max_length=128)
    # The object's name when the incident opened (it may be renamed or deleted later).
    entity_label = models.CharField(max_length=255)
    # The site the object was on when the incident opened: who may see it. Never changes.
    site = models.ForeignKey(
        "inventory.Site",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="incidents",
        # Covered by the (site, -opened_at) index.
        db_index=False,
    )
    # The rule's condition and severity when it opened: what this incident is about,
    # whatever the rule says later (a change to them ends the incident).
    condition_health = models.CharField(max_length=16, choices=HealthCondition.choices)
    condition_reason = models.CharField(max_length=32, blank=True)
    severity = models.CharField(max_length=16, choices=Severity.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    # When the condition began to hold, and when it had held for the activation time.
    started_at = models.DateTimeField()
    opened_at = models.DateTimeField()
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    acknowledged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    # Recovered: when the recovery that was confirmed began. Ended (either way): closed_at.
    recovered_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    close_reason = models.CharField(max_length=32, choices=CloseReason.choices, blank=True)

    objects = IncidentQuerySet.as_manager()

    class Meta:
        ordering = ["-opened_at"]
        verbose_name = "incident"
        verbose_name_plural = "incidents"
        default_permissions = ("view",)
        permissions = [("acknowledge_incident", "Can acknowledge incidents in the console")]
        constraints = [
            # Deduplication: one open incident per rule and object.
            models.UniqueConstraint(
                fields=["rule", "entity_kind", "entity_ref"],
                condition=Q(status__in=["active", "acknowledged"]),
                name="uniq_open_incident_per_rule_entity",
            ),
            models.CheckConstraint(condition=entity_ref_q(), name="incident_entity_ref"),
            models.CheckConstraint(condition=Q(severity__in=Severity.values), name="incident_severity"),
            models.CheckConstraint(
                condition=Q(condition_health__in=HealthCondition.values),
                name="incident_condition_health",
            ),
            # Open exactly while it has not ended (this also fixes the statuses).
            models.CheckConstraint(
                condition=Q(status__in=["active", "acknowledged"], closed_at__isnull=True)
                | Q(status__in=["recovered", "closed"], closed_at__isnull=False),
                name="incident_open_until_closed",
            ),
            models.CheckConstraint(
                condition=Q(status="recovered", recovered_at__isnull=False)
                | (~Q(status="recovered") & Q(recovered_at__isnull=True)),
                name="incident_recovered_at",
            ),
            models.CheckConstraint(
                condition=Q(status="closed", close_reason__in=CloseReason.values)
                | (~Q(status="closed") & Q(close_reason="")),
                name="incident_close_reason",
            ),
            models.CheckConstraint(
                condition=Q(status="active", acknowledged_at__isnull=True)
                | Q(status="acknowledged", acknowledged_at__isnull=False)
                | Q(status__in=["recovered", "closed"]),
                name="incident_acknowledged_at",
            ),
            models.CheckConstraint(
                condition=Q(acknowledged_by__isnull=True) | Q(acknowledged_at__isnull=False),
                name="incident_acknowledged_by",
            ),
            models.CheckConstraint(
                condition=Q(opened_at__gte=F("started_at"))
                & (Q(acknowledged_at__isnull=True) | Q(acknowledged_at__gte=F("opened_at")))
                & (Q(closed_at__isnull=True) | Q(closed_at__gte=F("opened_at")))
                & (
                    Q(recovered_at__isnull=True)
                    | Q(closed_at__isnull=False, recovered_at__gte=F("started_at"), recovered_at__lte=F("closed_at"))
                ),
                name="incident_time_order",
            ),
        ]
        indexes = [
            # Open incidents (small): the active list and the badge, by site or for everyone.
            models.Index(
                fields=["site", "-opened_at"],
                condition=Q(status__in=["active", "acknowledged"]),
                name="alerts_incident_open_site",
            ),
            # History by site (what a restricted user may see), and for everyone.
            models.Index(fields=["site", "-opened_at"], name="alerts_incident_site_recent"),
            models.Index(fields=["-opened_at"], name="alerts_incident_recent"),
            # One object's incidents (its detail page).
            models.Index(fields=["entity_kind", "entity_ref", "-opened_at"], name="alerts_incident_entity"),
            # Ended incidents, oldest first: what the retention removes.
            models.Index(fields=["closed_at"], condition=Q(closed_at__isnull=False), name="alerts_incident_ended"),
        ]

    def __str__(self) -> str:
        return f"{self.rule.name}: {self.entity_label}"

    @property
    def is_open(self) -> bool:
        return self.status in self.OPEN

    def matches_rule(self, rule: AlertRule) -> bool:
        """The rule still has the condition and severity this incident opened under."""
        return (self.condition_health, self.condition_reason, self.severity) == (rule.health, rule.reason, rule.severity)

    def save(self, *args, **kwargs):
        if not self._state.adding:
            stored = Incident.objects.filter(pk=self.pk).values(*self.IDENTITY, *self.OUTCOME).first()
            if stored is not None:
                changed = [name for name in self.IDENTITY if getattr(self, name) != stored[name]]
                if changed:
                    raise ImmutableIncident(f"what an incident is about cannot change: {', '.join(changed)}")
                if stored["status"] in self.ENDED and any(getattr(self, name) != stored[name] for name in self.OUTCOME):
                    raise ImmutableIncident("an incident that has ended cannot change")
        return super().save(*args, **kwargs)

    # -- lifecycle: each step is one conditional update, so it applies once and
    # only from a state it is allowed from (an ended incident matches none).

    @classmethod
    def begin(
        cls,
        *,
        rule: AlertRule,
        entity_kind: str,
        entity_ref: str,
        entity_label: str,
        site_id,
        started_at,
        opened_at,
        health: str = "",
        reason: str = "",
    ) -> Incident:
        """Open an incident (``IntegrityError`` if one is already open for the rule and object)."""
        with transaction.atomic():
            incident = cls.objects.create(
                rule=rule,
                entity_kind=entity_kind,
                entity_ref=entity_ref,
                entity_label=entity_label,
                site_id=site_id,
                condition_health=rule.health,
                condition_reason=rule.reason,
                severity=rule.severity,
                started_at=started_at,
                opened_at=opened_at,
            )
            IncidentEvent.objects.create(
                incident=incident, kind=IncidentEvent.Kind.OPENED, at=opened_at, health=health, reason=reason
            )
        return incident

    def _transition(self, allowed, changes: dict, event: dict) -> bool:
        with transaction.atomic():
            if not Incident.objects.filter(pk=self.pk, status__in=allowed).update(**changes):
                return False
            IncidentEvent.objects.create(incident_id=self.pk, **event)
        self.refresh_from_db(fields=list(changes))
        return True

    def acknowledge(self, user, *, at) -> bool:
        """Mark an active incident as seen by ``user``. It stays open; False if it is not active."""
        return self._transition(
            (self.Status.ACTIVE,),
            {"status": self.Status.ACKNOWLEDGED, "acknowledged_at": at, "acknowledged_by": user},
            {"kind": IncidentEvent.Kind.ACKNOWLEDGED, "at": at, "actor": user, "actor_name": user.get_username()},
        )

    def recover(self, *, recovered_at, at, health: str = "", reason: str = "") -> bool:
        """End an open incident whose recovery, begun at ``recovered_at``, has been confirmed at ``at``."""
        return self._transition(
            self.OPEN,
            {"status": self.Status.RECOVERED, "recovered_at": recovered_at, "closed_at": at},
            {"kind": IncidentEvent.Kind.RECOVERED, "at": at, "health": health, "reason": reason},
        )

    def close(self, reason: str, *, at) -> bool:
        """End an open incident without a recovery (see ``CloseReason``)."""
        if reason not in self.CloseReason.values:
            raise ValueError(f"not a close reason: {reason!r}")
        return self._transition(
            self.OPEN,
            {"status": self.Status.CLOSED, "close_reason": reason, "closed_at": at},
            {"kind": IncidentEvent.Kind.CLOSED, "at": at},
        )


class EventKind(models.TextChoices):
    OPENED = "opened", "Opened"
    ACKNOWLEDGED = "acknowledged", "Acknowledged"
    RECOVERY_STARTED = "recovery_started", "Recovery observed"
    RECOVERY_INTERRUPTED = "recovery_interrupted", "Recovery interrupted"
    RECOVERED = "recovered", "Recovered"
    CLOSED = "closed", "Closed"


class IncidentEvent(models.Model):
    """One step in an incident's history."""

    Kind = EventKind

    # Each happens at most once to an incident; the recovery steps may repeat.
    ONCE = (Kind.OPENED, Kind.ACKNOWLEDGED, Kind.RECOVERED, Kind.CLOSED)

    id = models.BigAutoField(primary_key=True)
    incident = models.ForeignKey(
        Incident,
        on_delete=models.CASCADE,
        related_name="events",
        # Covered by the (incident, at) index.
        db_index=False,
    )
    kind = models.CharField(max_length=32, choices=EventKind.choices)
    at = models.DateTimeField()
    # The status and reason observed at that moment, where there was an observation.
    health = models.CharField(max_length=16, blank=True)
    reason = models.CharField(max_length=32, blank=True)
    # Who acknowledged; the name stays when the account is deleted.
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    actor_name = models.CharField(max_length=150, blank=True)

    class Meta:
        ordering = ["at", "id"]
        verbose_name = "incident event"
        verbose_name_plural = "incident events"
        default_permissions = ("view",)
        constraints = [
            models.UniqueConstraint(
                fields=["incident", "kind"],
                condition=Q(kind__in=["opened", "acknowledged", "recovered", "closed"]),
                name="uniq_incident_event_once",
            ),
            models.CheckConstraint(condition=Q(kind__in=EventKind.values), name="incident_event_kind"),
            models.CheckConstraint(condition=Q(health="") | Q(health__in=HEALTH), name="incident_event_health"),
            models.CheckConstraint(
                condition=Q(kind="acknowledged") | Q(actor__isnull=True, actor_name=""),
                name="incident_event_actor",
            ),
        ]
        indexes = [models.Index(fields=["incident", "at"], name="alerts_event_incident_at")]

    def __str__(self) -> str:
        return f"{self.get_kind_display()} at {self.at.isoformat()}"


class AlertEvaluationState(models.Model):
    """Where a rule stands with one object, while its condition holds or an incident is open."""

    class Phase(models.TextChoices):
        PENDING = "pending", "Pending"
        FIRING = "firing", "Firing"
        RECOVERING = "recovering", "Recovering"
        SUPPRESSED = "suppressed", "Suppressed"

    id = models.BigAutoField(primary_key=True)
    rule = models.ForeignKey(
        AlertRule,
        on_delete=models.CASCADE,
        related_name="evaluation_states",
        # Covered by the (rule, entity_kind, entity_ref) unique index.
        db_index=False,
    )
    entity_kind = models.CharField(max_length=16, choices=EntityKind.choices)
    entity_ref = models.CharField(max_length=128)
    phase = models.CharField(max_length=16, choices=Phase.choices)
    # The rule's condition this state was reached under (a change to it starts over).
    condition_health = models.CharField(max_length=16, choices=HealthCondition.choices)
    condition_reason = models.CharField(max_length=32, blank=True)
    # When the condition began to hold (kept through firing and recovering).
    condition_since = models.DateTimeField()
    # Recovering: when the recovery being confirmed began.
    recovering_since = models.DateTimeField(null=True, blank=True)
    # Firing or recovering: the open incident.
    incident = models.OneToOneField(
        Incident,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="evaluation_state",
    )
    # Suppressed: the open incident this is a consequence of.
    suppressed_by = models.ForeignKey(
        Incident,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="suppressed_states",
    )
    # What was last observed.
    last_health = models.CharField(max_length=16)
    last_reason = models.CharField(max_length=32, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "alert evaluation state"
        verbose_name_plural = "alert evaluation states"
        default_permissions = ("view",)
        constraints = [
            models.UniqueConstraint(
                fields=["rule", "entity_kind", "entity_ref"],
                name="uniq_alert_state_rule_entity",
            ),
            models.CheckConstraint(condition=entity_ref_q(), name="alert_state_entity_ref"),
            models.CheckConstraint(condition=Q(last_health__in=HEALTH), name="alert_state_last_health"),
            models.CheckConstraint(
                condition=Q(condition_health__in=HealthCondition.values),
                name="alert_state_condition_health",
            ),
            models.CheckConstraint(
                condition=Q(phase="pending", incident__isnull=True, suppressed_by__isnull=True, recovering_since__isnull=True)
                | Q(phase="firing", incident__isnull=False, suppressed_by__isnull=True, recovering_since__isnull=True)
                | Q(
                    phase="recovering",
                    incident__isnull=False,
                    suppressed_by__isnull=True,
                    recovering_since__isnull=False,
                    recovering_since__gte=F("condition_since"),
                )
                | Q(phase="suppressed", incident__isnull=True, suppressed_by__isnull=False, recovering_since__isnull=True),
                name="alert_state_phase",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.rule.name}: {self.entity_kind} {self.entity_ref} ({self.phase})"

    def matches_rule(self, rule: AlertRule) -> bool:
        """The rule still has the condition this state was reached under."""
        return (self.condition_health, self.condition_reason) == (rule.health, rule.reason)


class ErrorCategory(models.TextChoices):
    """What kind of failure stopped a cycle, as far as anyone outside the engine needs to know."""

    DATABASE = "database", "Database unavailable or refused the work"
    INTERNAL = "internal", "Internal error"


class AlertEngineHeartbeat(models.Model):
    """The evaluator's last completed cycle: one row, so a stopped evaluator shows."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    # When the running evaluator started, and when it last completed a cycle (never: null).
    started_at = models.DateTimeField()
    beat_at = models.DateTimeField(null=True, blank=True)
    last_cycle_ms = models.PositiveIntegerField(null=True, blank=True)
    # Since when Sentinel has been evaluating, and receiving heartbeats, without a
    # break; null while its ingest looks down. A silence (an offline server, a
    # missing measurement) is only counted from the offline threshold after it.
    monitoring_since = models.DateTimeField(null=True, blank=True)
    # How often the engine was started to evaluate: what makes a heartbeat late.
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    # The last failed cycle: when, its kind and the exception's type only (never a
    # message, which could carry a value).
    last_error_at = models.DateTimeField(null=True, blank=True)
    last_error_category = models.CharField(max_length=16, choices=ErrorCategory.choices, blank=True)
    last_error_type = models.CharField(max_length=100, blank=True)

    class Meta:
        verbose_name = "alert engine heartbeat"
        verbose_name_plural = "alert engine heartbeat"
        default_permissions = ("view",)
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="alert_engine_heartbeat_single_row"),
        ]

    def __str__(self) -> str:
        return f"Alert engine, last cycle {self.beat_at.isoformat() if self.beat_at else 'never'}"


class NotificationSubscription(models.Model):
    """A console user who is emailed about the incidents they may see in the console."""

    class MinSeverity(models.TextChoices):
        CRITICAL = "critical", "Critical incidents"
        WARNING = "warning", "Warning and critical incidents"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="alert_subscription")
    enabled = models.BooleanField(default=True)
    min_severity = models.CharField(
        "incidents", max_length=16, choices=MinSeverity.choices, default=MinSeverity.CRITICAL
    )
    send_recovery = models.BooleanField(
        "email recoveries too", default=False, help_text="Also email when an incident recovers."
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["user__username"]
        verbose_name = "email subscription"
        verbose_name_plural = "email subscriptions"
        constraints = [
            models.CheckConstraint(
                condition=Q(min_severity__in=["critical", "warning"]), name="alert_subscription_min_severity"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} ({self.get_min_severity_display().lower()})"

    def clean(self) -> None:
        # Checked again before every email: access and addresses change.
        user = self.user if self.user_id else None
        if user is not None:
            if not user.email:
                raise ValidationError({"user": "This user has no email address."})
            if not user.has_perm("console.use_console"):
                raise ValidationError({"user": "Only console users can receive incident emails."})

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    def covers(self, severity: str, kind: str) -> bool:
        """Whether this subscription asks for an email of ``kind`` about an incident of ``severity``."""
        if not self.enabled:
            return False
        if self.min_severity == self.MinSeverity.CRITICAL and severity != Severity.CRITICAL:
            return False
        return kind != NotificationKind.RECOVERED or self.send_recovery


class NotificationKind(models.TextChoices):
    OPENED = "opened", "Incident opened"
    RECOVERED = "recovered", "Incident recovered"


class DeliveryFailure(models.TextChoices):
    """Why an email has not been sent (yet), or will not be."""

    # The SMTP server or the way to it; tried again later.
    CONNECTION = "connection", "Could not connect to the SMTP server"
    TIMEOUT = "timeout", "The SMTP server did not answer in time"
    TLS = "tls", "TLS with the SMTP server failed"
    AUTHENTICATION = "authentication", "Authentication with the SMTP server failed"
    DEFERRED = "deferred", "The SMTP server refused it for now (4xx)"
    INTERNAL = "internal", "Internal error"
    # Final.
    REJECTED = "rejected", "The SMTP server refused it (5xx)"
    RECIPIENT_REFUSED = "recipient_refused", "The SMTP server refused the recipient"
    EXPIRED = "expired", "Not sent in time"
    # Not sent, on purpose: checked again just before sending.
    RECIPIENT_UNAVAILABLE = "recipient_unavailable", "The recipient is inactive, has no address or no console access"
    NOT_VISIBLE = "not_visible", "The recipient may no longer see the incident"
    UNSUBSCRIBED = "unsubscribed", "The recipient's subscription no longer asks for it"


class Notification(models.Model):
    """One email to send, about one step of one incident, to one console user: the outbox.

    Written by the alert engine in the transaction that changes the incident, so
    an incident step and its emails exist together or not at all; sent by the
    notifier, which claims rows with ``FOR UPDATE SKIP LOCKED`` and holds them
    (``sending``, with a claim and a lease) while it talks to the SMTP server
    outside any transaction. A notifier that dies mid-send leaves the lease to
    expire, and the email is sent again: delivery is at least once.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SENDING = "sending", "Sending"
        SENT = "sent", "Sent"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Not sent"

    ENDED = (Status.SENT, Status.FAILED, Status.CANCELLED)

    id = models.BigAutoField(primary_key=True)
    incident = models.ForeignKey(
        Incident,
        on_delete=models.CASCADE,
        related_name="notifications",
        # Covered by the (incident, recipient, kind) unique index.
        db_index=False,
    )
    # The record outlives the account (an email still to be sent is then not sent).
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    recipient_name = models.CharField(max_length=150)
    kind = models.CharField(max_length=16, choices=NotificationKind.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField()
    next_attempt_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    last_attempt_at = models.DateTimeField(null=True, blank=True)
    # While sending: which notifier holds it, and until when.
    claim = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    # The last failure, or why it was not sent.
    failure = models.CharField(max_length=32, choices=DeliveryFailure.choices, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "email notification"
        verbose_name_plural = "email notifications"
        default_permissions = ("view",)
        constraints = [
            # One email per incident step and recipient, however often the step is recorded.
            models.UniqueConstraint(fields=["incident", "recipient", "kind"], name="uniq_notification_per_step"),
            models.CheckConstraint(condition=Q(kind__in=NotificationKind.values), name="notification_kind"),
            models.CheckConstraint(
                condition=Q(status="sending", claim__isnull=False, lease_expires_at__isnull=False)
                | (~Q(status="sending") & Q(claim__isnull=True, lease_expires_at__isnull=True)),
                name="notification_claimed_while_sending",
            ),
            models.CheckConstraint(
                condition=Q(status="sent", sent_at__isnull=False) | (~Q(status="sent") & Q(sent_at__isnull=True)),
                name="notification_sent_at",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "sending", "sent"]) | (Q(status__in=["failed", "cancelled"]) & ~Q(failure="")),
                name="notification_says_why",
            ),
            models.CheckConstraint(
                condition=Q(failure="") | Q(failure__in=DeliveryFailure.values), name="notification_failure"
            ),
        ]
        indexes = [
            # What is due: the notifier's every claim.
            models.Index(
                fields=["next_attempt_at"], condition=Q(status="pending"), name="alerts_notification_due"
            ),
            models.Index(fields=["created_at"], name="alerts_notification_created"),
            # The rows being sent, and when their lease runs out (counted by the system status).
            models.Index(fields=["lease_expires_at"], condition=Q(status="sending"), name="alerts_notification_sending"),
            # The oldest pending rows first (the system status; what is overdue).
            models.Index(fields=["created_at"], condition=Q(status="pending"), name="alerts_notification_oldest"),
        ]

    def __str__(self) -> str:
        return f"{self.get_kind_display()} to {self.recipient_name} ({self.status})"


class TestEmailFailure(models.TextChoices):
    """Why a test email was not sent: what the SMTP server or the way to it did (as for
    ``DeliveryFailure``), or what the request found before sending."""

    CONNECTION = DeliveryFailure.CONNECTION.value, DeliveryFailure.CONNECTION.label
    TIMEOUT = DeliveryFailure.TIMEOUT.value, DeliveryFailure.TIMEOUT.label
    TLS = DeliveryFailure.TLS.value, DeliveryFailure.TLS.label
    AUTHENTICATION = DeliveryFailure.AUTHENTICATION.value, DeliveryFailure.AUTHENTICATION.label
    DEFERRED = DeliveryFailure.DEFERRED.value, DeliveryFailure.DEFERRED.label
    INTERNAL = DeliveryFailure.INTERNAL.value, DeliveryFailure.INTERNAL.label
    REJECTED = DeliveryFailure.REJECTED.value, DeliveryFailure.REJECTED.label
    RECIPIENT_REFUSED = DeliveryFailure.RECIPIENT_REFUSED.value, DeliveryFailure.RECIPIENT_REFUSED.label
    # Not sent, on purpose.
    EXPIRED = "expired", "No notifier sent it in time"
    RECIPIENT_UNAVAILABLE = "recipient_unavailable", "The account is inactive, has no address or no console access"
    NOT_PERMITTED = "not_permitted", "The account may no longer send test emails"


class TestEmailRequest(models.Model):
    """A console user's request for a test email to their own address: sent by the notifier.

    The web process never talks to the SMTP server (it does not hold the password):
    it records the request, and the notifier claims it (``FOR UPDATE SKIP LOCKED``),
    checks again that the account may have it, and sends it once to the address the
    account has then. Never to another address, and never twice: a failure is the
    answer the user waits for. A request no notifier has taken by ``expires_at``
    expires. At most one per user is open (pending or sending) at a time.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SENDING = "sending", "Sending"
        SENT = "sent", "Sent"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Not sent"
        EXPIRED = "expired", "Expired"

    OPEN = (Status.PENDING, Status.SENDING)
    ENDED = (Status.SENT, Status.FAILED, Status.CANCELLED, Status.EXPIRED)

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # The record outlives the account; the name it had then stays.
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    requested_by_name = models.CharField(max_length=150)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    # While sending: which notifier holds it, and until when.
    claim = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    failure = models.CharField(max_length=32, choices=TestEmailFailure.choices, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "test email"
        verbose_name_plural = "test emails"
        default_permissions = ("view",)
        permissions = [("send_test_email", "Can send a test email to themselves")]
        constraints = [
            models.UniqueConstraint(
                fields=["requested_by"],
                condition=Q(status__in=["pending", "sending"]),
                name="uniq_open_test_email_per_user",
                violation_error_message="A test email of this user is still waiting.",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "sending", "sent", "failed", "cancelled", "expired"]),
                name="test_email_status",
            ),
            models.CheckConstraint(
                condition=Q(status="sending", claim__isnull=False, lease_expires_at__isnull=False)
                | (~Q(status="sending") & Q(claim__isnull=True, lease_expires_at__isnull=True)),
                name="test_email_claimed_while_sending",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "sending"], finished_at__isnull=True)
                | Q(status__in=["sent", "failed", "cancelled", "expired"], finished_at__isnull=False),
                name="test_email_finished_at",
            ),
            models.CheckConstraint(
                condition=Q(status__in=["pending", "sending", "sent"], failure="")
                | (Q(status__in=["failed", "cancelled", "expired"]) & ~Q(failure="")),
                name="test_email_says_why",
            ),
            models.CheckConstraint(
                condition=Q(failure="") | Q(failure__in=TestEmailFailure.values), name="test_email_failure"
            ),
            models.CheckConstraint(condition=Q(expires_at__gt=F("created_at")), name="test_email_expires_later"),
        ]
        indexes = [
            # What the notifier claims, oldest first.
            models.Index(fields=["created_at"], condition=Q(status="pending"), name="alerts_test_email_due"),
            # The rate limit: a user's latest request.
            models.Index(fields=["requested_by", "-created_at"], name="alerts_test_email_by_user"),
        ]

    def __str__(self) -> str:
        return f"Test email for {self.requested_by_name} ({self.status})"


class NotifierErrorCategory(models.TextChoices):
    """What made a notifier's cycle fail: its database, itself, or the SMTP server (the way to it, or its login)."""

    DATABASE = ErrorCategory.DATABASE.value, ErrorCategory.DATABASE.label
    INTERNAL = ErrorCategory.INTERNAL.value, ErrorCategory.INTERNAL.label
    CONNECTION = DeliveryFailure.CONNECTION.value, DeliveryFailure.CONNECTION.label
    TIMEOUT = DeliveryFailure.TIMEOUT.value, DeliveryFailure.TIMEOUT.label
    TLS = DeliveryFailure.TLS.value, DeliveryFailure.TLS.label
    AUTHENTICATION = DeliveryFailure.AUTHENTICATION.value, DeliveryFailure.AUTHENTICATION.label


class NotifierHeartbeat(models.Model):
    """The notifier's last processing cycle: one row, so a stopped notifier shows (as the engine's does).

    Two kinds of failure, kept apart: of the notifier itself (its database, an internal
    error: ``last_error_*``, until a cycle completes), and of the SMTP server it could
    not reach or log in to (``server_error_*``, until it reaches the server again, however
    many cycles find nothing to send meanwhile). Each SMTP event is recorded at the time
    it happened, so a reach after a failure in the same cycle clears it.
    """

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    # When the running notifier started, and when it last completed a cycle (never: null).
    started_at = models.DateTimeField()
    beat_at = models.DateTimeField(null=True, blank=True)
    last_cycle_ms = models.PositiveIntegerField(null=True, blank=True)
    # How often it was started to look for work: what makes a heartbeat late.
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    # The last sign of life, also during a long cycle (between its emails).
    active_at = models.DateTimeField(null=True, blank=True)
    # The SMTP server: when it was last reached (and logged in to), and when it last could
    # not be, and why (connection, timeout, tls, authentication).
    server_reached_at = models.DateTimeField(null=True, blank=True)
    server_error_at = models.DateTimeField(null=True, blank=True)
    server_error_category = models.CharField(max_length=16, choices=NotifierErrorCategory.choices, blank=True)
    # The last failed cycle: when, its kind and the exception's type only.
    last_error_at = models.DateTimeField(null=True, blank=True)
    last_error_category = models.CharField(max_length=16, choices=NotifierErrorCategory.choices, blank=True)
    last_error_type = models.CharField(max_length=100, blank=True)
    # What the notifier's own settings say (the web process does not have the password):
    # whether an SMTP server is set, and whether it logs in to it. Never the values.
    server_configured = models.BooleanField(default=False)
    authentication_configured = models.BooleanField(default=False)

    class Meta:
        verbose_name = "notifier heartbeat"
        verbose_name_plural = "notifier heartbeat"
        default_permissions = ("view",)
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="notifier_heartbeat_single_row"),
        ]

    def __str__(self) -> str:
        return f"Notifier, last cycle {self.beat_at.isoformat() if self.beat_at else 'never'}"


class ConfigurationAction(models.TextChoices):
    RULE_CREATED = "rule_created", "Alert rule created"
    RULE_CHANGED = "rule_changed", "Alert rule changed"
    RULE_ENABLED = "rule_enabled", "Alert rule enabled"
    RULE_DISABLED = "rule_disabled", "Alert rule disabled"
    RULE_DELETED = "rule_deleted", "Alert rule deleted"
    SUBSCRIPTION_CHANGED = "subscription_changed", "Email subscription changed"
    SUBSCRIPTION_DELETED = "subscription_deleted", "Email subscription deleted"
    TEST_EMAIL_REQUESTED = "test_email_requested", "Test email requested"
    DOMAIN_CREATED = "domain_created", "Domain added"
    DOMAIN_VERIFICATION_REQUESTED = "domain_verification_requested", "Domain verification requested"
    DOMAIN_VERIFIED = "domain_verified", "Domain verified"
    DOMAIN_VERIFICATION_FAILED = "domain_verification_failed", "Domain verification failed"


class ConfigurationTarget(models.TextChoices):
    ALERT_RULE = "alert_rule", "Alert rule"
    SUBSCRIPTION = "subscription", "Email subscription"
    TEST_EMAIL = "test_email", "Test email"
    DOMAIN = "domain", "Monitored domain"


class ConfigurationSource(models.TextChoices):
    CONSOLE = "console", "Console"
    ADMIN = "admin", "Admin"
    # Removed with what it belonged to (a subscription, with its account): no actor is known.
    ACCOUNT_DELETED = "account_deleted", "Deleted with the account"
    # The answer to a request someone made (the actor): what the domain verifier found.
    VERIFIER = "verifier", "Domain verifier"


class ConfigurationEvent(models.Model):
    """One change of configuration, made in the console or the admin: an append-only trail.

    Who (the account, and the name it had then), how, what, on what, when, and the
    values before and after of the fields that changed. None of these objects holds
    a credential, and only their own fields are recorded (a domain's verification
    token never). Written in the transaction of the change itself, so a change and its
    record exist together or not at all. A domain verifier's answer is recorded with
    the account that asked for it.
    """

    Action = ConfigurationAction
    Target = ConfigurationTarget
    Source = ConfigurationSource

    id = models.BigAutoField(primary_key=True)
    at = models.DateTimeField()
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    actor_name = models.CharField(max_length=150)
    source = models.CharField(max_length=16, choices=ConfigurationSource.choices)
    action = models.CharField(max_length=32, choices=ConfigurationAction.choices)
    target_type = models.CharField(max_length=16, choices=ConfigurationTarget.choices)
    target_id = models.CharField(max_length=64)
    # The target's name then (a rule's name, a subscriber's user name).
    target_name = models.CharField(max_length=255)
    # {"field": {"before": value, "after": value}}, of the fields that changed.
    changes = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-at", "-id"]
        verbose_name = "configuration change"
        verbose_name_plural = "configuration changes"
        default_permissions = ("view",)
        constraints = [
            models.CheckConstraint(condition=Q(action__in=ConfigurationAction.values), name="configuration_event_action"),
            models.CheckConstraint(condition=Q(target_type__in=ConfigurationTarget.values), name="configuration_event_target"),
            models.CheckConstraint(condition=Q(source__in=ConfigurationSource.values), name="configuration_event_source"),
        ]
        indexes = [
            models.Index(fields=["at"], name="alerts_config_event_at"),
            models.Index(fields=["target_type", "target_id"], name="alerts_config_event_target"),
        ]

    def __str__(self) -> str:
        return f"{self.get_action_display()}: {self.target_name} by {self.actor_name}"

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValueError("a configuration event is never changed")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("a configuration event is never deleted")

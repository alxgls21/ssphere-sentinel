"""The alert engine: one evaluation of the alert rules against the console's health.

``evaluate(now, monitoring_since=...)`` is one cycle. What it decides follows from
``now``, the data and the states the previous cycle left, so the same inputs give
the same result; ``run_cycle`` adds the monitoring window and the heartbeat, and
``run_alert_engine`` runs cycles one after another.

For each rule and object, an observation (``observations``) is one of:

    match          the rule's condition holds
    clear          it does not, and the data shows it: a heartbeat, a measurement,
                   a poll, a Docker report
    indeterminate  nothing to go on: an unknown status, a transient one, or one that
                   says nothing about this condition. Missing data is never a
                   recovery, and never a failure.
    dormant        deliberately not monitored or not running: disabled, admin down,
                   stopped. An open incident ends (``entity_disabled``); it did not
                   recover.
    dependent      the rule would fire, but only because the object's monitoring
                   source is unavailable (its agent's server is offline, its host,
                   its device): suppressed, never an incident of its own.

and the state of the rule and the object moves on it:

    (none)      match -> pending, from when the condition began
    pending     match for the activation time -> an incident opens (firing);
                anything but a match -> forgotten (the condition must hold
                throughout)
    firing      clear -> recovering; anything else -> firing (unknown never recovers)
    recovering  clear for the recovery time -> the incident recovers;
                match, indeterminate or dependent -> firing again
    suppressed  while dependent and the source has an open incident; else forgotten

Durations are measured on the evidence, not on the evaluations: from the first
observation of the condition to one at least the activation time later (and the
same for a recovery). Evaluating the same measurement, poll or report again proves
nothing new, so a device polled every five minutes needs polls ten minutes apart to
be unreachable for ten minutes.

An incident also ends without a recovery: its object is gone (``entity_removed``),
left the rule's scope (``out_of_scope``), moved to another site (``entity_moved``,
and if the failure goes on, a new incident opens on the new site at once), or its
rule was disabled (``rule_disabled``) or now has another condition or severity
(``rule_changed``). Acknowledgements are never touched.

A silence (an offline server, a missing measurement) is only counted from the
offline threshold after ``monitoring_since``, the start of the window in which
Sentinel has been evaluating and receiving heartbeats without a break: after a
restart, or while its own ingest looks down, every agent first gets its chance to
report. That is what keeps an outage of Sentinel from becoming an incident for
every server it monitors.

Each change to one rule and object is one transaction: the state, the incident, its
event and the emails it calls for (``notifications``) together. The database refuses a second open incident for a rule and an
object, so two evaluators running at once cannot open one twice (``run_alert_engine``
also takes an advisory lock so that they do not).
"""

from __future__ import annotations

import enum
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from fractions import Fraction

import psycopg
from django.db import DatabaseError, DataError, IntegrityError, transaction
from django.db.models import Count, Q

from apps.agents.models import Agent
from apps.alerts.conditions import DORMANT, MATCHES, TRANSIENT, UNINFORMATIVE, EntityKind, HealthCondition
from apps.alerts.models import (
    AlertEngineHeartbeat,
    AlertEvaluationState,
    AlertRule,
    CloseReason,
    ErrorCategory,
    Incident,
    IncidentEvent,
    NotificationKind,
)
from apps.alerts.notifications import enqueue
from apps.alerts.observations import (
    Observation,
    observe_containers,
    observe_devices,
    observe_interfaces,
    observe_servers,
    observe_targets,
)
from apps.console.health import HEALTH_RANKS
from apps.infrastructure.liveness import offline_threshold_seconds

logger = logging.getLogger(__name__)

# Seconds between evaluations, unless the engine is started with another interval.
DEFAULT_INTERVAL = 30

# Upstream first: an incident that suppresses others is opened before they are looked at.
KIND_ORDER = (EntityKind.SERVER, EntityKind.CONTAINER, EntityKind.TARGET, EntityKind.DEVICE, EntityKind.INTERFACE)

# Sentinel's own ingest looks down when at least this many agents reported in the
# lookback and this share of them has been silent for the offline threshold: a
# failure of everything at once is Sentinel's (or its network's), not theirs.
OUTAGE_MIN_AGENTS = 3
OUTAGE_SILENT_SHARE = Fraction(9, 10)
OUTAGE_LOOKBACK = timedelta(hours=24)


class Verdict(enum.Enum):
    MATCH = "match"
    CLEAR = "clear"
    INDETERMINATE = "indeterminate"
    DORMANT = "dormant"
    DEPENDENT = "dependent"


def verdict(rule: AlertRule, obs: Observation) -> Verdict:
    """What ``obs`` says about ``rule``'s condition (see the module docstring)."""
    if (obs.kind, obs.reason) in DORMANT:
        return Verdict.DORMANT
    if rule.health == HealthCondition.UNKNOWN:
        if obs.health != "unknown":
            return Verdict.CLEAR
        if rule.reason and rule.reason != obs.reason:
            return Verdict.INDETERMINATE  # still without data, for another reason
        return Verdict.DEPENDENT if obs.upstream else Verdict.MATCH
    if obs.health == "unknown" or (obs.kind, obs.reason) in TRANSIENT:
        return Verdict.INDETERMINATE
    if rule.reason and obs.reason in UNINFORMATIVE.get((obs.kind, rule.reason), ()):
        return Verdict.INDETERMINATE
    if obs.health in MATCHES[rule.health] and (not rule.reason or rule.reason == obs.reason):
        return Verdict.MATCH
    return Verdict.CLEAR


def in_scope(rule: AlertRule, obs: Observation) -> bool:
    if rule.site_id is not None:
        return obs.site_id == rule.site_id
    if rule.customer_id is not None:
        return obs.customer_id == rule.customer_id
    return True


@dataclass
class Report:
    """What one cycle did."""

    monitoring: bool = True
    opened: int = 0
    recovered: int = 0
    closed: dict[str, int] = field(default_factory=dict)
    recovery_started: int = 0
    recovery_interrupted: int = 0
    skipped: int = 0  # changed by another evaluator first

    @property
    def changes(self) -> int:
        return self.opened + self.recovered + sum(self.closed.values()) + self.recovery_started + self.recovery_interrupted

    def __str__(self) -> str:
        closed = ", ".join(f"{count} {reason}" for reason, count in sorted(self.closed.items())) or "none"
        text = (
            f"opened {self.opened}, recovered {self.recovered}, closed: {closed}; "
            f"recovery started {self.recovery_started}, interrupted {self.recovery_interrupted}"
        )
        return f"{text}; {self.skipped} not recorded" if self.skipped else text


class Evaluation:
    def __init__(self, now: datetime, monitoring_since: datetime | None) -> None:
        self.now = now
        self.window = monitoring_since
        self.threshold = timedelta(seconds=offline_threshold_seconds())
        self.report = Report(monitoring=monitoring_since is not None)
        self.open_on: dict[tuple[str, str], object] = {}

    # -- the cycle -------------------------------------------------------------

    def run(self) -> Report:
        rules = list(AlertRule.objects.order_by("name", "pk"))
        self.end_disabled([rule for rule in rules if not rule.enabled])
        for kind in KIND_ORDER:
            kind_rules = [rule for rule in rules if rule.enabled and rule.entity_kind == kind]
            if kind_rules:
                self.evaluate_kind(kind, kind_rules)
        return self.report

    def end_disabled(self, rules: list[AlertRule]) -> None:
        ids = [rule.pk for rule in rules]
        if not ids:
            return
        for incident in Incident.objects.open().filter(rule_id__in=ids).order_by("opened_at", "pk"):
            with transaction.atomic():
                self.close_incident(incident, CloseReason.RULE_DISABLED)
                AlertEvaluationState.objects.filter(incident=incident).delete()
        AlertEvaluationState.objects.filter(rule_id__in=ids).delete()

    def evaluate_kind(self, kind: str, rules: list[AlertRule]) -> None:
        states = self.load_states(kind, rules)
        refs = {ref for _, ref in states}
        ranks = set().union(*(_ranks(rule) for rule in rules))
        if kind != EntityKind.SERVER:
            self.open_on = _open_incidents_by_entity()
        observed = self.observe(kind, rules, ranks, refs)
        for rule in rules:
            candidates = {ref for rule_id, ref in states if rule_id == rule.pk}
            candidates |= {
                ref
                for ref, obs in observed.items()
                if in_scope(rule, obs) and verdict(rule, obs) in (Verdict.MATCH, Verdict.DEPENDENT)
            }
            for ref in sorted(candidates):
                try:
                    with transaction.atomic():
                        self.step(rule, states.get((rule.pk, ref)), ref, observed.get(ref))
                except (IntegrityError, DataError) as exc:
                    # Another evaluator got there first, or this one object cannot be recorded:
                    # the others go on, and the next cycle starts from what is stored.
                    logger.warning("alert rule %s, %s %s: not recorded (%s)", rule.pk, kind, ref, type(exc).__name__)
                    self.report.skipped += 1

    def observe(self, kind: str, rules: list[AlertRule], ranks: set[int], refs: set[str]) -> dict[str, Observation]:
        if kind == EntityKind.SERVER:
            return observe_servers(self.now, ranks=ranks, refs=refs)
        if kind == EntityKind.CONTAINER:
            return observe_containers(self.now, ranks=ranks, refs=refs)
        if kind == EntityKind.TARGET:
            return observe_targets(self.now, ranks=ranks, refs=refs)
        if kind == EntityKind.DEVICE:
            return observe_devices(self.now, ranks=ranks, refs=refs)
        unknown = [rule for rule in rules if rule.health == HealthCondition.UNKNOWN]
        # Interfaces of devices with an open incident are read only to record what they suppress.
        suppressing = (
            [ref for (kind_, ref) in self.open_on if kind_ == EntityKind.DEVICE]
            if any(rule.reason in ("", "device_unavailable") for rule in unknown)
            else []
        )
        return observe_interfaces(
            self.now,
            down=any(rule.health != HealthCondition.UNKNOWN for rule in rules),
            unknown=bool(unknown),
            refs=refs,
            devices=suppressing,
        )

    def load_states(self, kind: str, rules: list[AlertRule]) -> dict[tuple[object, str], AlertEvaluationState]:
        """The rules' states, with one made for any open incident that has none (it is what the database says is open)."""
        ids = [rule.pk for rule in rules]
        states = {
            (state.rule_id, state.entity_ref): state
            for state in AlertEvaluationState.objects.filter(rule_id__in=ids).select_related("incident").order_by("pk")
        }
        held = {state.incident_id for state in states.values() if state.incident_id is not None}
        for incident in Incident.objects.open().filter(rule_id__in=ids).exclude(pk__in=held).order_by("opened_at", "pk"):
            state = states.get((incident.rule_id, incident.entity_ref)) or AlertEvaluationState(
                rule_id=incident.rule_id, entity_kind=kind, entity_ref=incident.entity_ref
            )
            state.phase = AlertEvaluationState.Phase.FIRING
            state.incident = incident
            state.suppressed_by = None
            state.recovering_since = None
            state.condition_health = incident.condition_health
            state.condition_reason = incident.condition_reason
            state.condition_since = incident.started_at
            state.last_health = state.last_health or "unknown"
            try:
                with transaction.atomic():
                    state.save()
            except IntegrityError:
                continue
            states[(incident.rule_id, incident.entity_ref)] = state
        return states

    # -- one rule and one object ------------------------------------------------

    def step(self, rule: AlertRule, state: AlertEvaluationState | None, ref: str, obs: Observation | None) -> None:
        if state is not None and state.incident_id is not None and not state.incident.is_open:
            state.delete()  # ended elsewhere
            state = None
        if obs is None:
            self.end(state, CloseReason.ENTITY_REMOVED)
            return
        if not in_scope(rule, obs):
            self.end(state, CloseReason.OUT_OF_SCOPE)
            return
        if state is not None:
            if state.incident_id is not None and not state.incident.matches_rule(rule):
                self.end(state, CloseReason.RULE_CHANGED)
                state = None
            elif state.incident_id is None and not state.matches_rule(rule):
                state.delete()
                state = None
        found = verdict(rule, obs)
        if state is not None and state.incident_id is not None and state.incident.site_id != obs.site_id:
            # Its incident stays with the site it happened on; the failure, if it goes on, is the new site's.
            self.end(state, CloseReason.ENTITY_MOVED)
            if found is Verdict.MATCH:
                self.open(rule, None, obs, started_at=self.now)
            return
        if found is Verdict.DORMANT:
            self.end(state, CloseReason.ENTITY_DISABLED)
            return
        phase = state.phase if state is not None else None
        if phase in (None, AlertEvaluationState.Phase.PENDING, AlertEvaluationState.Phase.SUPPRESSED):
            self.step_quiet(rule, state, obs, found)
        else:
            self.step_open(rule, state, obs, found)

    def step_quiet(self, rule: AlertRule, state: AlertEvaluationState | None, obs: Observation, found: Verdict) -> None:
        """No incident is open: pending, suppressed, or nothing yet."""
        if found is Verdict.DEPENDENT:
            cause = self.open_on.get(obs.upstream)
            if cause is None:
                if state is not None:
                    state.delete()
                return
            self.suppress(rule, state, obs, cause)
            return
        if state is not None and state.phase == AlertEvaluationState.Phase.SUPPRESSED:
            state.delete()  # its source is back, or the cause has ended: start over
            state = None
        if found is not Verdict.MATCH or not self.may_count(obs):
            if state is not None:
                state.delete()
            return
        if state is None:
            state = AlertEvaluationState.objects.create(
                rule=rule,
                entity_kind=obs.kind,
                entity_ref=obs.ref,
                phase=AlertEvaluationState.Phase.PENDING,
                condition_health=rule.health,
                condition_reason=rule.reason,
                condition_since=self.since(obs),
                last_health=obs.health,
                last_reason=obs.reason,
            )
        else:
            self.note(state, obs)
        if obs.evidence_at - state.condition_since >= timedelta(seconds=rule.activation_seconds):
            self.open(rule, state, obs, started_at=state.condition_since)

    def step_open(self, rule: AlertRule, state: AlertEvaluationState, obs: Observation, found: Verdict) -> None:
        """An incident is open: firing, or confirming a recovery."""
        recovering = state.phase == AlertEvaluationState.Phase.RECOVERING
        if found is not Verdict.CLEAR:
            if recovering:
                self.interrupt(state, obs)
            else:
                self.note(state, obs)
            return
        if not recovering:
            self.start_recovery(state, obs)
        if obs.evidence_at - state.recovering_since >= timedelta(seconds=rule.recovery_seconds):
            self.recover(state, obs)
        else:
            self.note(state, obs)

    # -- timing ------------------------------------------------------------------

    def may_count(self, obs: Observation) -> bool:
        """A silence counts only inside the monitoring window, from the offline threshold after its start."""
        if not obs.silence:
            return True
        return self.window is not None and self.now >= self.window + self.threshold

    def since(self, obs: Observation) -> datetime:
        """When the condition began, as far as the engine may count it."""
        began = obs.since or obs.evidence_at
        if obs.silence and self.window is not None:
            began = max(began, self.window + self.threshold)
        return began

    # -- transitions (each inside the caller's transaction) ------------------------

    def note(self, state: AlertEvaluationState, obs: Observation) -> None:
        if (state.last_health, state.last_reason) != (obs.health, obs.reason):
            state.last_health, state.last_reason = obs.health, obs.reason
            state.save(update_fields=["last_health", "last_reason", "updated_at"])

    def open(self, rule: AlertRule, state: AlertEvaluationState | None, obs: Observation, *, started_at: datetime) -> None:
        values = {
            "rule": rule,
            "entity_kind": obs.kind,
            "entity_ref": obs.ref,
            "entity_label": obs.label[:255],
            "site_id": obs.site_id,
            "started_at": min(started_at, self.now),
            "opened_at": self.now,
            "health": obs.health,
            "reason": obs.reason,
        }
        opened = False
        try:
            with transaction.atomic():
                incident = Incident.begin(**values)
            opened = True
        except IntegrityError:
            # Open already (another evaluator): one continuous failure is one incident.
            incident = Incident.objects.open().filter(rule=rule, entity_kind=obs.kind, entity_ref=obs.ref).first()
            if incident is None:
                raise
        if opened:
            self.report.opened += 1
            # Its emails exist with it or not at all: the same transaction.
            enqueue(incident, NotificationKind.OPENED, at=self.now)
        if state is None:
            state = AlertEvaluationState(rule=rule, entity_kind=obs.kind, entity_ref=obs.ref, condition_since=values["started_at"])
        state.phase = AlertEvaluationState.Phase.FIRING
        state.incident = incident
        state.suppressed_by = None
        state.recovering_since = None
        state.condition_health, state.condition_reason = rule.health, rule.reason
        state.last_health, state.last_reason = obs.health, obs.reason
        state.save()

    def suppress(self, rule: AlertRule, state: AlertEvaluationState | None, obs: Observation, cause) -> None:
        if state is None:
            AlertEvaluationState.objects.create(
                rule=rule,
                entity_kind=obs.kind,
                entity_ref=obs.ref,
                phase=AlertEvaluationState.Phase.SUPPRESSED,
                suppressed_by_id=cause,
                condition_health=rule.health,
                condition_reason=rule.reason,
                condition_since=obs.evidence_at,
                last_health=obs.health,
                last_reason=obs.reason,
            )
        elif state.phase != AlertEvaluationState.Phase.SUPPRESSED or state.suppressed_by_id != cause:
            state.phase = AlertEvaluationState.Phase.SUPPRESSED
            state.suppressed_by_id = cause
            state.condition_since = obs.evidence_at
            state.last_health, state.last_reason = obs.health, obs.reason
            state.save()

    def start_recovery(self, state: AlertEvaluationState, obs: Observation) -> None:
        state.phase = AlertEvaluationState.Phase.RECOVERING
        state.recovering_since = max(obs.evidence_at, state.condition_since)
        state.last_health, state.last_reason = obs.health, obs.reason
        state.save()
        IncidentEvent.objects.create(
            incident=state.incident, kind=IncidentEvent.Kind.RECOVERY_STARTED, at=self.now, health=obs.health, reason=obs.reason
        )
        self.report.recovery_started += 1

    def interrupt(self, state: AlertEvaluationState, obs: Observation) -> None:
        state.phase = AlertEvaluationState.Phase.FIRING
        state.recovering_since = None
        state.last_health, state.last_reason = obs.health, obs.reason
        state.save()
        IncidentEvent.objects.create(
            incident=state.incident, kind=IncidentEvent.Kind.RECOVERY_INTERRUPTED, at=self.now, health=obs.health, reason=obs.reason
        )
        self.report.recovery_interrupted += 1

    def recover(self, state: AlertEvaluationState, obs: Observation) -> None:
        incident = state.incident
        at = self.end_time(incident)
        began = min(max(state.recovering_since, incident.started_at), at)
        if incident.recover(recovered_at=began, at=at, health=obs.health, reason=obs.reason):
            self.report.recovered += 1
            enqueue(incident, NotificationKind.RECOVERED, at=at)
        state.delete()

    def end(self, state: AlertEvaluationState | None, reason: str) -> None:
        """Forget the state; close its incident, if one is open, for ``reason``."""
        if state is None:
            return
        if state.incident_id is not None:
            self.close_incident(state.incident, reason)
        state.delete()

    def close_incident(self, incident: Incident, reason: str) -> None:
        if incident.close(reason, at=self.end_time(incident)):
            self.report.closed[reason] = self.report.closed.get(reason, 0) + 1

    def end_time(self, incident: Incident) -> datetime:
        """``now``, or the incident's latest moment if a clock set back put it after now."""
        return max(self.now, incident.opened_at, incident.acknowledged_at or incident.opened_at)


def _ranks(rule: AlertRule) -> set[int]:
    """The console severities that could fire ``rule``."""
    return {HEALTH_RANKS[name] for name in MATCHES[rule.health]}


def _open_incidents_by_entity() -> dict[tuple[str, str], object]:
    """The open incident of each server and device that has one (the earliest), by kind and reference."""
    found = {}
    rows = (
        Incident.objects.open()
        .filter(entity_kind__in=(EntityKind.SERVER, EntityKind.DEVICE))
        .order_by("opened_at", "pk")
        .values_list("entity_kind", "entity_ref", "pk")
    )
    for kind, ref, pk in rows:
        found.setdefault((kind, ref), pk)
    return found


def evaluate(now: datetime, *, monitoring_since: datetime | None) -> Report:
    """One evaluation of every rule at ``now``. ``monitoring_since``: see the module docstring (None: ingest down)."""
    return Evaluation(now, monitoring_since).run()


# -- the monitoring window ---------------------------------------------------------


def ingest_silent(now: datetime) -> bool:
    """Sentinel's ingest looks down: nearly every agent that reported in the lookback has gone silent at once."""
    threshold = timedelta(seconds=offline_threshold_seconds())
    counts = Agent.objects.filter(enabled=True, last_seen_at__gte=now - OUTAGE_LOOKBACK).aggregate(
        total=Count("pk"), reporting=Count("pk", filter=Q(last_seen_at__gte=now - threshold))
    )
    total, silent = counts["total"], counts["total"] - counts["reporting"]
    return total >= OUTAGE_MIN_AGENTS and silent >= total * OUTAGE_SILENT_SHARE


def monitoring_window(now: datetime, previous: AlertEngineHeartbeat | None, *, gap: timedelta) -> datetime | None:
    """The start of the window in which silences count; None while the ingest looks down.

    The window starts again at ``now`` after a break: no completed cycle within
    ``gap`` (the engine was stopped, or every cycle failed, so an outage could have
    gone unseen), or the ingest just came back.
    """
    if ingest_silent(now):
        return None
    if previous is None or previous.beat_at is None or previous.monitoring_since is None:
        return now
    if now - previous.beat_at > gap:
        return now
    return previous.monitoring_since


def run_cycle(now: datetime, *, started_at: datetime, gap: timedelta, interval: int | None = None, clock=None) -> Report:
    """One evaluation with its window, then the heartbeat. ``clock`` measures the cycle (monotonic seconds)."""
    begun = clock() if clock else None
    previous = AlertEngineHeartbeat.objects.filter(pk=1).first()
    window = monitoring_window(now, previous, gap=gap)
    report = evaluate(now, monitoring_since=window)
    elapsed = round((clock() - begun) * 1000) if clock else None
    AlertEngineHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "beat_at": now,
            "last_cycle_ms": elapsed,
            "monitoring_since": window,
            "interval_seconds": interval,
        },
    )
    return report


def error_category(error: BaseException) -> str:
    """``database`` for a failure of the database or of the connection to it, else ``internal``."""
    return ErrorCategory.DATABASE if isinstance(error, (DatabaseError, psycopg.Error)) else ErrorCategory.INTERNAL


def record_failure(now: datetime, *, started_at: datetime, error: BaseException, interval: int | None = None) -> None:
    """A failed cycle: when, its kind and the exception's type (its message could carry a value)."""
    AlertEngineHeartbeat.objects.update_or_create(
        pk=1,
        defaults={
            "started_at": started_at,
            "interval_seconds": interval,
            "last_error_at": now,
            "last_error_category": error_category(error),
            "last_error_type": type(error).__name__[:100],
        },
    )

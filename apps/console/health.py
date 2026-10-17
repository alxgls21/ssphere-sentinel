"""Health of servers and containers, decided in SQL and in one place.

The UI's status vocabulary (``healthy``, ``warning``, ``critical``, ``unknown``,
``idle``) is computed by the database as a *severity rank* column, so a list
can filter, sort and count by it without loading rows, and the detail view,
the list, the counts and the filters can never disagree: they all read this one
expression. The rules mirror the UI's own (``frontend/src/lib/status.ts``):

Server (``annotate_servers``)
    * never reported (``last_seen_at`` is null) -> ``unknown`` (``never_seen``)
    * silent for longer than ``SENTINEL_OFFLINE_THRESHOLD`` -> ``critical``
      (``offline``; the same cutoff as ``apps.infrastructure.liveness``)
    * otherwise the worst of: a resource at or above the critical threshold
      -> ``critical``; at or above the warning threshold -> ``warning`` (both
      ``resources``), or a stored status of ``warning`` -> ``warning``
      (``status_warning``); else ``healthy`` (``ok``).
    * but resources only count while their reading is current (below), and a
      live server with no current reading has nothing to say about them:
      ``unknown`` (``no_telemetry``; a stored ``warning`` still stands).

    Resources are judged as displayed, rounded half up to a whole percent, so
    "95%" is never shown beside a healthy status because the raw value was 94.6
    (and 94.5 shows as 95, like ``Math.round`` in the UI).

Telemetry freshness
    Liveness (the last heartbeat) and the freshness of the resource reading are
    different facts: heartbeats go on when the telemetry section is missing,
    rejected or dropped by the agent, and the snapshot then describes the past.
    A reading is current while it arrived within ``SENTINEL_OFFLINE_THRESHOLD``
    seconds (inclusive) of ``now``: the window of liveness and of the Docker
    report, three heartbeat intervals by default, and the cadence of telemetry
    itself, which rides on every heartbeat. It is judged on the server's clock
    (``ServerTelemetry.received_at``), never the agent's ``collected_at``. A
    stale snapshot is kept and served as the last known reading; it is just not
    used for the current health, the status counts, or the load sorting.

Container (``annotate_containers``)
    A container is only as observable as its host: when the server has gone
    silent, its Docker is unavailable, or its Docker report has not been
    received within the same offline threshold (the heartbeat can go on while
    the Docker section is rejected or no longer sent), the stored state is
    last-known, not current, so it reads ``unknown`` (the UI's "state not
    reported by an offline host"; ``not_observable``). Otherwise: ``dead`` and an unhealthy running container are
    ``critical`` (``dead``, ``unhealthy``); ``restarting`` is ``warning``; a running container whose
    health check is still ``starting`` is ``idle`` (``starting``), and so are ``exited``, ``created``
    and ``paused`` (``stopped``: deliberately not running); a running container is ``healthy``
    (``running``); any other state is ``unknown`` (``other``).

    ``health_reason`` says which rule decided, for servers and containers as for
    targets and devices below.

Network target (``annotate_targets``), in this order, the first that holds:
    * disabled -> ``idle``
    * no agent assigned, its agent disabled or silent for longer than
      ``SENTINEL_OFFLINE_THRESHOLD`` (or never seen), no measurement at all, or
      a latest measurement that is stale -> ``unknown``. Stale: measured (on
      the agent's clock, the time of the probe) longer ago than three of the
      target's intervals, and never less than the offline threshold. A
      measurement delivered late from the agent's queue describes the past.
    * the latest ``SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES`` measurements all
      failed -> ``critical``
    * the latest failed (fewer failures in a row than that) -> ``warning``
    * the latest succeeded with a latency or a loss at or above
      ``SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS`` /
      ``SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT`` -> ``warning``
    * otherwise ``healthy``.

    A measurement is the agent's probes of one round: it succeeded when at
    least one probe got an answer, its latency is the mean of those that did,
    its loss the share that did not (for TCP, failed connection attempts).
    ``health_reason`` says which rule decided, for the UI's wording.

SNMP device (``annotate_devices``), in this order, the first that holds:
    * disabled -> ``idle``
    * no agent assigned, or its agent disabled, silent for longer than the
      offline threshold or never seen -> ``unknown``
    * never polled, or the latest poll is stale -> ``unknown``. Stale: taken (on
      the agent's clock, the time of the poll, not of its delivery) longer ago
      than three poll intervals, and never less than the offline threshold.
    * the latest poll could not reach the device -> ``critical``
    * otherwise ``healthy``.

    The interfaces do not change the device's health: a switch with unused
    ports down is a healthy switch. They have their own (``interface_health``).

SNMP interface (``interface_health``), the first that holds:
    * its device is not ``healthy`` (unreachable, stale, not polled, disabled,
      no agent) -> ``unknown``: the stored status is last-known, not current
    * absent from the device's latest complete listing -> ``unknown``
    * administratively down -> ``idle``
    * administratively up and operationally up -> ``healthy``
    * administratively up and operationally down or lowerLayerDown -> ``warning``
    * anything else (testing, dormant, notPresent, unknown) -> ``unknown``

``now`` is passed in, once per request, so ``generatedAt`` and every
comparison use the same instant.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.db.models import (
    BooleanField,
    Case,
    CharField,
    DateTimeField,
    DurationField,
    Exists,
    ExpressionWrapper,
    F,
    FloatField,
    IntegerField,
    OuterRef,
    Q,
    QuerySet,
    Subquery,
    Value,
    When,
)
from django.db.models.functions import Floor, Greatest

from apps.console.thresholds import thresholds
from apps.infrastructure.liveness import offline_threshold_seconds
from apps.infrastructure.models import DockerContainer, Server
from apps.network.models import NetworkMeasurement

# Why a server or a container has its status (``health_reason``).
SERVER_REASONS = ("never_seen", "offline", "resources", "status_warning", "ok", "no_telemetry")
CONTAINER_REASONS = ("not_observable", "dead", "restarting", "unhealthy", "starting", "running", "stopped", "other")
# The UI's words for why a target has its status (``health_reason``).
TARGET_REASONS = ("disabled", "no_agent", "agent_offline", "no_measurement", "stale", "failing", "failed", "latency", "loss", "ok")
# How many target intervals a measurement stays current (never less than the offline threshold).
STALE_INTERVALS = 3
# The UI's words for why a device has its status, and why an interface has its.
DEVICE_REASONS = ("disabled", "no_agent", "agent_offline", "no_poll", "stale", "unreachable", "ok")
INTERFACE_REASONS = ("device_unavailable", "absent", "admin_down", "up", "down", "other")
# IF-MIB values (``apps.snmp.models``): ifAdminStatus up/down, ifOperStatus up/down/lowerLayerDown.
_ADMIN_UP, _ADMIN_DOWN = 1, 2
_OPER_UP, _OPER_DOWN, _OPER_LOWER_LAYER_DOWN = 1, 2, 7

# Severity ranks, worst first: the UI's display order (``compareSeverity``).
CRITICAL, WARNING, UNKNOWN, IDLE, HEALTHY = 0, 1, 2, 3, 4
HEALTH_NAMES = {CRITICAL: "critical", WARNING: "warning", UNKNOWN: "unknown", IDLE: "idle", HEALTHY: "healthy"}
HEALTH_RANKS = {name: rank for rank, name in HEALTH_NAMES.items()}


def empty_counts() -> dict[str, int]:
    return {name: 0 for name in HEALTH_NAMES.values()}


def offline_cutoff(now: datetime) -> datetime:
    """Servers last seen before this are offline (``evaluate_effective_status`` uses the same rule)."""
    return now - timedelta(seconds=offline_threshold_seconds())


def telemetry_cutoff(now: datetime) -> datetime:
    """Telemetry that arrived before this is not current.

    The window is the one of liveness and of the Docker report. It has its own
    name so that the freshness of a reading is decided here and only here.
    """
    return offline_cutoff(now)


def fresh_telemetry(now: datetime) -> Q:
    """The server's latest resource report arrived recently (false without any snapshot)."""
    return Q(telemetry__received_at__gte=telemetry_cutoff(now))


def current_resources(now: datetime) -> Q:
    """A live server whose resource reading is current: the only readings that rank or judge."""
    return Q(last_seen_at__gte=offline_cutoff(now)) & fresh_telemetry(now)


def _int(value: int) -> Value:
    return Value(value, output_field=IntegerField())


def _text(value: str) -> Value:
    return Value(value, output_field=CharField())


def annotate_servers(queryset: QuerySet, now: datetime) -> QuerySet:
    """Add ``liveness`` (the status the UI shows), ``severity`` (the health rank) and ``telemetry_fresh`` to server rows."""
    cutoff = offline_cutoff(now)
    limits = thresholds()
    warn, crit = limits["resourceWarnPercent"], limits["resourceCritPercent"]
    # GREATEST ignores NULLs; the three columns are all present or, without a
    # telemetry row, all NULL (every comparison below is then false).
    worst = Floor(
        Greatest(
            F("telemetry__cpu_percent"),
            F("telemetry__memory_percent"),
            F("telemetry__disk_percent"),
            output_field=FloatField(),
        )
        + Value(0.5, output_field=FloatField()),
        output_field=FloatField(),
    )
    queryset = queryset.annotate(_worst_shown=worst)
    stored_warning = Q(status=Server.Status.WARNING)
    # Past the first two branches the server is live, so a fresh reading is a
    # current one (``current_resources`` states both for the sorting).
    fresh = fresh_telemetry(now)
    rules = (
        (Q(last_seen_at__isnull=True), UNKNOWN, "never_seen"),
        (Q(last_seen_at__lt=cutoff), CRITICAL, "offline"),
        (fresh & Q(_worst_shown__gte=crit), CRITICAL, "resources"),
        (fresh & Q(_worst_shown__gte=warn), WARNING, "resources"),
        (stored_warning, WARNING, "status_warning"),
        (fresh, HEALTHY, "ok"),
    )
    return queryset.annotate(
        liveness=Case(
            When(last_seen_at__isnull=True, then=_text(Server.Status.UNKNOWN)),
            When(last_seen_at__lt=cutoff, then=_text(Server.Status.OFFLINE)),
            When(stored_warning, then=_text(Server.Status.WARNING)),
            default=_text(Server.Status.ONLINE),
            output_field=CharField(),
        ),
        severity=Case(
            *(When(condition, then=_int(rank)) for condition, rank, _ in rules),
            # Alive, but its resources are unknown: no reading, or one that is no longer current.
            default=_int(UNKNOWN),
            output_field=IntegerField(),
        ),
        health_reason=Case(
            *(When(condition, then=_text(reason)) for condition, _, reason in rules),
            default=_text("no_telemetry"),
            output_field=CharField(),
        ),
        telemetry_fresh=Case(When(fresh, then=Value(True)), default=Value(False), output_field=BooleanField()),
    )


def server_load(column: str, now: datetime) -> Case:
    """A telemetry column for sorting: NULL unless the server's reading is current (offline, never reported, stale)."""
    return Case(
        When(current_resources(now), then=F(f"telemetry__{column}")),
        default=None,
        output_field=FloatField(),
    )


def annotate_containers(queryset: QuerySet, now: datetime) -> QuerySet:
    """Add ``observable`` (is the stored state current?), ``severity`` and ``health_reason`` to container rows."""
    cutoff = offline_cutoff(now)
    observable = Q(
        server__last_seen_at__gte=cutoff,
        server__docker_host__available=True,
        server__docker_host__received_at__gte=cutoff,
    )
    # For an observable container, the first that holds.
    rules = (
        (Q(state=DockerContainer.State.DEAD), CRITICAL, "dead"),
        (Q(state=DockerContainer.State.RESTARTING), WARNING, "restarting"),
        (Q(state=DockerContainer.State.RUNNING, health=DockerContainer.Health.UNHEALTHY), CRITICAL, "unhealthy"),
        (Q(state=DockerContainer.State.RUNNING, health=DockerContainer.Health.STARTING), IDLE, "starting"),
        (Q(state=DockerContainer.State.RUNNING), HEALTHY, "running"),
        (
            Q(state__in=(DockerContainer.State.EXITED, DockerContainer.State.CREATED, DockerContainer.State.PAUSED)),
            IDLE,
            "stopped",
        ),
    )
    return queryset.annotate(
        observable=ExpressionWrapper(observable, output_field=BooleanField()),
        severity=Case(
            When(
                observable,
                then=Case(
                    *(When(condition, then=_int(rank)) for condition, rank, _ in rules),
                    default=_int(UNKNOWN),
                    output_field=IntegerField(),
                ),
            ),
            default=_int(UNKNOWN),
            output_field=IntegerField(),
        ),
        health_reason=Case(
            When(
                observable,
                then=Case(
                    *(When(condition, then=_text(reason)) for condition, _, reason in rules),
                    default=_text("other"),
                    output_field=CharField(),
                ),
            ),
            default=_text("not_observable"),
            output_field=CharField(),
        ),
    )


def latest_measurements() -> QuerySet:
    """A target's measurements, newest first (the ``(target, -measured_at)`` index), for correlated subqueries."""
    return NetworkMeasurement.objects.filter(target=OuterRef("pk")).order_by("-measured_at", "-id")


def target_stale_cutoff(now: datetime) -> ExpressionWrapper:
    """Per target: measurements taken before this are not current (see the module docstring)."""
    window = Greatest(
        ExpressionWrapper(
            F("monitoring_interval_seconds") * Value(timedelta(seconds=STALE_INTERVALS), output_field=DurationField()),
            output_field=DurationField(),
        ),
        Value(timedelta(seconds=offline_threshold_seconds()), output_field=DurationField()),
        output_field=DurationField(),
    )
    return ExpressionWrapper(Value(now, output_field=DateTimeField()) - window, output_field=DateTimeField())


def annotate_targets(queryset: QuerySet, now: datetime) -> QuerySet:
    """Add the latest measurement (``latest_*``), ``measurement_fresh``, ``severity`` and ``health_reason`` to target rows.

    Each value is one index lookup per target: the latest row, and for the
    failures in a row the time of the N-th latest and whether any success is
    at or after it (at most N rows), however long the target's history.
    """
    limits = thresholds()
    failures = limits["targetCritFailures"]
    latest = latest_measurements()
    queryset = queryset.annotate(
        latest_id=Subquery(latest.values("id")[:1]),
        latest_measured_at=Subquery(latest.values("measured_at")[:1]),
        latest_success=Subquery(latest.values("success")[:1]),
        latest_latency_ms=Subquery(latest.values("latency_ms")[:1]),
        latest_loss=Subquery(latest.values("packet_loss_percentage")[:1]),
        _nth_measured_at=Subquery(latest.values("measured_at")[failures - 1 : failures]),
        _stale_before=target_stale_cutoff(now),
    )
    queryset = queryset.annotate(
        _success_since_nth=Exists(
            NetworkMeasurement.objects.filter(
                target=OuterRef("pk"), success=True, measured_at__gte=OuterRef("_nth_measured_at")
            )
        ),
    )
    cutoff = offline_cutoff(now)
    no_agent = Q(assigned_agent__isnull=True)
    agent_offline = (
        Q(assigned_agent__enabled=False)
        | Q(assigned_agent__last_seen_at__isnull=True)
        | Q(assigned_agent__last_seen_at__lt=cutoff)
    )
    no_measurement = Q(latest_measured_at__isnull=True)
    stale = Q(latest_measured_at__lt=F("_stale_before"))
    failing = Q(_nth_measured_at__isnull=False, _success_since_nth=False)
    failed = Q(latest_success=False)
    slow = Q(latest_latency_ms__gte=limits["probeLatencyWarnMs"])
    lossy = Q(latest_loss__gte=limits["probeLossWarnPercent"])
    rules = (
        (Q(enabled=False), IDLE, "disabled"),
        (no_agent, UNKNOWN, "no_agent"),
        (agent_offline, UNKNOWN, "agent_offline"),
        (no_measurement, UNKNOWN, "no_measurement"),
        (stale, UNKNOWN, "stale"),
        (failing, CRITICAL, "failing"),
        (failed, WARNING, "failed"),
        (slow, WARNING, "latency"),
        (lossy, WARNING, "loss"),
    )
    return queryset.annotate(
        measurement_fresh=Case(
            When(Q(latest_measured_at__gte=F("_stale_before")), then=Value(True)),
            default=Value(False),
            output_field=BooleanField(),
        ),
        severity=Case(
            *(When(condition, then=_int(rank)) for condition, rank, _ in rules),
            default=_int(HEALTHY),
            output_field=IntegerField(),
        ),
        health_reason=Case(
            *(When(condition, then=_text(reason)) for condition, _, reason in rules),
            default=_text("ok"),
            output_field=CharField(),
        ),
    )


def stale_cutoff(now: datetime, interval_field: str) -> ExpressionWrapper:
    """Per row: what was measured before this is not current (three of ``interval_field``, at least the offline threshold)."""
    window = Greatest(
        ExpressionWrapper(
            F(interval_field) * Value(timedelta(seconds=STALE_INTERVALS), output_field=DurationField()),
            output_field=DurationField(),
        ),
        Value(timedelta(seconds=offline_threshold_seconds()), output_field=DurationField()),
        output_field=DurationField(),
    )
    return ExpressionWrapper(Value(now, output_field=DateTimeField()) - window, output_field=DateTimeField())


def annotate_devices(queryset: QuerySet, now: datetime) -> QuerySet:
    """Add ``poll_fresh``, ``stale_before``, ``severity`` and ``health_reason`` to SNMP device rows (they have a config)."""
    cutoff = offline_cutoff(now)
    queryset = queryset.annotate(stale_before=stale_cutoff(now, "snmp_config__poll_interval_seconds"))
    agent_offline = (
        Q(assigned_agent__enabled=False)
        | Q(assigned_agent__last_seen_at__isnull=True)
        | Q(assigned_agent__last_seen_at__lt=cutoff)
    )
    rules = (
        (Q(enabled=False), IDLE, "disabled"),
        (Q(assigned_agent__isnull=True), UNKNOWN, "no_agent"),
        (agent_offline, UNKNOWN, "agent_offline"),
        (Q(snmp_state__last_poll_at__isnull=True), UNKNOWN, "no_poll"),
        (Q(snmp_state__last_poll_at__lt=F("stale_before")), UNKNOWN, "stale"),
        (Q(snmp_state__reachable=False), CRITICAL, "unreachable"),
    )
    return queryset.annotate(
        poll_fresh=Case(
            When(Q(snmp_state__last_poll_at__gte=F("stale_before")), then=Value(True)),
            default=Value(False),
            output_field=BooleanField(),
        ),
        severity=Case(
            *(When(condition, then=_int(rank)) for condition, rank, _ in rules),
            default=_int(HEALTHY),
            output_field=IntegerField(),
        ),
        health_reason=Case(
            *(When(condition, then=_text(reason)) for condition, _, reason in rules),
            default=_text("ok"),
            output_field=CharField(),
        ),
    )


def interface_health(*, device_healthy: bool, present: bool, admin_status: int, oper_status: int) -> tuple[str, str]:
    """``(health, reason)`` of one interface (see the module docstring)."""
    if not device_healthy:
        return HEALTH_NAMES[UNKNOWN], "device_unavailable"
    if not present:
        return HEALTH_NAMES[UNKNOWN], "absent"
    if admin_status == _ADMIN_DOWN:
        return HEALTH_NAMES[IDLE], "admin_down"
    if admin_status == _ADMIN_UP and oper_status == _OPER_UP:
        return HEALTH_NAMES[HEALTHY], "up"
    if admin_status == _ADMIN_UP and oper_status in (_OPER_DOWN, _OPER_LOWER_LAYER_DOWN):
        return HEALTH_NAMES[WARNING], "down"
    return HEALTH_NAMES[UNKNOWN], "other"

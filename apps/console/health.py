"""Health of servers and containers, decided in SQL and in one place.

The UI's status vocabulary (``healthy``, ``warning``, ``critical``, ``unknown``,
``idle``) is computed by the database as a *severity rank* column, so a list
can filter, sort and count by it without loading rows, and the detail view,
the list, the counts and the filters can never disagree: they all read this one
expression. The rules mirror the UI's own (``frontend/src/lib/status.ts``):

Server (``annotate_servers``)
    * never reported (``last_seen_at`` is null) -> ``unknown``
    * silent for longer than ``SENTINEL_OFFLINE_THRESHOLD`` -> ``critical``
      (``offline``; the same cutoff as ``apps.infrastructure.liveness``)
    * otherwise the worst of: a resource at or above the critical threshold
      -> ``critical``; at or above the warning threshold, or a stored status
      of ``warning`` -> ``warning``; else ``healthy``.
    * but resources only count while their reading is current (below), and a
      live server with no current reading has nothing to say about them:
      ``unknown`` (a stored ``warning`` still stands).

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
    reported by an offline host"). Otherwise: ``dead`` and an unhealthy running container are
    ``critical``; ``restarting`` is ``warning``; ``starting``, ``exited``,
    ``created`` and ``paused`` are ``idle`` (deliberately not running); a
    running container is ``healthy``.

``now`` is passed in, once per request, so ``generatedAt`` and every
comparison use the same instant.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from django.db.models import (
    BooleanField,
    Case,
    CharField,
    ExpressionWrapper,
    F,
    FloatField,
    IntegerField,
    Q,
    QuerySet,
    Value,
    When,
)
from django.db.models.functions import Floor, Greatest

from apps.console.thresholds import thresholds
from apps.infrastructure.liveness import offline_threshold_seconds
from apps.infrastructure.models import DockerContainer, Server

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
    return queryset.annotate(
        liveness=Case(
            When(last_seen_at__isnull=True, then=_text(Server.Status.UNKNOWN)),
            When(last_seen_at__lt=cutoff, then=_text(Server.Status.OFFLINE)),
            When(stored_warning, then=_text(Server.Status.WARNING)),
            default=_text(Server.Status.ONLINE),
            output_field=CharField(),
        ),
        severity=Case(
            When(last_seen_at__isnull=True, then=_int(UNKNOWN)),
            When(last_seen_at__lt=cutoff, then=_int(CRITICAL)),
            When(fresh & Q(_worst_shown__gte=crit), then=_int(CRITICAL)),
            When((fresh & Q(_worst_shown__gte=warn)) | stored_warning, then=_int(WARNING)),
            When(fresh, then=_int(HEALTHY)),
            # Alive, but its resources are unknown: no reading, or one that is no longer current.
            default=_int(UNKNOWN),
            output_field=IntegerField(),
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
    """Add ``observable`` (is the stored state current?) and ``severity`` to container rows."""
    cutoff = offline_cutoff(now)
    observable = Q(
        server__last_seen_at__gte=cutoff,
        server__docker_host__available=True,
        server__docker_host__received_at__gte=cutoff,
    )
    return queryset.annotate(
        observable=ExpressionWrapper(observable, output_field=BooleanField()),
        severity=Case(
            When(
                observable,
                then=Case(
                    When(state=DockerContainer.State.DEAD, then=_int(CRITICAL)),
                    When(state=DockerContainer.State.RESTARTING, then=_int(WARNING)),
                    When(
                        state=DockerContainer.State.RUNNING,
                        health=DockerContainer.Health.UNHEALTHY,
                        then=_int(CRITICAL),
                    ),
                    When(
                        state=DockerContainer.State.RUNNING,
                        health=DockerContainer.Health.STARTING,
                        then=_int(IDLE),
                    ),
                    When(state=DockerContainer.State.RUNNING, then=_int(HEALTHY)),
                    When(
                        state__in=(
                            DockerContainer.State.EXITED,
                            DockerContainer.State.CREATED,
                            DockerContainer.State.PAUSED,
                        ),
                        then=_int(IDLE),
                    ),
                    default=_int(UNKNOWN),
                    output_field=IntegerField(),
                ),
            ),
            default=_int(UNKNOWN),
            output_field=IntegerField(),
        ),
    )

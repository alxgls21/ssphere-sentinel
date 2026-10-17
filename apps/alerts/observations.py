"""What the alert engine observes: the console's health of the objects a rule may care about.

Each observation is the status and reason the console gives an object at ``now``
(``apps.console.health``: the same expressions, thresholds and staleness rules the
screens use), with the time of the evidence it rests on:

    server     its latest resource reading (telemetry ``received_at``); its last
               heartbeat for a stored status
    container  its host's latest Docker report
    target     its latest measurement (``measured_at``: when the probe ran)
    device     its latest poll (``last_poll_at``: when the poll ran)
    interface  its device's latest poll

A status that is a silence (offline, never seen, no reading, no measurement or poll,
a stale one, an unobservable container) is observed at ``now``: the passing time is
its evidence. Anything else is only as new as the data behind it, so evaluating the
same measurement again is not a new observation of it.

Only what can matter is read: the objects whose status could fire a rule, and those
the engine holds a state for (to see them recover, change or go). An object the
engine holds a state for and does not find has gone: deleted, or no longer one the
console reports on (an absent container or interface, a device without SNMP).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from django.db.models import Q

from apps.alerts.conditions import DEPENDENT, EntityKind
from apps.console.health import (
    HEALTH_NAMES,
    HEALTHY,
    annotate_containers,
    annotate_devices,
    annotate_servers,
    annotate_targets,
    interface_health,
    offline_cutoff,
)
from apps.infrastructure.liveness import offline_threshold_seconds
from apps.infrastructure.models import DockerContainer, Server
from apps.inventory.models import Device
from apps.network.models import NetworkTarget
from apps.snmp.models import AdminStatus, Interface, OperStatus

# Statuses the console gives without data: observed now.
SILENT_REASONS = {
    EntityKind.SERVER: {"never_seen", "offline", "no_telemetry"},
    EntityKind.CONTAINER: {"not_observable"},
    EntityKind.TARGET: {"disabled", "no_agent", "agent_offline", "no_measurement", "stale"},
    EntityKind.DEVICE: {"disabled", "no_agent", "agent_offline", "no_poll", "stale"},
    EntityKind.INTERFACE: {"device_unavailable"},
}


@dataclass(frozen=True)
class Observation:
    kind: str
    ref: str
    label: str
    site_id: UUID | None
    customer_id: UUID | None
    health: str
    reason: str
    # The time of the evidence this status rests on (``now`` for a silence).
    evidence_at: datetime
    # A silence: no data stands behind the status.
    silence: bool = False
    # When the status began, where the data says so exactly (a server is offline
    # from its last heartbeat plus the offline threshold).
    since: datetime | None = None
    # The monitoring source that is unavailable, when that is why the status is unknown.
    upstream: tuple[str, str] | None = None


def _wanted(ranks: Iterable[int], refs: Iterable[str], ref_lookup: str) -> Q | None:
    """Rows whose status could fire a rule, or that the engine holds a state for; None: nothing to read."""
    ranks, refs = sorted(set(ranks)), sorted(set(refs))
    if not ranks and not refs:
        return None
    wanted = Q(pk__in=[])
    if ranks:
        wanted |= Q(severity__in=ranks)
    if refs:
        wanted |= Q(**{f"{ref_lookup}__in": refs})
    return wanted


def _owners(refs: Iterable[str]) -> list[str]:
    """The servers or devices that ``<owner>:<id>`` references belong to."""
    return sorted({ref.split(":", 1)[0] for ref in refs})


def observe_servers(now: datetime, *, ranks: Iterable[int], refs: Iterable[str]) -> dict[str, Observation]:
    wanted = _wanted(ranks, refs, "pk")
    if wanted is None:
        return {}
    threshold = timedelta(seconds=offline_threshold_seconds())
    rows = (
        annotate_servers(Server.objects.all(), now)
        .filter(wanted)
        .values("id", "name", "site_id", "site__customer_id", "last_seen_at", "telemetry__received_at", "severity", "health_reason")
    )
    observed = {}
    for row in rows:
        reason = row["health_reason"]
        silent = reason in SILENT_REASONS[EntityKind.SERVER]
        since = None
        if silent:
            evidence = now
            if reason == "offline":
                since = row["last_seen_at"] + threshold
        elif reason == "status_warning":
            evidence = row["last_seen_at"]
        else:
            evidence = row["telemetry__received_at"]
        ref = str(row["id"])
        observed[ref] = Observation(
            kind=EntityKind.SERVER,
            ref=ref,
            label=row["name"],
            site_id=row["site_id"],
            customer_id=row["site__customer_id"],
            health=HEALTH_NAMES[row["severity"]],
            reason=reason,
            evidence_at=evidence,
            silence=silent,
            since=since,
        )
    return observed


def observe_containers(now: datetime, *, ranks: Iterable[int], refs: Iterable[str]) -> dict[str, Observation]:
    refs = set(refs)
    wanted = _wanted(ranks, _owners(refs), "server_id")
    if wanted is None:
        return {}
    ranks = set(ranks)
    cutoff = offline_cutoff(now)
    rows = (
        annotate_containers(DockerContainer.objects.filter(present=True), now)
        .filter(wanted)
        .values(
            "server_id",
            "container_id",
            "name",
            "server__name",
            "server__site_id",
            "server__site__customer_id",
            "server__last_seen_at",
            "server__docker_host__received_at",
            "severity",
            "health_reason",
        )
    )
    observed = {}
    for row in rows:
        ref = f"{row['server_id']}:{row['container_id']}"
        if row["severity"] not in ranks and ref not in refs:
            continue  # read only for another container of its host
        reason = row["health_reason"]
        silent = reason in SILENT_REASONS[EntityKind.CONTAINER]
        upstream = None
        if silent:
            evidence = now
            host_seen = row["server__last_seen_at"]
            if host_seen is None or host_seen < cutoff:  # its host is offline (not merely its Docker)
                upstream = (DEPENDENT[(EntityKind.CONTAINER, reason)], str(row["server_id"]))
        else:
            evidence = row["server__docker_host__received_at"]
        observed[ref] = Observation(
            kind=EntityKind.CONTAINER,
            ref=ref,
            label=f"{row['name']} on {row['server__name']}",
            site_id=row["server__site_id"],
            customer_id=row["server__site__customer_id"],
            health=HEALTH_NAMES[row["severity"]],
            reason=reason,
            evidence_at=evidence,
            silence=silent,
            upstream=upstream,
        )
    return observed


def _agent_measured(kind: str, now: datetime, rows, measured_at: str) -> dict[str, Observation]:
    """Targets and devices: measured by the agent assigned to them."""
    observed = {}
    for row in rows:
        reason = row["health_reason"]
        silent = reason in SILENT_REASONS[kind]
        upstream = None
        if (kind, reason) in DEPENDENT and row["assigned_agent__server_id"] is not None:
            upstream = (DEPENDENT[(kind, reason)], str(row["assigned_agent__server_id"]))
        ref = str(row["id"])
        observed[ref] = Observation(
            kind=kind,
            ref=ref,
            label=row["name"],
            site_id=row["site_id"],
            customer_id=row["site__customer_id"],
            health=HEALTH_NAMES[row["severity"]],
            reason=reason,
            evidence_at=now if silent else row[measured_at],
            silence=silent,
            upstream=upstream,
        )
    return observed


def observe_targets(now: datetime, *, ranks: Iterable[int], refs: Iterable[str]) -> dict[str, Observation]:
    wanted = _wanted(ranks, refs, "pk")
    if wanted is None:
        return {}
    rows = (
        annotate_targets(NetworkTarget.objects.all(), now)
        .filter(wanted)
        .values("id", "name", "site_id", "site__customer_id", "assigned_agent__server_id", "latest_measured_at", "severity", "health_reason")
    )
    return _agent_measured(EntityKind.TARGET, now, rows, "latest_measured_at")


def observe_devices(now: datetime, *, ranks: Iterable[int], refs: Iterable[str]) -> dict[str, Observation]:
    wanted = _wanted(ranks, refs, "pk")
    if wanted is None:
        return {}
    rows = (
        annotate_devices(Device.objects.filter(snmp_config__isnull=False), now)
        .filter(wanted)
        .values(
            "id", "name", "site_id", "site__customer_id", "assigned_agent__server_id", "snmp_state__last_poll_at", "severity", "health_reason"
        )
    )
    return _agent_measured(EntityKind.DEVICE, now, rows, "snmp_state__last_poll_at")


def observe_interfaces(
    now: datetime, *, down: bool, unknown: bool, refs: Iterable[str], devices: Iterable[str] = ()
) -> dict[str, Observation]:
    """Interfaces that could be down (``down``) or unknown (``unknown``), those of ``devices``, and ``refs``.

    An interface's health depends on its device's (``interface_health``), read here
    for the devices of the interfaces read.
    """
    refs = set(refs)
    wanted = Q(device_id__in=sorted(set(_owners(refs)) | set(devices)))
    if down:
        wanted |= Q(admin_status=AdminStatus.UP, oper_status__in=(OperStatus.DOWN, OperStatus.LOWER_LAYER_DOWN))
    if unknown:
        wanted |= ~Q(admin_status__in=(AdminStatus.UP, AdminStatus.DOWN))
        wanted |= Q(admin_status=AdminStatus.UP) & ~Q(oper_status__in=(OperStatus.UP, OperStatus.DOWN, OperStatus.LOWER_LAYER_DOWN))
    rows = list(
        Interface.objects.filter(present=True, device__snmp_config__isnull=False)
        .filter(wanted)
        .values("device_id", "if_index", "name", "admin_status", "oper_status", "device__name", "device__site_id", "device__site__customer_id")
    )
    if not rows:
        return {}
    device_rows = annotate_devices(Device.objects.filter(pk__in={row["device_id"] for row in rows}), now).values(
        "id", "severity", "snmp_state__last_poll_at"
    )
    polled = {row["id"]: row for row in device_rows}
    observed = {}
    for row in rows:
        device = polled[row["device_id"]]
        health, reason = interface_health(
            device_healthy=device["severity"] == HEALTHY,
            present=True,
            admin_status=row["admin_status"],
            oper_status=row["oper_status"],
        )
        ref = f"{row['device_id']}:{row['if_index']}"
        silent = reason in SILENT_REASONS[EntityKind.INTERFACE]
        observed[ref] = Observation(
            kind=EntityKind.INTERFACE,
            ref=ref,
            label=f"{row['name']} on {row['device__name']}",
            site_id=row["device__site_id"],
            customer_id=row["device__site__customer_id"],
            health=health,
            reason=reason,
            evidence_at=now if silent else device["snmp_state__last_poll_at"],
            silence=silent,
            upstream=(EntityKind.DEVICE, str(row["device_id"])) if silent else None,
        )
    return observed

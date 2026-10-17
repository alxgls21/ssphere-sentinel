"""What an alert rule can say, in the console's own health vocabulary.

A rule matches the health the console already computes (``apps.console.health``),
never a second judgement of its own: the same five statuses, and for each kind
of monitored object the reasons the console gives for them (``SERVER_REASONS``,
``CONTAINER_REASONS``, ``TARGET_REASONS``, ``DEVICE_REASONS``,
``INTERFACE_REASONS``); the tests hold every list here to its source.

Monitored objects are referred to the way the console API refers to them, by
kind and reference, without a foreign key into the app that stores them:

    server, target, device   <uuid>
    container                <server uuid>:<Docker container id>
    interface                <device uuid>:<ifIndex>
"""

from __future__ import annotations

from django.db import models
from django.db.models import Q


class EntityKind(models.TextChoices):
    SERVER = "server", "Server"
    CONTAINER = "container", "Docker container"
    TARGET = "target", "Network target"
    DEVICE = "device", "SNMP device"
    INTERFACE = "interface", "Interface"


class HealthCondition(models.TextChoices):
    """The health a rule fires on. Idle and healthy never do."""

    CRITICAL = "critical", "Critical"
    WARNING = "warning", "Warning or critical"
    UNKNOWN = "unknown", "Unknown (no current monitoring data)"


class Severity(models.TextChoices):
    CRITICAL = "critical", "Critical"
    WARNING = "warning", "Warning"


HEALTH = ("critical", "warning", "unknown", "idle", "healthy")

# The statuses each condition fires on.
MATCHES: dict[str, frozenset[str]] = {
    HealthCondition.CRITICAL: frozenset({"critical"}),
    HealthCondition.WARNING: frozenset({"critical", "warning"}),
    HealthCondition.UNKNOWN: frozenset({"unknown"}),
}

# For each kind: every reason the console can give, and the statuses it comes with.
REASONS: dict[str, dict[str, frozenset[str]]] = {
    EntityKind.SERVER: {
        "never_seen": frozenset({"unknown"}),  # no heartbeat yet
        "offline": frozenset({"critical"}),  # silent for longer than the offline threshold
        "resources": frozenset({"critical", "warning"}),  # a current reading at or over a threshold
        "status_warning": frozenset({"warning"}),  # its stored status is warning
        "no_telemetry": frozenset({"unknown"}),  # alive, without a current reading
        "ok": frozenset({"healthy"}),
    },
    EntityKind.CONTAINER: {
        "not_observable": frozenset({"unknown"}),  # its host or its Docker report is not current
        "dead": frozenset({"critical"}),
        "unhealthy": frozenset({"critical"}),  # running, failing its health check
        "restarting": frozenset({"warning"}),
        "starting": frozenset({"idle"}),  # running, health check still starting
        "stopped": frozenset({"idle"}),  # exited, created or paused
        "running": frozenset({"healthy"}),
        "other": frozenset({"unknown"}),
    },
    EntityKind.TARGET: {
        "disabled": frozenset({"idle"}),
        "no_agent": frozenset({"unknown"}),
        "agent_offline": frozenset({"unknown"}),
        "no_measurement": frozenset({"unknown"}),
        "stale": frozenset({"unknown"}),
        "failing": frozenset({"critical"}),
        "failed": frozenset({"warning"}),
        "latency": frozenset({"warning"}),
        "loss": frozenset({"warning"}),
        "ok": frozenset({"healthy"}),
    },
    EntityKind.DEVICE: {
        "disabled": frozenset({"idle"}),
        "no_agent": frozenset({"unknown"}),
        "agent_offline": frozenset({"unknown"}),
        "no_poll": frozenset({"unknown"}),
        "stale": frozenset({"unknown"}),
        "unreachable": frozenset({"critical"}),
        "ok": frozenset({"healthy"}),
    },
    EntityKind.INTERFACE: {
        "device_unavailable": frozenset({"unknown"}),
        "absent": frozenset({"unknown"}),
        "admin_down": frozenset({"idle"}),
        "up": frozenset({"healthy"}),
        "down": frozenset({"warning"}),
        "other": frozenset({"unknown"}),
    },
}


# What some reasons mean for an alert, beyond their status:
#   deliberately not monitored or not running: an open incident ends, it does not recover
DORMANT = {
    (EntityKind.TARGET, "disabled"),
    (EntityKind.DEVICE, "disabled"),
    (EntityKind.INTERFACE, "admin_down"),
    (EntityKind.CONTAINER, "stopped"),
}
#   on its way to a status, not one yet: no evidence either way
TRANSIENT = {(EntityKind.CONTAINER, "starting")}
#   unknown because the source of the data is unavailable, and which source: the
#   server whose agent probes or polls it, the server a container runs on, the
#   device an interface is polled through
DEPENDENT = {
    (EntityKind.TARGET, "agent_offline"): EntityKind.SERVER,
    (EntityKind.DEVICE, "agent_offline"): EntityKind.SERVER,
    (EntityKind.CONTAINER, "not_observable"): EntityKind.SERVER,
    (EntityKind.INTERFACE, "device_unavailable"): EntityKind.DEVICE,
}
#   for a rule narrowed to a reason: observations that say nothing about it (an
#   offline server has no current resource reading, whatever its status says)
UNINFORMATIVE = {
    (EntityKind.SERVER, "resources"): frozenset({"never_seen", "offline", "no_telemetry"}),
    (EntityKind.SERVER, "status_warning"): frozenset({"never_seen", "offline"}),
}


def reasons_for(kind: str, condition: str) -> tuple[str, ...]:
    """The reasons a rule on ``kind`` with ``condition`` may narrow to: those that can fire it."""
    fires = MATCHES.get(condition, frozenset())
    return tuple(reason for reason, statuses in REASONS.get(kind, {}).items() if statuses & fires)


def rule_condition_q() -> Q:
    """A rule's condition can fire for its kind, and its reason (if any) is one that can fire it."""
    allowed = Q()
    for kind in EntityKind.values:
        for condition in HealthCondition.values:
            reasons = reasons_for(kind, condition)
            if reasons:
                allowed |= Q(entity_kind=kind, health=condition, reason="") | Q(entity_kind=kind, health=condition, reason__in=reasons)
    return allowed


_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# Docker ids are letters, digits, "-" and "_" (apps.infrastructure.docker_reports), up to 64.
REF_PATTERNS = {
    EntityKind.SERVER: rf"^{_UUID}$",
    EntityKind.TARGET: rf"^{_UUID}$",
    EntityKind.DEVICE: rf"^{_UUID}$",
    EntityKind.CONTAINER: rf"^{_UUID}:[^:]{{1,64}}$",
    EntityKind.INTERFACE: rf"^{_UUID}:[1-9][0-9]{{0,9}}$",
}


def entity_ref_q() -> Q:
    """``entity_kind`` is a known kind and ``entity_ref`` has that kind's form."""
    allowed = Q()
    for kind, pattern in REF_PATTERNS.items():
        allowed |= Q(entity_kind=kind, entity_ref__regex=pattern)
    return allowed

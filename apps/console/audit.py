"""The console's audit trail (``AuditEntry``): who did what, to which object, when, and what changed.

Every administrative write of the console records one entry here, inside the transaction of the
change: customers and sites, users and their access, network targets, devices, servers and their
agents, acknowledged incidents, alert rules and monitored domains. (Alert rules, domains and email
subscriptions are also in the alerts app's own configuration trail, which the admin shows; this
trail is the console's, and the console reads it: ``apps.console.audit_log``.)

Only safe values are recorded: field names and non-secret values, by the names the console API
gives them, as ``{"field": {"before": value, "after": value}}`` of what changed. A password, a
password hash, an agent token or an SNMP credential profile is never recorded: a password change
is the action alone, a token rotation is the action alone, and a changed credential profile is
recorded as ``credentialProfileChanged`` without the name.
"""

from __future__ import annotations

from django.utils import timezone

from apps.console.models import AuditEntry

SOURCE_CONSOLE = "console"

# The objects an entry is about.
CUSTOMER = "customer"
SITE = "site"
USER = "user"
TARGET = "target"
DEVICE = "device"
SERVER = "server"
AGENT = "agent"
INCIDENT = "incident"
ALERT_RULE = "alert_rule"
DOMAIN = "domain"

TARGET_TYPES = {
    CUSTOMER: "Customer",
    SITE: "Site",
    USER: "User",
    TARGET: "Network target",
    DEVICE: "Device",
    SERVER: "Server",
    AGENT: "Agent",
    INCIDENT: "Incident",
    ALERT_RULE: "Alert rule",
    DOMAIN: "Monitored domain",
}

# Every action the trail knows, with its label; an entry never carries another.
ACTIONS = {
    "customer_created": "Customer created",
    "customer_changed": "Customer changed",
    "customer_deleted": "Customer deleted",
    "site_created": "Site created",
    "site_changed": "Site changed",
    "site_deleted": "Site deleted",
    "user_created": "User created",
    "user_changed": "User changed",
    "user_activated": "User activated",
    "user_deactivated": "User deactivated",
    "user_password_reset": "User password reset",
    "user_password_changed": "Own password changed",
    "user_unlocked": "User sign-in unlocked",
    "target_created": "Network target created",
    "target_changed": "Network target changed",
    "target_enabled": "Network target enabled",
    "target_disabled": "Network target disabled",
    "target_deleted": "Network target deleted",
    "device_created": "Device created",
    "device_changed": "Device changed",
    "device_deleted": "Device deleted",
    "server_created": "Server created",
    "server_changed": "Server changed",
    "server_deleted": "Server deleted",
    "agent_created": "Agent created",
    "agent_token_rotated": "Agent token rotated",
    "agent_enabled": "Agent enabled",
    "agent_disabled": "Agent disabled",
    "incident_acknowledged": "Incident acknowledged",
    "alert_rule_created": "Alert rule created",
    "alert_rule_changed": "Alert rule changed",
    "domain_created": "Domain added",
    "domain_verification_requested": "Domain verification requested",
}


def json_value(value):
    """A value as JSON can hold it: booleans, numbers, text and lists of them as they are, anything else as text."""
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value if value is None or isinstance(value, (bool, int, float, str)) else str(value)


def changes(before: dict, after: dict) -> dict:
    """``{"field": {"before", "after"}}`` of what differs (a field missing on one side is null there)."""
    return {
        name: {"before": json_value(before.get(name)), "after": json_value(after.get(name))}
        for name in sorted({*before, *after})
        if before.get(name) != after.get(name)
    }


def record(actor, *, action: str, target_type: str, target_id, target_name: str, changed: dict | None = None) -> AuditEntry:
    """One entry, written now, in the caller's transaction. ``actor`` is the signed-in account."""
    if action not in ACTIONS or target_type not in TARGET_TYPES:
        raise ValueError(f"unknown audit action or target: {action!r} on {target_type!r}")
    return AuditEntry.objects.create(
        at=timezone.now(),
        actor=actor if actor is not None and actor.pk is not None else None,
        actor_name=actor.get_username() if actor is not None else "",
        source=SOURCE_CONSOLE,
        action=action,
        target_type=target_type,
        target_id=str(target_id)[:64],
        target_name=(target_name or "")[:255],
        changes=changed or {},
    )

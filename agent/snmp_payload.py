"""SNMP poll payload: the heartbeat ``snmp`` section (version 1).

One *poll* is the result of polling one device (see docs/snmp.md for the
contract). This module holds what the collector, the queue and the delivery
share: the limits the server enforces, the error categories, and the
whitelist the queue applies to every poll before storing it.

The whitelist is a security boundary, not a convenience: only the fields
below can ever reach the queue file or the network, so a credential that
leaked into a poll dictionary through a bug would still be dropped here.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from agent.errors import AgentError

SNMP_PAYLOAD_VERSION = 1

# Limits enforced by the server (apps/snmp/reports.py).
MAX_POLLS_PER_REPORT = 50
MAX_INTERFACES_PER_POLL = 512
MAX_INTERFACES_PER_REPORT = 2000
# The server reads the whole request body (Django's default limit is
# 2.5 MiB) and the heartbeat also carries telemetry, Docker and network
# sections, so the SNMP section stays well below that.
MAX_REPORT_BYTES = 1_000_000
# One stored poll must always fit into a report. The collector shortens
# descriptive text (128 characters for names and descriptions, 64 for aliases)
# so that even 512 interfaces of text that needs three UTF-8 bytes per
# character (about 620 KB) stay below this.
MAX_POLL_PAYLOAD_BYTES = 768 * 1024

# Error categories the server accepts for an unreachable device.
ERROR_TIMEOUT = "timeout"
ERROR_UNREACHABLE = "unreachable"
ERROR_AUTH_FAILURE = "auth_failure"
ERROR_DNS_FAILURE = "dns_failure"
ERROR_PROTOCOL = "protocol_error"
ERROR_UNSUPPORTED = "unsupported"
ERROR_UNKNOWN = "unknown"
ERROR_CATEGORIES = frozenset(
    {
        ERROR_TIMEOUT,
        ERROR_UNREACHABLE,
        ERROR_AUTH_FAILURE,
        ERROR_DNS_FAILURE,
        ERROR_PROTOCOL,
        ERROR_UNSUPPORTED,
        ERROR_UNKNOWN,
    }
)

DELTA_OK = "ok"
DELTA_SPEED_CHANGED = "speed_changed"
DELTA_FIRST = "first"
DELTA_REBOOT = "reboot"
DELTA_RESET = "reset"
DELTA_GAP = "gap"
DELTA_STATES_WITH_VALUES = frozenset({DELTA_OK, DELTA_SPEED_CHANGED})

COUNTER_NAMES = (
    "in_octets",
    "out_octets",
    "in_errors",
    "out_errors",
    "in_discards",
    "out_discards",
)
OCTET_COUNTERS = frozenset({"in_octets", "out_octets"})

_POLL_FIELDS = (
    "measured_at",
    "reachable",
    "response_ms",
    "error",
    "sys_uptime_ticks",
    "interfaces_complete",
)
_SYSTEM_FIELDS = ("name", "descr", "object_id")
_INTERFACE_FIELDS = (
    "if_index",
    "name",
    "descr",
    "alias",
    "if_type",
    "speed_bps",
    "admin_status",
    "oper_status",
)
_COUNTER_FIELDS = ("octets_bits", "delta_state", "interval_seconds")


class SnmpPayloadError(AgentError):
    """Raised for a poll that cannot be stored or sent."""


def sanitize_poll(poll: Any) -> tuple[str, str, int]:
    """Return ``(poll_id, json_payload, interface_count)`` with whitelisted fields only."""
    if not isinstance(poll, dict):
        raise SnmpPayloadError("poll must be an object")
    poll_id = _uuid(poll.get("poll_id"), "poll_id")
    cleaned: dict[str, Any] = {
        "poll_id": poll_id,
        "device_id": _uuid(poll.get("device_id"), "device_id"),
    }
    cleaned.update(_pick(poll, _POLL_FIELDS))

    system = poll.get("system")
    if isinstance(system, dict):
        cleaned["system"] = _pick(system, _SYSTEM_FIELDS)

    interfaces = poll.get("interfaces")
    count = 0
    if interfaces is not None:
        if not isinstance(interfaces, list):
            raise SnmpPayloadError("interfaces must be a list")
        if len(interfaces) > MAX_INTERFACES_PER_POLL:
            raise SnmpPayloadError("poll has too many interfaces")
        cleaned["interfaces"] = [_clean_interface(item) for item in interfaces]
        count = len(interfaces)

    try:
        # Not ASCII-escaped: a non-Latin character costs 3 bytes, not 6, and the
        # size checked here is the size stored.
        payload = json.dumps(
            cleaned, separators=(",", ":"), sort_keys=True, allow_nan=False, ensure_ascii=False
        )
        size = len(payload.encode("utf-8"))
    except (TypeError, ValueError) as exc:  # includes unencodable surrogates
        raise SnmpPayloadError("poll is not valid JSON") from exc
    if size > MAX_POLL_PAYLOAD_BYTES:
        raise SnmpPayloadError("poll payload exceeds size limit")
    return poll_id, payload, count


def _clean_interface(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise SnmpPayloadError("each interface must be an object")
    cleaned = _pick(item, _INTERFACE_FIELDS)
    counters = item.get("counters")
    if isinstance(counters, dict):
        kept = _pick(counters, _COUNTER_FIELDS)
        for part in ("raw", "delta"):
            values = counters.get(part)
            if isinstance(values, dict):
                kept[part] = _pick(values, COUNTER_NAMES)
        cleaned["counters"] = kept
    return cleaned


def _pick(source: dict[str, Any], names: tuple[str, ...]) -> dict[str, Any]:
    return {name: source[name] for name in names if name in source}


def _uuid(value: Any, field: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError) as exc:
        raise SnmpPayloadError(f"{field} must be a UUID") from exc

"""Validate and store agent telemetry snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.infrastructure.models import Server, ServerTelemetry

SUPPORTED_TELEMETRY_VERSION = 1
# Reject collected_at values absurdly far in the future (clock skew allowance).
MAX_FUTURE_SKEW = timedelta(minutes=5)


class TelemetryValidationError(Exception):
    """Raised when a telemetry payload is invalid."""


@dataclass(frozen=True)
class ValidatedTelemetry:
    cpu_percent: float
    memory_total_bytes: int
    memory_used_bytes: int
    memory_percent: float
    disk_total_bytes: int
    disk_used_bytes: int
    disk_percent: float
    uptime_seconds: int
    collected_at: datetime


def validate_telemetry_payload(raw: Any) -> ValidatedTelemetry:
    if not isinstance(raw, dict):
        raise TelemetryValidationError("telemetry must be an object")

    version = raw.get("version")
    if version != SUPPORTED_TELEMETRY_VERSION:
        raise TelemetryValidationError(
            f"unsupported telemetry version (expected {SUPPORTED_TELEMETRY_VERSION})"
        )

    collected_at = _parse_collected_at(raw.get("collected_at"))
    cpu_percent = _require_percent(raw, "cpu_percent")

    memory_total = _require_positive_int(raw, "memory_total_bytes")
    memory_used = _require_non_negative_int(raw, "memory_used_bytes")
    if memory_used > memory_total:
        raise TelemetryValidationError("memory_used_bytes exceeds memory_total_bytes")
    # Accept agent-provided percent only after range check; store recomputed value.
    _require_percent(raw, "memory_percent")
    memory_percent = _recompute_percent(memory_used, memory_total)

    disk_total = _require_positive_int(raw, "disk_total_bytes")
    disk_used = _require_non_negative_int(raw, "disk_used_bytes")
    if disk_used > disk_total:
        raise TelemetryValidationError("disk_used_bytes exceeds disk_total_bytes")
    _require_percent(raw, "disk_percent")
    disk_percent = _recompute_percent(disk_used, disk_total)

    uptime_seconds = _require_non_negative_int(raw, "uptime_seconds")

    return ValidatedTelemetry(
        cpu_percent=cpu_percent,
        memory_total_bytes=memory_total,
        memory_used_bytes=memory_used,
        memory_percent=memory_percent,
        disk_total_bytes=disk_total,
        disk_used_bytes=disk_used,
        disk_percent=disk_percent,
        uptime_seconds=uptime_seconds,
        collected_at=collected_at,
    )


def upsert_server_telemetry(
    server: Server,
    validated: ValidatedTelemetry,
    *,
    received_at: datetime | None = None,
) -> None:
    """Overwrite the server's telemetry snapshot (one UPDATE once it exists)."""
    received = received_at if received_at is not None else timezone.now()
    defaults = {
        "cpu_percent": validated.cpu_percent,
        "memory_total_bytes": validated.memory_total_bytes,
        "memory_used_bytes": validated.memory_used_bytes,
        "memory_percent": validated.memory_percent,
        "disk_total_bytes": validated.disk_total_bytes,
        "disk_used_bytes": validated.disk_used_bytes,
        "disk_percent": validated.disk_percent,
        "uptime_seconds": validated.uptime_seconds,
        "collected_at": validated.collected_at,
        "received_at": received,
    }
    snapshot = ServerTelemetry.objects.filter(server=server)
    if snapshot.update(**defaults):
        return
    try:
        with transaction.atomic():
            ServerTelemetry.objects.create(server=server, **defaults)
    except IntegrityError:
        # A concurrent first report created the row; overwrite it instead.
        snapshot.update(**defaults)


def _parse_collected_at(value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise TelemetryValidationError("collected_at must be an ISO-8601 timestamp")
    try:
        parsed = parse_datetime(value.strip())
    except ValueError:
        parsed = None
    if parsed is None:
        raise TelemetryValidationError("collected_at must be an ISO-8601 timestamp")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, dt_timezone.utc)
    now = timezone.now()
    if parsed > now + MAX_FUTURE_SKEW:
        raise TelemetryValidationError("collected_at is too far in the future")
    return parsed


def _require_percent(raw: dict[str, Any], field: str) -> float:
    value = raw.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TelemetryValidationError(f"{field} must be a number")
    number = float(value)
    if number < 0.0 or number > 100.0:
        raise TelemetryValidationError(f"{field} must be between 0 and 100")
    return number


def _require_positive_int(raw: dict[str, Any], field: str) -> int:
    value = _require_int(raw, field)
    if value <= 0:
        raise TelemetryValidationError(f"{field} must be greater than 0")
    return value


def _require_non_negative_int(raw: dict[str, Any], field: str) -> int:
    value = _require_int(raw, field)
    if value < 0:
        raise TelemetryValidationError(f"{field} must be >= 0")
    return value


def _require_int(raw: dict[str, Any], field: str) -> int:
    value = raw.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TelemetryValidationError(f"{field} must be an integer")
    if isinstance(value, float) and not value.is_integer():
        raise TelemetryValidationError(f"{field} must be an integer")
    return int(value)


def _recompute_percent(used: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((used / total) * 100.0, 2)

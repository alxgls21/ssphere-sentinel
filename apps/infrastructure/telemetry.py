"""Validate and store agent telemetry snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.validation import parse_timestamp, require_integer, require_number
from apps.infrastructure.models import Server, ServerTelemetry

SUPPORTED_TELEMETRY_VERSION = 1


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

    collected_at = parse_timestamp(
        raw.get("collected_at"), field="collected_at", error=TelemetryValidationError
    )
    cpu_percent = _require_percent(raw, "cpu_percent")

    memory_total = _require_int(raw, "memory_total_bytes", minimum=1)
    memory_used = _require_int(raw, "memory_used_bytes", minimum=0)
    if memory_used > memory_total:
        raise TelemetryValidationError("memory_used_bytes exceeds memory_total_bytes")
    # Accept agent-provided percent only after range check; store recomputed value.
    _require_percent(raw, "memory_percent")
    memory_percent = _recompute_percent(memory_used, memory_total)

    disk_total = _require_int(raw, "disk_total_bytes", minimum=1)
    disk_used = _require_int(raw, "disk_used_bytes", minimum=0)
    if disk_used > disk_total:
        raise TelemetryValidationError("disk_used_bytes exceeds disk_total_bytes")
    _require_percent(raw, "disk_percent")
    disk_percent = _recompute_percent(disk_used, disk_total)

    uptime_seconds = _require_int(raw, "uptime_seconds", minimum=0)

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


def _require_percent(raw: dict[str, Any], field: str) -> float:
    return require_number(
        raw.get(field), field=field, error=TelemetryValidationError, minimum=0.0, maximum=100.0
    )


def _require_int(raw: dict[str, Any], field: str, *, minimum: int) -> int:
    return require_integer(
        raw.get(field),
        field=field,
        error=TelemetryValidationError,
        minimum=minimum,
        allow_integral_float=True,
    )


def _recompute_percent(used: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((used / total) * 100.0, 2)

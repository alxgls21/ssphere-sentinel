"""Validate and store agent telemetry snapshots."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Any

from django.conf import settings
from django.db import DatabaseError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from apps.core.validation import MAX_FUTURE_SKEW, parse_timestamp, require_integer, require_number
from apps.infrastructure.models import Server, ServerTelemetry, ServerTelemetrySample

logger = logging.getLogger("apps.infrastructure")

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


def sample_slot(collected_at: datetime) -> datetime:
    """``collected_at`` floored to the sample grid (``SENTINEL_TELEMETRY_SAMPLE_SECONDS``), in UTC."""
    step = int(settings.SENTINEL_TELEMETRY_SAMPLE_SECONDS)
    seconds = int(collected_at.timestamp()) // step * step
    return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)


def record_telemetry_sample(
    server: Server, validated: ValidatedTelemetry, *, received_at: datetime
) -> bool:
    """Add the sample to the server's history; ``False`` if it was skipped (too old) or the write failed.

    A slot that is already taken is not reported: that would take a read.

    One ``INSERT ... ON CONFLICT DO NOTHING``: the first sample of a slot
    wins, a repeated or out-of-order one for a taken slot is dropped without
    a write, and nothing is read first. A sample older than the retention
    period would be purged at once and is not stored. The history is
    secondary to the heartbeat: a failure here is logged and never fails the
    report or undoes the snapshot. Heartbeats run in autocommit, where the
    insert is a single statement; inside a surrounding transaction it gets a
    savepoint, so a failed statement cannot poison that transaction. (The
    foreign key is checked at commit, so there a vanished server surfaces at
    the commit instead; heartbeats are not in a transaction.)
    """
    retention = timedelta(days=int(settings.SENTINEL_TELEMETRY_RETENTION_DAYS))
    if validated.collected_at < received_at - retention:
        return False
    values = (
        server.pk,
        sample_slot(validated.collected_at),
        validated.cpu_percent,
        validated.memory_percent,
        validated.disk_percent,
    )
    try:
        if connection.in_atomic_block:
            with transaction.atomic():
                _insert_sample(values)
        else:
            _insert_sample(values)
    except DatabaseError:
        logger.exception("Could not store a telemetry sample for server %s", server.pk)
        return False
    return True


def _insert_sample(values: tuple) -> None:
    """The one statement of the history write.

    Written out rather than ``bulk_create(ignore_conflicts=True)``, which wraps
    the same INSERT in its own BEGIN and COMMIT: two more round trips per
    heartbeat for nothing. Parameterised, with names taken from the model.
    """
    meta = ServerTelemetrySample._meta
    quote = connection.ops.quote_name
    columns = ", ".join(quote(name) for name in ("server_id", "sampled_at", "cpu_percent", "memory_percent", "disk_percent"))
    with connection.cursor() as cursor:
        cursor.execute(
            f"INSERT INTO {quote(meta.db_table)} ({columns}) VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
            values,
        )


def upsert_server_telemetry(
    server: Server,
    validated: ValidatedTelemetry,
    *,
    received_at: datetime | None = None,
) -> None:
    """Store a validated report: the latest snapshot (one UPDATE once it exists) and a history sample.

    The snapshot only moves forward: a report collected before the one it
    holds (a delayed or out-of-order heartbeat) leaves it alone, but still
    enters the history. A snapshot not refreshed for longer than the accepted
    clock skew gives way to any report, so an agent whose clock stepped back
    is not ignored for as long as the step.
    """
    received = received_at if received_at is not None else timezone.now()
    _upsert_snapshot(server, validated, received)
    record_telemetry_sample(server, validated, received_at=received)


def _upsert_snapshot(server: Server, validated: ValidatedTelemetry, received: datetime) -> None:
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
    # A report replaces the snapshot when it was collected at or after it, or when the snapshot
    # itself has not been refreshed for longer than the clock skew we accept. The first rule keeps
    # a delayed or out-of-order report from replacing newer data; the second lets the snapshot
    # recover when an agent's clock steps back (every later report would otherwise look "older").
    stale_before = received - MAX_FUTURE_SKEW
    replaceable = Q(collected_at__lte=validated.collected_at) | Q(received_at__lt=stale_before)
    if ServerTelemetry.objects.filter(replaceable, server=server).update(**defaults):
        return  # the steady state: one UPDATE
    # Nothing was updated: there is no snapshot yet, or it is newer. One statement settles both,
    # and a concurrent first report cannot make the older of two win.
    _insert_or_replace_snapshot(server, defaults, stale_before)


def _insert_or_replace_snapshot(server: Server, values: dict[str, Any], stale_before: datetime) -> None:
    meta = ServerTelemetry._meta
    quote = connection.ops.quote_name
    table = quote(meta.db_table)
    names = list(values)
    columns = ", ".join(quote(name) for name in ("server_id", *names))
    assignments = ", ".join(f"{quote(name)} = EXCLUDED.{quote(name)}" for name in names)
    with connection.cursor() as cursor:
        cursor.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({', '.join(['%s'] * (len(names) + 1))}) "
            f"ON CONFLICT ({quote('server_id')}) DO UPDATE SET {assignments} "
            f"WHERE {table}.{quote('collected_at')} <= EXCLUDED.{quote('collected_at')} "
            f"OR {table}.{quote('received_at')} < %s",
            [server.pk, *values.values(), stale_before],
        )


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

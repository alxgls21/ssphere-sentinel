"""Validate and persist agent network measurement reports."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.agents.models import Agent
from apps.network.models import NetworkMeasurement, NetworkTarget

SUPPORTED_NETWORK_VERSION = 1
MAX_MEASUREMENTS_PER_REPORT = 100
MAX_FUTURE_SKEW = timedelta(minutes=5)
ALLOWED_FAILURE_REASONS = frozenset(
    value for value, _label in NetworkMeasurement.FailureReason.choices
)


class NetworkValidationError(Exception):
    """Raised when a network payload is invalid."""


def measurement_acceptance_window() -> timedelta:
    """How old a delayed measurement may be and still be stored.

    Capped at the retention period: older rows would be purged right away.
    """
    days = min(
        settings.SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS,
        settings.SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS,
    )
    return timedelta(days=days)


@dataclass(frozen=True)
class ValidatedMeasurement:
    measurement_id: UUID
    target_id: UUID
    measured_at: datetime
    success: bool
    latency_ms: float | None
    packet_loss_percentage: float
    probe_count: int
    successful_probes: int
    failure_reason: str


@dataclass(frozen=True)
class MeasurementRejection:
    """A single measurement that was not stored, with a safe reason."""

    measurement_id: str | None
    reason: str
    # True only for server-side storage failures that may succeed on resend.
    # Validation failures are permanent: resending the same data cannot pass.
    retryable: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "measurement_id": self.measurement_id,
            "reason": self.reason,
            "retryable": self.retryable,
        }


@dataclass(frozen=True)
class ValidatedNetworkReport:
    measurements: tuple[ValidatedMeasurement, ...]
    rejections: tuple[MeasurementRejection, ...] = ()


@dataclass(frozen=True)
class NetworkIngestResult:
    created: int
    duplicates: int
    rejections: tuple[MeasurementRejection, ...]
    created_ids: tuple[str, ...] = ()
    duplicate_ids: tuple[str, ...] = ()

    def results(self) -> list[dict[str, Any]]:
        """Per-measurement acknowledgement, one entry per identifiable ID.

        Lets agents remove exactly the measurements that are stored
        (``created``/``duplicate``) and decide per rejection whether to resend.
        Rejections without a parseable ID, and repeats of an ID already listed
        (for example a duplicate inside one report), are omitted so every ID
        appears at most once.
        """
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for result, ids in (("created", self.created_ids), ("duplicate", self.duplicate_ids)):
            for measurement_id in ids:
                seen.add(measurement_id)
                entries.append({"measurement_id": measurement_id, "result": result})
        for rejection in self.rejections:
            if rejection.measurement_id is None or rejection.measurement_id in seen:
                continue
            seen.add(rejection.measurement_id)
            entries.append({"result": "rejected", **rejection.as_dict()})
        return entries

    @property
    def accepted(self) -> int:
        """Measurements now stored server-side (new rows plus idempotent retries)."""
        return self.created + self.duplicates

    @property
    def rejected(self) -> int:
        return len(self.rejections)

    @property
    def status(self) -> str:
        if not self.rejections:
            return "accepted"
        if self.accepted == 0:
            return "rejected"
        return "partial"


def validate_network_payload(
    raw: Any,
    *,
    agent: Agent,
) -> ValidatedNetworkReport:
    """Validate the report envelope, then each measurement independently.

    Envelope problems (wrong type/version, too many items) raise
    ``NetworkValidationError`` and reject the whole section. Problems with an
    individual measurement are collected as rejections without affecting the
    other measurements in the same report.
    """
    if not isinstance(raw, dict):
        raise NetworkValidationError("network must be an object")

    version = raw.get("version")
    if version != SUPPORTED_NETWORK_VERSION:
        raise NetworkValidationError(
            f"unsupported network version (expected {SUPPORTED_NETWORK_VERSION})"
        )

    measurements_raw = raw.get("measurements")
    if not isinstance(measurements_raw, list):
        raise NetworkValidationError("measurements must be a list")
    if len(measurements_raw) > MAX_MEASUREMENTS_PER_REPORT:
        raise NetworkValidationError(
            f"measurements exceeds maximum of {MAX_MEASUREMENTS_PER_REPORT}"
        )

    targets = NetworkTarget.objects.in_bulk(
        {
            target_id
            for item in measurements_raw
            if (target_id := _peek_uuid(item, "target_id")) is not None
        }
    )

    oldest_allowed = timezone.now() - measurement_acceptance_window()
    seen_ids: set[UUID] = set()
    validated: list[ValidatedMeasurement] = []
    rejections: list[MeasurementRejection] = []
    for item in measurements_raw:
        peeked_id = _peek_uuid(item, "measurement_id")
        safe_id = str(peeked_id) if peeked_id is not None else None
        try:
            measurement = _validate_measurement(
                item, agent=agent, targets=targets, oldest_allowed=oldest_allowed
            )
        except NetworkValidationError as exc:
            rejections.append(MeasurementRejection(safe_id, str(exc)))
            continue
        if measurement.measurement_id in seen_ids:
            rejections.append(
                MeasurementRejection(safe_id, "duplicate measurement_id in report")
            )
            continue
        seen_ids.add(measurement.measurement_id)
        validated.append(measurement)

    return ValidatedNetworkReport(
        measurements=tuple(validated),
        rejections=tuple(rejections),
    )


@transaction.atomic
def apply_network_report(
    agent: Agent,
    report: ValidatedNetworkReport,
    *,
    received_at: datetime | None = None,
) -> NetworkIngestResult:
    """Store validated measurements and classify every one of them.

    IDs that already exist are classified up front (one query); the rest are
    inserted with a single multi-row INSERT. Only if that INSERT fails (for
    example a concurrent report stored the same ID) are the rows inserted one
    by one, so each measurement still gets an exact outcome. ``created`` is
    only reported for rows the INSERT actually stored.
    """
    received = received_at if received_at is not None else timezone.now()
    created_ids: list[str] = []
    duplicate_ids: list[str] = []
    rejections = list(report.rejections)

    stored = _stored_measurements([item.measurement_id for item in report.measurements])
    pending: list[ValidatedMeasurement] = []
    for item in report.measurements:
        if item.measurement_id not in stored:
            pending.append(item)
            continue
        owner_id, target_id = stored[item.measurement_id]
        if _is_same_measurement(item, agent, owner_id, target_id):
            duplicate_ids.append(str(item.measurement_id))
        else:
            rejections.append(_conflict(item))

    if pending:
        rows = [_measurement_row(item, agent, received) for item in pending]
        try:
            with transaction.atomic():
                NetworkMeasurement.objects.bulk_create(rows)
        except IntegrityError:
            _insert_individually(
                pending, agent, received, created_ids, duplicate_ids, rejections
            )
        else:
            created_ids.extend(str(item.measurement_id) for item in pending)

    return NetworkIngestResult(
        created=len(created_ids),
        duplicates=len(duplicate_ids),
        rejections=tuple(rejections),
        created_ids=tuple(created_ids),
        duplicate_ids=tuple(duplicate_ids),
    )


def _stored_measurements(ids: list[UUID]) -> dict[UUID, tuple[UUID | None, UUID]]:
    """Map already-stored measurement IDs to their (agent_id, target_id)."""
    if not ids:
        return {}
    return {
        pk: (agent_id, target_id)
        for pk, agent_id, target_id in NetworkMeasurement.objects.filter(pk__in=ids)
        .order_by()
        .values_list("pk", "agent_id", "target_id")
    }


def _measurement_row(
    item: ValidatedMeasurement, agent: Agent, received: datetime
) -> NetworkMeasurement:
    return NetworkMeasurement(
        id=item.measurement_id,
        target_id=item.target_id,
        agent=agent,
        measured_at=item.measured_at,
        received_at=received,
        success=item.success,
        latency_ms=item.latency_ms,
        packet_loss_percentage=item.packet_loss_percentage,
        probe_count=item.probe_count,
        successful_probes=item.successful_probes,
        failure_reason=item.failure_reason,
    )


def _is_same_measurement(
    item: ValidatedMeasurement,
    agent: Agent,
    owner_id: UUID | None,
    target_id: UUID,
) -> bool:
    """Whether an already-stored row is this agent's earlier copy of ``item``.

    Rows whose agent was deleted (``agent_id`` NULL) count as the same
    measurement when they belong to the same target, so a recreated agent
    resending its queue is acknowledged instead of retried forever.
    """
    if owner_id == agent.id:
        return True
    return owner_id is None and target_id == item.target_id


def _conflict(item: ValidatedMeasurement) -> MeasurementRejection:
    return MeasurementRejection(str(item.measurement_id), "measurement_id conflict")


def _insert_individually(
    items: list[ValidatedMeasurement],
    agent: Agent,
    received: datetime,
    created_ids: list[str],
    duplicate_ids: list[str],
    rejections: list[MeasurementRejection],
) -> None:
    """Fallback after a failed bulk INSERT: one savepoint per measurement."""
    for item in items:
        try:
            with transaction.atomic():
                _measurement_row(item, agent, received).save(force_insert=True)
        except IntegrityError:
            stored = (
                NetworkMeasurement.objects.filter(pk=item.measurement_id)
                .values_list("agent_id", "target_id")
                .first()
            )
            if stored is None:
                # Not a duplicate (e.g. the target was deleted meanwhile).
                rejections.append(
                    MeasurementRejection(
                        str(item.measurement_id),
                        "measurement could not be stored",
                        retryable=True,
                    )
                )
            elif _is_same_measurement(item, agent, *stored):
                duplicate_ids.append(str(item.measurement_id))
            else:
                rejections.append(_conflict(item))
        else:
            created_ids.append(str(item.measurement_id))


def _peek_uuid(raw: Any, field: str) -> UUID | None:
    """Best-effort UUID extraction used for lookups and safe echoing only."""
    if not isinstance(raw, dict):
        return None
    try:
        return _parse_uuid(raw.get(field), field=field)
    except NetworkValidationError:
        return None


def _validate_measurement(
    raw: Any,
    *,
    agent: Agent,
    targets: dict[UUID, NetworkTarget],
    oldest_allowed: datetime,
) -> ValidatedMeasurement:
    if not isinstance(raw, dict):
        raise NetworkValidationError("each measurement must be an object")

    measurement_id = _parse_uuid(raw.get("measurement_id"), field="measurement_id")
    target_id = _parse_uuid(raw.get("target_id"), field="target_id")

    target = targets.get(target_id)
    if target is None:
        raise NetworkValidationError(f"unknown target_id: {target_id}")

    if target.assigned_agent_id != agent.id:
        raise NetworkValidationError(
            "target is not assigned to the reporting agent"
        )
    if not target.enabled:
        raise NetworkValidationError("target is disabled")

    measured_at = _parse_timestamp(raw.get("measured_at"), field="measured_at")
    if measured_at < oldest_allowed:
        raise NetworkValidationError(
            "measured_at is older than the accepted history window"
        )

    success = raw.get("success")
    if not isinstance(success, bool):
        raise NetworkValidationError("success must be a boolean")

    probe_count = _require_int(raw, "probe_count", minimum=1, maximum=20)
    successful_probes = _require_int(
        raw, "successful_probes", minimum=0, maximum=probe_count
    )
    packet_loss = _require_float(
        raw, "packet_loss_percentage", minimum=0.0, maximum=100.0
    )

    latency_raw = raw.get("latency_ms")
    if latency_raw is None:
        latency_ms = None
    else:
        latency_ms = _require_float_value(
            latency_raw, field="latency_ms", minimum=0.0, maximum=600_000.0
        )

    if success and successful_probes == 0:
        raise NetworkValidationError(
            "successful measurements require successful_probes > 0"
        )
    if success and latency_ms is None:
        raise NetworkValidationError("successful measurements require latency_ms")
    if not success and latency_ms is not None and successful_probes == 0:
        # Allow null latency on total failure; reject latency without successes.
        raise NetworkValidationError(
            "latency_ms requires successful_probes > 0"
        )

    failure_reason = raw.get("failure_reason", "")
    if failure_reason is None:
        failure_reason = ""
    if not isinstance(failure_reason, str):
        raise NetworkValidationError("failure_reason must be a string")
    if failure_reason not in ALLOWED_FAILURE_REASONS:
        raise NetworkValidationError("failure_reason is invalid")
    if success and failure_reason:
        raise NetworkValidationError(
            "successful measurements must not set failure_reason"
        )

    expected_loss = round(
        ((probe_count - successful_probes) / probe_count) * 100.0, 2
    )
    if abs(expected_loss - round(packet_loss, 2)) > 0.51:
        raise NetworkValidationError(
            "packet_loss_percentage does not match probe counts"
        )

    return ValidatedMeasurement(
        measurement_id=measurement_id,
        target_id=target_id,
        measured_at=measured_at,
        success=success,
        latency_ms=latency_ms,
        packet_loss_percentage=round(packet_loss, 2),
        probe_count=probe_count,
        successful_probes=successful_probes,
        failure_reason=failure_reason,
    )


def _parse_uuid(value: Any, *, field: str) -> UUID:
    if not isinstance(value, str) or not value.strip():
        raise NetworkValidationError(f"{field} must be a UUID string")
    try:
        return UUID(value.strip())
    except ValueError as exc:
        raise NetworkValidationError(f"{field} must be a UUID string") from exc


def _parse_timestamp(value: Any, *, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise NetworkValidationError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = parse_datetime(value.strip())
    except ValueError:
        parsed = None
    if parsed is None:
        raise NetworkValidationError(f"{field} must be an ISO-8601 timestamp")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, dt_timezone.utc)
    if parsed > timezone.now() + MAX_FUTURE_SKEW:
        raise NetworkValidationError(f"{field} is too far in the future")
    return parsed


def _require_int(raw: dict[str, Any], field: str, *, minimum: int, maximum: int) -> int:
    value = raw.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise NetworkValidationError(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise NetworkValidationError(
            f"{field} must be between {minimum} and {maximum}"
        )
    return value


def _require_float(
    raw: dict[str, Any],
    field: str,
    *,
    minimum: float,
    maximum: float,
) -> float:
    return _require_float_value(
        raw.get(field), field=field, minimum=minimum, maximum=maximum
    )


def _require_float_value(
    value: Any,
    *,
    field: str,
    minimum: float,
    maximum: float,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise NetworkValidationError(f"{field} must be a number")
    number = float(value)
    if number < minimum or number > maximum:
        raise NetworkValidationError(
            f"{field} must be between {minimum} and {maximum}"
        )
    return number

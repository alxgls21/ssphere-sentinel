"""Validate and persist SNMP poll reports from agents.

A report is the ``snmp`` section of a heartbeat: a list of *polls*, each the
result of polling one device (reachability, system information and interface
counters). See docs/snmp.md for the payload.

Guarantees:

- **Ownership**: a poll is accepted only for a device that is assigned to the
  reporting agent, enabled, and has an SNMP configuration.
- **Idempotency**: ``poll_id`` is the idempotency key. A poll that is already
  stored is acknowledged as a duplicate; nothing is written twice.
- **Out-of-order delivery**: polls are stored in any order. The latest state
  of a device and its interfaces only moves forward, from a poll newer than
  the newest one applied so far.
- **All-or-nothing per poll**: a poll's history row, interface samples,
  interface changes and device state are stored together or not at all, and
  every poll gets an exact outcome (created, duplicate or rejected). A poll
  is never acknowledged unless it is committed.
- **Lock protocol**: before anything else, the devices of the report are
  locked and their ownership re-checked, then their state rows are locked,
  both in primary-key order and held until commit. Every report takes the
  same locks in the same order, including the per-poll fallback (which must
  not re-lock in report order: that deadlocks with concurrent reports).
- **Bounded work**: a fixed number of queries per report, independent of the
  number of polls and interfaces.
- **No secrets**: only the fields below are read; anything else in the
  payload is ignored and never stored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.agents.models import Agent
from apps.core.validation import parse_timestamp, parse_uuid, peek_uuid, require_integer, require_number
from apps.inventory.models import Device
from apps.snmp.models import (
    COUNTER_FIELDS,
    DELTA_STATES_WITH_VALUES,
    MAX_BIGINT,
    AdminStatus,
    DeltaState,
    DevicePoll,
    DeviceSnmpState,
    Interface,
    InterfaceSample,
    OctetsBits,
    OperStatus,
    PollError,
)

SUPPORTED_SNMP_VERSION = 1
MAX_POLLS_PER_REPORT = 50
MAX_INTERFACES_PER_POLL = 512
MAX_INTERFACES_PER_REPORT = 2000
MAX_RESPONSE_MS = 600_000.0
MAX_SAMPLE_INTERVAL_SECONDS = 7 * 24 * 3600
MAX_IF_INDEX = 2**31 - 1
MAX_IF_TYPE = 65_535
MAX_SPEED_BPS = 10**15
MAX_UPTIME_TICKS = 2**32 - 1  # sysUpTime is a 32-bit TimeTicks value
MAX_COUNTER32 = 2**32 - 1
NAME_MAX = 255
SYS_DESCR_MAX = 1024
OID_MAX = 255
BULK_BATCH_SIZE = 1000

_OID_RE = re.compile(r"^[0-9]+(\.[0-9]+){1,127}$")
_ALLOWED_ERRORS = frozenset(PollError.values)
_ALLOWED_DELTA_STATES = frozenset(DeltaState.values)
_ADMIN_STATUSES = frozenset(AdminStatus.values)
_OPER_STATUSES = frozenset(OperStatus.values)
_OCTET_FIELDS = frozenset({"in_octets", "out_octets"})

_STATE_FIELDS = [
    "last_poll_at",
    "last_success_at",
    "last_discovery_at",
    "received_at",
    "reachable",
    "error",
    "response_ms",
    "sys_uptime_ticks",
    "sys_name",
    "sys_descr",
    "sys_object_id",
]
_INTERFACE_FIELDS = [
    "name",
    "descr",
    "alias",
    "if_type",
    "speed_bps",
    "admin_status",
    "oper_status",
    "oper_status_changed_at",
    "present",
]


class SnmpValidationError(Exception):
    """Raised when an SNMP payload (or one poll of it) is invalid.

    ``retryable`` is for rejections that resending the same poll later can
    cure: they depend on server state (a device that has not been created,
    assigned or enabled yet) or on the clock, not on the data itself.
    """

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class _FutureTimestampError(SnmpValidationError):
    """A timestamp the server clock will catch up with."""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


REASON_UNKNOWN_DEVICE = "unknown device_id or device not assigned to this agent"
REASON_DEVICE_DISABLED = "device is disabled"
REASON_NO_SNMP_CONFIG = "device has no SNMP configuration"


def poll_acceptance_window() -> timedelta:
    """How old a delayed poll may be and still be stored.

    Capped at the retention period: older rows would be purged right away.
    """
    days = min(
        settings.SENTINEL_SNMP_MAX_AGE_DAYS,
        settings.SENTINEL_SNMP_RETENTION_DAYS,
    )
    return timedelta(days=days)


# --- validated data ---------------------------------------------------------


@dataclass(frozen=True)
class ValidatedCounters:
    octets_bits: int
    delta_state: str
    interval_seconds: float | None
    raw: dict[str, int | None]
    delta: dict[str, int | None]


@dataclass(frozen=True)
class ValidatedInterface:
    if_index: int
    name: str
    descr: str
    alias: str
    if_type: int
    speed_bps: int | None
    admin_status: int
    oper_status: int
    counters: ValidatedCounters | None


@dataclass(frozen=True)
class ValidatedSystem:
    name: str | None
    descr: str | None
    object_id: str | None


@dataclass(frozen=True)
class ValidatedPoll:
    poll_id: UUID
    device_id: UUID
    measured_at: datetime
    reachable: bool
    response_ms: float | None
    error: str
    sys_uptime_ticks: int | None
    system: ValidatedSystem | None
    interfaces_complete: bool
    interfaces: tuple[ValidatedInterface, ...]


@dataclass(frozen=True)
class PollRejection:
    """A poll that was not stored, with a safe reason."""

    poll_id: str | None
    reason: str
    # True only for server-side storage failures that may succeed on resend.
    # Validation failures are permanent: resending the same data cannot pass.
    retryable: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "poll_id": self.poll_id,
            "reason": self.reason,
            "retryable": self.retryable,
        }


@dataclass(frozen=True)
class ValidatedSnmpReport:
    polls: tuple[ValidatedPoll, ...]
    rejections: tuple[PollRejection, ...] = ()


@dataclass(frozen=True)
class SnmpIngestResult:
    created: int
    duplicates: int
    rejections: tuple[PollRejection, ...]
    created_ids: tuple[str, ...] = ()
    duplicate_ids: tuple[str, ...] = ()

    def results(self) -> list[dict[str, Any]]:
        """Per-poll acknowledgement, one entry per identifiable poll ID.

        Lets agents remove exactly the polls that are stored (``created`` or
        ``duplicate``) and decide per rejection whether to resend. Rejections
        without a parseable ID, and repeats of an ID already listed, are
        omitted so every ID appears at most once.
        """
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for result, ids in (("created", self.created_ids), ("duplicate", self.duplicate_ids)):
            for poll_id in ids:
                seen.add(poll_id)
                entries.append({"poll_id": poll_id, "result": result})
        for rejection in self.rejections:
            if rejection.poll_id is None or rejection.poll_id in seen:
                continue
            seen.add(rejection.poll_id)
            entries.append({"result": "rejected", **rejection.as_dict()})
        return entries

    @property
    def accepted(self) -> int:
        """Polls now stored server-side (new rows plus idempotent retries)."""
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


# --- validation -------------------------------------------------------------


def validate_snmp_payload(raw: Any, *, agent: Agent) -> ValidatedSnmpReport:
    """Validate the report envelope, then each poll independently.

    Envelope problems (wrong type or version, too many items) raise
    ``SnmpValidationError`` and reject the whole section. Problems with an
    individual poll are collected as rejections without affecting the others.
    """
    if not isinstance(raw, dict):
        raise SnmpValidationError("snmp must be an object")
    version = raw.get("version")
    # Exactly the integer 1 (``True`` and ``1.0`` compare equal to 1).
    if type(version) is not int or version != SUPPORTED_SNMP_VERSION:
        raise SnmpValidationError(
            f"unsupported snmp version (expected {SUPPORTED_SNMP_VERSION})"
        )
    polls_raw = raw.get("polls")
    if not isinstance(polls_raw, list):
        raise SnmpValidationError("polls must be a list")
    if len(polls_raw) > MAX_POLLS_PER_REPORT:
        raise SnmpValidationError(f"polls exceeds maximum of {MAX_POLLS_PER_REPORT}")
    interface_total = sum(
        len(item["interfaces"])
        for item in polls_raw
        if isinstance(item, dict) and isinstance(item.get("interfaces"), list)
    )
    if interface_total > MAX_INTERFACES_PER_REPORT:
        raise SnmpValidationError(
            f"interfaces exceeds maximum of {MAX_INTERFACES_PER_REPORT} per report"
        )

    devices = Device.objects.select_related("snmp_config").in_bulk(
        {
            device_id
            for item in polls_raw
            if (device_id := peek_uuid(item, "device_id")) is not None
        }
    )
    oldest_allowed = timezone.now() - poll_acceptance_window()
    seen_ids: set[UUID] = set()
    seen_times: set[tuple[UUID, datetime]] = set()
    validated: list[ValidatedPoll] = []
    rejections: list[PollRejection] = []
    for item in polls_raw:
        peeked = peek_uuid(item, "poll_id")
        safe_id = str(peeked) if peeked is not None else None
        try:
            poll = _validate_poll(item, agent=agent, devices=devices, oldest_allowed=oldest_allowed)
        except SnmpValidationError as exc:
            rejections.append(PollRejection(safe_id, str(exc), retryable=exc.retryable))
            continue
        if poll.poll_id in seen_ids:
            rejections.append(PollRejection(safe_id, "duplicate poll_id in report"))
            continue
        if (poll.device_id, poll.measured_at) in seen_times:
            rejections.append(PollRejection(safe_id, "duplicate poll for this device and time in report"))
            continue
        seen_ids.add(poll.poll_id)
        seen_times.add((poll.device_id, poll.measured_at))
        validated.append(poll)
    return ValidatedSnmpReport(polls=tuple(validated), rejections=tuple(rejections))


def _validate_poll(
    raw: Any,
    *,
    agent: Agent,
    devices: dict[UUID, Device],
    oldest_allowed: datetime,
) -> ValidatedPoll:
    if not isinstance(raw, dict):
        raise SnmpValidationError("each poll must be an object")

    poll_id = parse_uuid(raw.get("poll_id"), field="poll_id", error=SnmpValidationError)
    device_id = parse_uuid(raw.get("device_id"), field="device_id", error=SnmpValidationError)
    _check_device(devices.get(device_id), agent)

    measured_at = parse_timestamp(
        raw.get("measured_at"),
        field="measured_at",
        error=SnmpValidationError,
        future_error=_FutureTimestampError,
    )
    if measured_at < oldest_allowed:
        raise SnmpValidationError("measured_at is older than the accepted history window")

    reachable = raw.get("reachable")
    if not isinstance(reachable, bool):
        raise SnmpValidationError("reachable must be a boolean")

    response_ms = _optional_number(raw.get("response_ms"), "response_ms", 0.0, MAX_RESPONSE_MS)
    sys_uptime_ticks = _optional_integer(
        raw.get("sys_uptime_ticks"), "sys_uptime_ticks", 0, MAX_UPTIME_TICKS
    )

    error = raw.get("error", "")
    if error is None:
        error = ""
    if not isinstance(error, str) or error not in _ALLOWED_ERRORS:
        raise SnmpValidationError("error is invalid")
    if reachable and error:
        raise SnmpValidationError("a reachable device must not set error")

    system = _validate_system(raw.get("system"))
    interfaces_raw = raw.get("interfaces", [])
    if interfaces_raw is None:
        interfaces_raw = []
    if not isinstance(interfaces_raw, list):
        raise SnmpValidationError("interfaces must be a list")
    if len(interfaces_raw) > MAX_INTERFACES_PER_POLL:
        raise SnmpValidationError(f"interfaces exceeds maximum of {MAX_INTERFACES_PER_POLL}")
    if not reachable and (system is not None or interfaces_raw or sys_uptime_ticks is not None):
        raise SnmpValidationError(
            "an unreachable device cannot report system information, uptime or interfaces"
        )

    interfaces: list[ValidatedInterface] = []
    seen_indexes: set[int] = set()
    for item in interfaces_raw:
        interface = _validate_interface(item)
        if interface.if_index in seen_indexes:
            raise SnmpValidationError(f"duplicate if_index {interface.if_index} in poll")
        seen_indexes.add(interface.if_index)
        interfaces.append(interface)

    complete = raw.get("interfaces_complete", False)
    if not isinstance(complete, bool):
        raise SnmpValidationError("interfaces_complete must be a boolean")
    if complete and not reachable:
        raise SnmpValidationError("interfaces_complete requires a reachable device")

    return ValidatedPoll(
        poll_id=poll_id,
        device_id=device_id,
        measured_at=measured_at,
        reachable=reachable,
        response_ms=response_ms,
        error=error,
        sys_uptime_ticks=sys_uptime_ticks,
        system=system,
        interfaces_complete=complete,
        interfaces=tuple(interfaces),
    )


def _device_problem(device: Device | None, agent: Agent) -> str | None:
    """Why ``device`` cannot take polls from ``agent`` right now (None if it can)."""
    # One message for "unknown" and "not yours": an agent learns nothing
    # about devices it is not assigned to.
    if device is None or device.assigned_agent_id != agent.id:
        return REASON_UNKNOWN_DEVICE
    if not device.enabled:
        return REASON_DEVICE_DISABLED
    try:
        device.snmp_config
    except ObjectDoesNotExist:
        return REASON_NO_SNMP_CONFIG
    return None


def _check_device(device: Device | None, agent: Agent) -> None:
    problem = _device_problem(device, agent)
    if problem is not None:
        # All of these depend on server state that an operator can change
        # (create, assign, enable or configure the device): a later resend
        # may be accepted, so the agent should not drop the poll.
        raise SnmpValidationError(problem, retryable=True)


def _validate_system(raw: Any) -> ValidatedSystem | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SnmpValidationError("system must be an object")
    object_id = raw.get("object_id")
    if object_id is not None:
        if not isinstance(object_id, str) or len(object_id) > OID_MAX or not _OID_RE.fullmatch(object_id):
            raise SnmpValidationError("system.object_id must be a dotted OID")
    # Device-provided text is cleaned and truncated, not rejected: a long or
    # multi-line sysDescr must not make a whole poll fail.
    return ValidatedSystem(
        name=_clean_text(raw.get("name"), "system.name", NAME_MAX),
        descr=_clean_text(raw.get("descr"), "system.descr", SYS_DESCR_MAX),
        object_id=object_id,
    )


def _validate_interface(raw: Any) -> ValidatedInterface:
    if not isinstance(raw, dict):
        raise SnmpValidationError("each interface must be an object")
    if_index = _integer(raw.get("if_index"), "if_index", 1, MAX_IF_INDEX)
    label = f"interface {if_index}"

    # Device-provided text is cleaned, never a reason to lose a poll: a blank
    # ifName falls back to ifDescr, then to the index.
    name = _clean_text(raw.get("name"), f"{label}: name", NAME_MAX)
    descr = _clean_text(raw.get("descr"), f"{label}: descr", NAME_MAX) or ""
    name = name or descr or f"if{if_index}"
    alias = _clean_text(raw.get("alias"), f"{label}: alias", NAME_MAX) or ""
    if_type = _optional_integer(raw.get("if_type"), f"{label}: if_type", 0, MAX_IF_TYPE) or 0
    speed_bps = _optional_integer(raw.get("speed_bps"), f"{label}: speed_bps", 0, MAX_SPEED_BPS)

    admin_status = _integer(raw.get("admin_status"), f"{label}: admin_status", 1, 3)
    if admin_status not in _ADMIN_STATUSES:
        raise SnmpValidationError(f"{label}: admin_status is invalid")
    oper_status = _integer(raw.get("oper_status"), f"{label}: oper_status", 1, 7)
    if oper_status not in _OPER_STATUSES:
        raise SnmpValidationError(f"{label}: oper_status is invalid")

    counters_raw = raw.get("counters")
    counters = None if counters_raw is None else _validate_counters(counters_raw, label)
    return ValidatedInterface(
        if_index=if_index,
        name=name,
        descr=descr,
        alias=alias,
        if_type=if_type,
        speed_bps=speed_bps,
        admin_status=admin_status,
        oper_status=oper_status,
        counters=counters,
    )


def _validate_counters(raw: Any, label: str) -> ValidatedCounters:
    if not isinstance(raw, dict):
        raise SnmpValidationError(f"{label}: counters must be an object")

    bits = _integer(raw.get("octets_bits"), f"{label}: octets_bits", 32, 64)
    if bits not in (OctetsBits.BITS_32, OctetsBits.BITS_64):
        raise SnmpValidationError(f"{label}: octets_bits must be 32 or 64")
    delta_state = raw.get("delta_state")
    if not isinstance(delta_state, str) or delta_state not in _ALLOWED_DELTA_STATES:
        raise SnmpValidationError(f"{label}: delta_state is invalid")

    def limit(name: str) -> int:
        return MAX_BIGINT if name in _OCTET_FIELDS and bits == 64 else MAX_COUNTER32

    raw_counters = raw.get("raw")
    if not isinstance(raw_counters, dict):
        raise SnmpValidationError(f"{label}: counters.raw must be an object")
    raw_values = {
        name: _optional_integer(raw_counters.get(name), f"{label}: raw {name}", 0, limit(name))
        for name in COUNTER_FIELDS
    }

    delta_raw = raw.get("delta")
    interval = _optional_number(
        raw.get("interval_seconds"), f"{label}: interval_seconds", 0.0, float(MAX_SAMPLE_INTERVAL_SECONDS)
    )

    if delta_state in DELTA_STATES_WITH_VALUES:
        if interval is None:
            raise SnmpValidationError(f"{label}: interval_seconds is required when deltas are valid")
        if interval <= 0:
            raise SnmpValidationError(f"{label}: interval_seconds must be greater than 0")
        if not isinstance(delta_raw, dict):
            raise SnmpValidationError(f"{label}: counters.delta must be an object")
        delta_values = {
            name: _optional_integer(delta_raw.get(name), f"{label}: delta {name}", 0, limit(name))
            for name in COUNTER_FIELDS
        }
        for name in COUNTER_FIELDS:
            if delta_values[name] is not None and raw_values[name] is None:
                raise SnmpValidationError(f"{label}: delta {name} requires the raw counter")
    else:
        if interval is not None and interval <= 0:
            interval = None  # e.g. the first sample: there is no interval yet
        if isinstance(delta_raw, dict) and any(value is not None for value in delta_raw.values()):
            raise SnmpValidationError(f"{label}: deltas must be empty when delta_state is {delta_state}")
        if delta_raw is not None and not isinstance(delta_raw, dict):
            raise SnmpValidationError(f"{label}: counters.delta must be an object")
        delta_values = {name: None for name in COUNTER_FIELDS}

    return ValidatedCounters(
        octets_bits=bits,
        delta_state=delta_state,
        interval_seconds=interval,
        raw=raw_values,
        delta=delta_values,
    )


# --- storage ----------------------------------------------------------------


@transaction.atomic
def apply_snmp_report(
    agent: Agent,
    report: ValidatedSnmpReport,
    *,
    received_at: datetime | None = None,
) -> SnmpIngestResult:
    """Store validated polls and classify every one of them.

    Devices and their state rows are locked first (see the module docstring),
    and ownership is re-checked under the lock, because validation ran
    before it. IDs that already exist are then classified (one query); the rest
    are stored together in one savepoint. Only if that fails (for example a
    conflicting poll) are they stored one by one, each in its own savepoint,
    so every poll still gets an exact outcome. A poll is reported as
    ``created`` only when it was stored.
    """
    received = received_at if received_at is not None else timezone.now()
    created_ids: list[str] = []
    duplicate_ids: list[str] = []
    rejections = list(report.rejections)

    eligible: list[ValidatedPoll] = []
    states: dict[UUID, DeviceSnmpState] = {}
    if report.polls:
        problems = _lock_devices(agent, {poll.device_id for poll in report.polls})
        for poll in report.polls:
            problem = problems[poll.device_id]
            if problem is None:
                eligible.append(poll)
            else:
                # The device changed after validation: a resend may succeed.
                rejections.append(PollRejection(str(poll.poll_id), problem, retryable=True))
        usable = {poll.device_id for poll in eligible}
        if usable:
            states = _ensure_and_lock_states(usable)

    stored = _stored_polls([poll.poll_id for poll in eligible])
    pending: list[ValidatedPoll] = []
    for poll in eligible:
        if poll.poll_id not in stored:
            pending.append(poll)
        elif _is_same_poll(poll, stored[poll.poll_id]):
            duplicate_ids.append(str(poll.poll_id))
        else:
            rejections.append(_conflict(poll))

    if pending:
        try:
            with transaction.atomic():
                _store_polls(pending, received, states)
        except IntegrityError:
            _store_individually(pending, received, created_ids, duplicate_ids, rejections)
        else:
            created_ids.extend(str(poll.poll_id) for poll in pending)

    return SnmpIngestResult(
        created=len(created_ids),
        duplicates=len(duplicate_ids),
        rejections=tuple(rejections),
        created_ids=tuple(created_ids),
        duplicate_ids=tuple(duplicate_ids),
    )


def _lock_devices(agent: Agent, device_ids: set[UUID]) -> dict[UUID, str | None]:
    """Lock the devices in primary-key order; why each one cannot take polls.

    ``FOR NO KEY UPDATE`` keeps concurrent reports and admin edits of the same
    device from interleaving with this one, without blocking the foreign keys
    that history rows take on it.
    """
    rows = (
        Device.objects.select_for_update(of=("self",), no_key=True)
        .select_related("snmp_config")
        .filter(pk__in=device_ids)
        .order_by("pk")
    )
    found = {device.pk: _device_problem(device, agent) for device in rows}
    return {device_id: found.get(device_id, REASON_UNKNOWN_DEVICE) for device_id in device_ids}


def _ensure_and_lock_states(device_ids: set[UUID]) -> dict[UUID, DeviceSnmpState]:
    """Create missing state rows and lock all of them, always in sorted order.

    Inserting in a different order than another report would deadlock.
    """
    ordered = sorted(device_ids)
    DeviceSnmpState.objects.bulk_create(
        [DeviceSnmpState(device_id=device_id) for device_id in ordered],
        ignore_conflicts=True,
    )
    return _select_states(device_ids)


def _select_states(device_ids: set[UUID]) -> dict[UUID, DeviceSnmpState]:
    rows = (
        DeviceSnmpState.objects.select_for_update()
        .filter(device_id__in=device_ids)
        .order_by("device_id")
    )
    return {state.device_id: state for state in rows}


def _stored_polls(ids: list[UUID]) -> dict[UUID, tuple[UUID, datetime]]:
    """Map already-stored poll IDs to their (device_id, measured_at)."""
    if not ids:
        return {}
    return {
        pk: (device_id, measured_at)
        for pk, device_id, measured_at in DevicePoll.objects.filter(pk__in=ids)
        .order_by()
        .values_list("pk", "device_id", "measured_at")
    }


def _is_same_poll(poll: ValidatedPoll, stored: tuple[UUID, datetime]) -> bool:
    """Whether an already-stored row is an earlier copy of ``poll``.

    The agent is not part of the comparison: ownership was checked through the
    device, so a poll for the same device and time is a resend whichever agent
    (for example a recreated one resending its queue) sends it. A reused
    ``poll_id`` with a different device or time is a conflict, never a
    "duplicate", so its data is not silently discarded.
    """
    device_id, measured_at = stored
    return device_id == poll.device_id and measured_at == poll.measured_at


def _conflict(poll: ValidatedPoll) -> PollRejection:
    return PollRejection(str(poll.poll_id), "poll_id conflict")


def _store_individually(
    polls: list[ValidatedPoll],
    received: datetime,
    created_ids: list[str],
    duplicate_ids: list[str],
    rejections: list[PollRejection],
) -> None:
    """Fallback after a failed batch: one savepoint per poll.

    The locks taken by ``apply_snmp_report`` are still held (they were taken
    before the first savepoint), so no other report interleaves here; each
    attempt re-reads the state rows, which a rolled-back attempt may have left
    modified in memory.
    """
    for poll in polls:
        try:
            with transaction.atomic():
                _store_polls([poll], received)
        except IntegrityError:
            stored = (
                DevicePoll.objects.filter(pk=poll.poll_id)
                .values_list("device_id", "measured_at")
                .first()
            )
            if stored is not None:
                if _is_same_poll(poll, stored):
                    duplicate_ids.append(str(poll.poll_id))
                else:
                    rejections.append(_conflict(poll))
            elif DevicePoll.objects.filter(
                device_id=poll.device_id, measured_at=poll.measured_at
            ).exists():
                rejections.append(
                    PollRejection(
                        str(poll.poll_id),
                        "a different poll is already stored for this device and time",
                    )
                )
            else:
                # Not a duplicate. (A device deleted meanwhile does not land
                # here: PostgreSQL checks the deferred foreign keys at commit,
                # so the whole request fails and nothing is acknowledged.)
                rejections.append(
                    PollRejection(str(poll.poll_id), "poll could not be stored", retryable=True)
                )
        else:
            created_ids.append(str(poll.poll_id))


def _store_polls(
    polls: list[ValidatedPoll],
    received: datetime,
    states: dict[UUID, DeviceSnmpState] | None = None,
) -> None:
    """Store ``polls`` completely or raise (the caller rolls back its savepoint).

    A fixed number of queries whatever the number of polls and interfaces:
    insert the polls, load/create/update the interfaces, insert the samples,
    update the states. The device and state rows must already be locked by
    the caller; ``states`` are those rows (re-read when omitted).

    Two freshness rules keep late deliveries from moving anything backwards:
    the *reachability* state (reachable, error, response time, uptime) follows
    the newest poll, while the *data* a reachable poll carries (system
    information, interfaces) follows the newest reachable poll. A newer
    unreachable poll therefore does not hide interface data that is newer than
    anything stored.
    """
    polls = sorted(polls, key=lambda poll: poll.measured_at)
    if states is None:
        states = _select_states({poll.device_id for poll in polls})

    # First write: a duplicate or conflicting poll fails here, before anything
    # else has been changed.
    DevicePoll.objects.bulk_create(
        [
            DevicePoll(
                id=poll.poll_id,
                device_id=poll.device_id,
                measured_at=poll.measured_at,
                received_at=received,
                reachable=poll.reachable,
                response_ms=poll.response_ms,
                error=poll.error,
                sys_uptime_ticks=poll.sys_uptime_ticks,
            )
            for poll in polls
        ],
        batch_size=BULK_BATCH_SIZE,
    )

    interfaces = _interfaces_for(polls, states)
    dirty_interfaces: dict[int, Interface] = {}
    dirty_states: dict[UUID, DeviceSnmpState] = {}

    for poll in polls:  # ascending: later polls overwrite earlier ones
        state = states[poll.device_id]
        data_newer = poll.reachable and (
            state.last_success_at is None or poll.measured_at > state.last_success_at
        )
        state_newer = state.last_poll_at is None or poll.measured_at > state.last_poll_at

        if state_newer:
            _apply_poll_to_state(state, poll, received)
            dirty_states[poll.device_id] = state
        if not data_newer:
            continue  # stored as history only: newer data is already applied

        state.last_success_at = poll.measured_at
        dirty_states[poll.device_id] = state
        _apply_system(state, poll.system)
        listed = set()
        for entry in poll.interfaces:
            interface = interfaces[(poll.device_id, entry.if_index)]
            listed.add(entry.if_index)
            if _apply_entry(interface, entry, poll.measured_at):
                dirty_interfaces[interface.pk] = interface
        if poll.interfaces_complete:
            state.last_discovery_at = poll.measured_at
            for (device_id, if_index), interface in interfaces.items():
                if device_id == poll.device_id and if_index not in listed and interface.present:
                    interface.present = False
                    dirty_interfaces[interface.pk] = interface

    samples = [
        _sample(interfaces[(poll.device_id, entry.if_index)], poll, entry)
        for poll in polls
        for entry in poll.interfaces
        if entry.counters is not None
    ]
    if samples:
        InterfaceSample.objects.bulk_create(samples, batch_size=BULK_BATCH_SIZE)
    if dirty_interfaces:
        Interface.objects.bulk_update(
            list(dirty_interfaces.values()), _INTERFACE_FIELDS, batch_size=BULK_BATCH_SIZE
        )
    if dirty_states:
        DeviceSnmpState.objects.bulk_update(
            list(dirty_states.values()), _STATE_FIELDS, batch_size=BULK_BATCH_SIZE
        )


def _interfaces_for(
    polls: list[ValidatedPoll], states: dict[UUID, DeviceSnmpState]
) -> dict[tuple[UUID, int], Interface]:
    """The interfaces the polls refer to, creating the ones that do not exist yet.

    A poll that lists every interface (``interfaces_complete``) needs all of
    its device's interfaces, to find the ones that disappeared. An interface
    first seen in a poll older than the device's latest complete listing is
    created absent: that listing did not contain it.
    """
    newest: dict[tuple[UUID, int], tuple[datetime, ValidatedInterface]] = {}
    complete_devices: set[UUID] = set()
    for poll in polls:
        if poll.interfaces_complete:
            complete_devices.add(poll.device_id)
        for entry in poll.interfaces:
            newest[(poll.device_id, entry.if_index)] = (poll.measured_at, entry)
    if not newest and not complete_devices:
        return {}

    device_ids = {device_id for device_id, _index in newest}
    indexes = {index for _device_id, index in newest}

    def load() -> dict[tuple[UUID, int], Interface]:
        condition = Q(device_id__in=complete_devices)
        if newest:
            condition |= Q(device_id__in=device_ids, if_index__in=indexes)
        return {(i.device_id, i.if_index): i for i in Interface.objects.filter(condition)}

    interfaces = load()
    missing = [key for key in newest if key not in interfaces]
    if missing:
        rows = []
        for device_id, if_index in missing:
            measured_at, entry = newest[(device_id, if_index)]
            discovered = states[device_id].last_discovery_at
            rows.append(
                Interface(
                    device_id=device_id,
                    if_index=if_index,
                    name=entry.name,
                    descr=entry.descr,
                    alias=entry.alias,
                    if_type=entry.if_type,
                    speed_bps=entry.speed_bps,
                    admin_status=entry.admin_status,
                    oper_status=entry.oper_status,
                    present=discovered is None or measured_at >= discovered,
                )
            )
        Interface.objects.bulk_create(rows, ignore_conflicts=True, batch_size=BULK_BATCH_SIZE)
        interfaces = load()
    return interfaces


def _apply_poll_to_state(state: DeviceSnmpState, poll: ValidatedPoll, received: datetime) -> None:
    """The reachability state: it follows the newest poll, reachable or not."""
    state.last_poll_at = poll.measured_at
    state.received_at = received
    state.reachable = poll.reachable
    state.error = poll.error
    state.response_ms = poll.response_ms
    state.sys_uptime_ticks = poll.sys_uptime_ticks


def _apply_system(state: DeviceSnmpState, system: ValidatedSystem | None) -> None:
    """The device identity: it follows the newest *reachable* poll."""
    if system is None:
        return
    if system.name is not None:
        state.sys_name = system.name
    if system.descr is not None:
        state.sys_descr = system.descr
    if system.object_id is not None:
        state.sys_object_id = system.object_id


def _apply_entry(interface: Interface, entry: ValidatedInterface, measured_at: datetime) -> bool:
    """Copy the entry onto the interface; True if anything changed."""
    changed = False
    for attribute in ("name", "descr", "alias", "if_type", "speed_bps", "admin_status"):
        value = getattr(entry, attribute)
        if getattr(interface, attribute) != value:
            setattr(interface, attribute, value)
            changed = True
    if interface.oper_status != entry.oper_status:
        interface.oper_status = entry.oper_status
        interface.oper_status_changed_at = measured_at
        changed = True
    if not interface.present:
        interface.present = True
        changed = True
    return changed


def _sample(interface: Interface, poll: ValidatedPoll, entry: ValidatedInterface) -> InterfaceSample:
    counters = entry.counters
    assert counters is not None
    return InterfaceSample(
        interface=interface,
        measured_at=poll.measured_at,
        interval_seconds=counters.interval_seconds,
        admin_status=entry.admin_status,
        oper_status=entry.oper_status,
        speed_bps=entry.speed_bps,
        octets_bits=counters.octets_bits,
        delta_state=counters.delta_state,
        **counters.raw,
        **{f"{name}_delta": value for name, value in counters.delta.items()},
    )


# --- small helpers ----------------------------------------------------------


def _integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    return require_integer(
        value, field=field, error=SnmpValidationError, minimum=minimum, maximum=maximum
    )


def _optional_integer(value: Any, field: str, minimum: int, maximum: int) -> int | None:
    return None if value is None else _integer(value, field, minimum, maximum)


def _optional_number(value: Any, field: str, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    return require_number(
        value, field=field, error=SnmpValidationError, minimum=minimum, maximum=maximum
    )


def _clean_text(value: Any, field: str, max_length: int) -> str | None:
    """Printable text on one line, truncated; ``None`` stays ``None``."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise SnmpValidationError(f"{field} must be a string")
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in value).split())
    return text[:max_length]

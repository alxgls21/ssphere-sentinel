"""Poll one device and build the ``snmp`` heartbeat payload for it.

A ``DevicePoller`` owns what must persist between the polls of one device:
the interfaces found by the last *discovery*, the previous counter readings
(for deltas) and the uptime (for reboot detection). It is used by one worker
at a time (the scheduler never runs two polls of a device at once).

Two kinds of poll:

* a **discovery poll** also reads the system group and the names, types and
  aliases of every interface. It runs first, then every
  ``discovery_interval_seconds``, and sooner when the device restarted, its
  interface table changed (``ifTableLastChange``) or a poll saw interfaces
  that discovery had not. It lists all interfaces, so the server can mark
  vanished ones absent (``interfaces_complete``);
* a **regular poll** reads status and counters only and lists the monitored
  interfaces. The descriptive fields come from the last discovery: the server
  overwrites an interface's name with whatever the poll says.

An unreachable device yields a poll with ``reachable: false`` and an error
category, never an exception. Counter state survives unreachable polls; the
``gap`` state covers long outages.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from typing import Any

from agent.snmp_config import InterfaceSelection, SnmpCredential, SnmpDeviceConfig
from agent.snmp_deltas import (
    COLLECTION_RATE_TOLERANCE,
    COLLECTION_SLACK_TICKS,
    SYS_UPTIME_MODULUS,
    CounterSnapshot,
    bounded_raw,
    compute_delta,
    marker_value,
    uptime_went_backwards,
    uptime_wrapped,
    usable_marker,
)
from agent.snmp_fetch import (
    FetchPlan,
    Fetcher,
    RawDeviceData,
    SnmpFetchCancelled,
    SnmpFetchError,
)
from agent.snmp_payload import COUNTER_NAMES, MAX_INTERFACES_PER_POLL

logger = logging.getLogger("sentinel_agent")

# ifType values left out unless an include pattern names the interface:
# softwareLoopback, propVirtual, tunnel, l2vlan, l3ipvlan, mplsTunnel.
DEFAULT_EXCLUDED_TYPES = frozenset({24, 53, 131, 135, 136, 150})
# A previous reading older than this many poll intervals is "gap", not a delta.
GAP_FACTOR = 3.5
# An interface whose discontinuity marker changed at this many consecutive polls is worth a
# warning (every change is still a discontinuity), at most once per interval per device.
FREQUENT_MARKER_CHANGES = 3
FREQUENT_MARKER_WARNING_SECONDS = 3600.0
SATURATED_IF_SPEED = 2**32 - 1  # ifSpeed saturates here; ifHighSpeed has the real value
MAX_SPEED_BPS = 10**15
MAX_UPTIME_TICKS = 2**32 - 1
MAX_IF_INDEX = 2**31 - 1
# Descriptive text is shortened here, not rejected later: the server accepts
# up to 255 characters, but a poll of 512 interfaces must always fit the size
# limit of one queued poll (IF-MIB itself limits ifAlias to 64 characters).
MAX_NAME = 128
MAX_ALIAS = 64
MAX_SYS_NAME = 255
MAX_SYS_DESCR = 1024
_OID_RE = re.compile(r"^[0-9]+(\.[0-9]+){1,127}$")  # what the server accepts for sysObjectID

_COUNTER_COLUMNS = {
    "in_errors": "in_errors",
    "out_errors": "out_errors",
    "in_discards": "in_discards",
    "out_discards": "out_discards",
}


class DevicePoller:
    def __init__(
        self,
        device: SnmpDeviceConfig,
        credential: SnmpCredential,
        fetcher: Fetcher,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        utcnow: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        new_id: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> None:
        self.device = device
        self._credential = credential
        self._fetcher = fetcher
        self._monotonic = monotonic
        self._utcnow = utcnow
        self._new_id = new_id

        self._interfaces: dict[int, _Interface] | None = None
        self._discovered_at = 0.0
        self._rediscover = False
        self._table_marker: int | None = None
        self._previous: dict[int, CounterSnapshot] = {}
        self._uptime: tuple[int, float] | None = None
        self._uptime_wrapped = False  # sysUpTime has wrapped since the device started
        self._marker_streak: dict[int, int] = {}
        self._marker_warned: set[int] = set()  # interfaces whose impossible marker was reported
        # Interfaces whose continuity was in doubt (the interface table changed) in a poll that skipped
        # them: the doubt stays until a poll reads them.
        self._unproven: set[int] = set()
        self._marker_warned_at: float | None = None
        self._last_error: str | None = None
        self._warned: set[str] = set()

    def poll(self, cancel: threading.Event | None = None) -> dict[str, Any]:
        """Poll the device once and return the poll payload (never raises for device errors)."""
        started = self._monotonic()
        measured_at = self._utcnow()
        discover = self._needs_discovery(started)
        try:
            raw = self._fetcher.fetch(self.device, self._credential, FetchPlan(discover), cancel)
        except SnmpFetchCancelled:
            raise
        except SnmpFetchError as exc:
            self._note_failure(exc)
            return {
                "poll_id": str(self._new_id()),
                "device_id": str(self.device.id),
                "measured_at": measured_at.isoformat(),
                "reachable": False,
                "error": exc.category,
            }
        self._note_success()
        return self._reachable(raw, measured_at, started, discover)

    # -- reachable polls ----------------------------------------------------------

    def _needs_discovery(self, now: float) -> bool:
        return (
            self._interfaces is None
            or self._rediscover
            or now - self._discovered_at >= self.device.discovery_interval_seconds
        )

    def _reachable(
        self, raw: RawDeviceData, measured_at: datetime, started: float, discover: bool
    ) -> dict[str, Any]:
        uptime = raw.sys_uptime_ticks if 0 <= raw.sys_uptime_ticks <= MAX_UPTIME_TICKS else None
        rebooted = self._detect_reboot(uptime, started)
        # The walks took time and are not one snapshot. sysUpTime read again after them brackets that
        # time: a restart or a wrap while they ran shows as a decrease, and a marker up to that reading
        # can be a moment of the collection. Without it nothing can be vouched for.
        end = raw.sys_uptime_end_ticks
        end = end if end is not None and 0 <= end <= MAX_UPTIME_TICKS else None
        during = self._detect_reboot_during(uptime, end, started) if end is not None else None
        restarted_during = during == "restart"
        rebooted = rebooted or restarted_during
        suspect = during is not None  # the device may have restarted while it was polled
        consistent = (uptime is None or end is not None) and during != "ambiguous"
        horizon = end if end is not None else uptime  # the latest uptime the readings can be from
        table_changed = self._watch_table(raw)
        columns = raw.columns
        present = {index for index in columns.get("oper", {}) if 1 <= index <= MAX_IF_INDEX}

        # A discovery that a restart interrupted read some of its metadata before it and some after: it is
        # not one inventory. It is not adopted, does not list the interfaces as complete (the server would
        # then mark the ones it did not see absent), and the next poll discovers again. What the agent knew
        # before (trusted names) is still what it publishes; if it knew nothing, the poll lists no interface:
        # a reading cannot be sent without saying which interface it is, and the server takes the name from it.
        listing = discover and not suspect
        if listing:
            found = self._discover(columns)
            self._forget_replaced(found)
            self._interfaces = found
            self._discovered_at = started
            self._rediscover = False
        if suspect or (not listing and (rebooted or present != set(self._interfaces or {}))):
            self._rediscover = True  # next poll re-reads names, types and the interface set

        interfaces = self._interfaces or {}
        entries: list[dict[str, Any]] = []
        readings = dict(self._previous)
        skipped: set[int] = set()
        for index in sorted(present & set(interfaces)):
            info = interfaces[index]
            if not info.monitored and not listing:
                continue
            entry = self._entry(info, columns, started, rebooted, horizon, table_changed, consistent)
            if entry is not None:
                entries.append(entry)
            elif info.monitored:
                skipped.add(index)  # not read this poll: whatever was in doubt about it still is
        if suspect:
            # Counters read while the device may have restarted may be from before or after: no baseline at
            # all, and nothing that counted markers across the transition.
            self._previous.clear()
            self._unproven.clear()
            self._marker_streak.clear()
        elif rebooted:
            # Every interface starts afresh, those too that could not be read in the poll that saw the restart.
            self._previous = {i: snap for i, snap in self._previous.items() if readings.get(i) is not snap}
            self._unproven.clear()
            self._marker_streak.clear()
        elif table_changed:
            self._unproven |= skipped

        complete = False
        if listing:
            if 0 < len(entries) <= MAX_INTERFACES_PER_POLL and len(entries) == len(present):
                complete = True
            elif len(entries) > MAX_INTERFACES_PER_POLL:
                entries = [e for e in entries if "counters" in e][:MAX_INTERFACES_PER_POLL]
                self._warn_once(
                    "too-many",
                    "device lists more than %d interfaces; its interface inventory is not complete"
                    % MAX_INTERFACES_PER_POLL,
                )

        # Keep readings only for interfaces still monitored and still listed by the device: one that
        # vanished and comes back is not known to be the same interface, so it starts afresh.
        monitored = {i for i, info in interfaces.items() if info.monitored and i in present}
        self._previous = {i: snap for i, snap in self._previous.items() if i in monitored}
        self._marker_streak = {i: n for i, n in self._marker_streak.items() if i in monitored}
        self._marker_warned &= monitored
        self._unproven &= monitored
        self._warn_frequent_markers(started, interfaces)

        poll: dict[str, Any] = {
            "poll_id": str(self._new_id()),
            "device_id": str(self.device.id),
            "measured_at": measured_at.isoformat(),
            "reachable": True,
            "response_ms": raw.response_ms,
            "interfaces": entries,
        }
        if uptime is not None:  # a buggy device may report a negative or oversized value
            poll["sys_uptime_ticks"] = uptime
        if listing:
            poll["system"] = _system(raw.system)
            poll["interfaces_complete"] = complete
        if not present:
            self._warn_once(
                "no-ifmib",
                "device answers but reports no interfaces (no IF-MIB?); only reachability is recorded",
            )
        return poll

    def _detect_reboot(self, ticks: int | None, now: float) -> bool:
        if ticks is None:
            return False  # unusable reading: neither a restart nor a new reference
        rebooted = False
        if self._uptime is not None:
            previous_ticks, previous_at = self._uptime
            rebooted = uptime_went_backwards(previous_ticks, ticks, now - previous_at)
            if rebooted:
                logger.info("SNMP device %s restarted (uptime went backwards)", self.device.name)
                self._uptime_wrapped = False  # a new sysUpTime epoch
            elif uptime_wrapped(previous_ticks, ticks, now - previous_at):
                self._uptime_wrapped = True
        self._uptime = (ticks, now)
        return rebooted

    def _detect_reboot_during(self, before: int | None, end: int, started: float) -> str | None:
        """Did ``sysUpTime`` go back while the walks ran (read again at ``end``)? ``"restart"``,
        ``"ambiguous"`` or ``None``.

        If it did, either the device restarted or the 32-bit tick counter wrapped. Through the wrap,
        the device-time from the first reading to ``end`` cannot be longer than the collection took on
        the monotonic clock (plus a small allowance): a longer span is a restart, for sure. A span
        that fits is what a wrap looks like, but a restart shortly before the wrap point has the same
        numbers, and nothing observed tells them apart: ``"ambiguous"``, and then no delta is vouched for.
        """
        now = self._monotonic()
        kind = None
        if before is None:
            if self._detect_reboot(end, now):  # nothing to bracket: judged against the last poll
                kind = "restart"
        else:
            if end < before:
                # Whatever it was, it may have been a restart: nothing learned about the epoch so far,
                # a wrap seen earlier included, can be assumed to hold for the readings of this poll.
                self._uptime_wrapped = False
                span = end - before + SYS_UPTIME_MODULUS
                took_ticks = max(0.0, now - started) * 100
                if span > took_ticks * (1 + COLLECTION_RATE_TOLERANCE) + COLLECTION_SLACK_TICKS:
                    kind = "restart"
                    logger.info("SNMP device %s restarted while it was being polled", self.device.name)
                else:
                    kind = "ambiguous"
            self._uptime = (end, now)
        return kind

    def _watch_table(self, raw: RawDeviceData) -> bool:
        """Note ``ifTableLastChange``; True if the interface table changed since the previous poll."""
        marker = raw.if_table_last_change
        changed = marker is not None and self._table_marker is not None and marker != self._table_marker
        if changed:
            self._rediscover = True
        if marker is not None:
            self._table_marker = marker
        return changed

    def _forget_replaced(self, found: Mapping[int, _Interface]) -> None:
        """Drop the previous reading of an ifIndex that now names another interface.

        The identity is the interface type and ``ifName`` (``ifDescr`` if the device has no
        ifName): read-only in IF-MIB, so an administrator cannot change them. ``ifAlias``, the
        one writable label, is not part of it: describing an interface does not restart its counters.
        """
        for index, info in found.items():
            before = (self._interfaces or {}).get(index)
            if before is not None and (before.name, before.if_type) != (info.name, info.if_type):
                self._previous.pop(index, None)
                self._marker_streak.pop(index, None)
                self._marker_warned.discard(index)
                self._unproven.discard(index)

    def _discover(self, columns: Mapping[str, Mapping[int, Any]]) -> dict[int, _Interface]:
        found: dict[int, _Interface] = {}
        for index in sorted(i for i in columns.get("oper", {}) if 1 <= i <= MAX_IF_INDEX):
            descr = _text(columns.get("descr", {}).get(index), MAX_NAME)
            name = _text(columns.get("name", {}).get(index), MAX_NAME) or descr
            if_type = columns.get("type", {}).get(index)
            found[index] = _Interface(
                if_index=index,
                name=name,
                descr=descr,
                alias=_text(columns.get("alias", {}).get(index), MAX_ALIAS),
                if_type=if_type if isinstance(if_type, int) and 0 <= if_type <= 65535 else 0,
            )
        selected = select_interfaces(found.values(), self.device.interfaces)
        limit = self.device.interfaces.max_interfaces
        if len(selected) > limit:
            self._warn_once(
                "max-interfaces",
                "%d interfaces selected; monitoring the first %d (raise interfaces.max_interfaces "
                "or narrow include/exclude)" % (len(selected), limit),
            )
            selected = selected[:limit]
        for index in selected:
            found[index].monitored = True
        return found

    def _entry(
        self,
        info: _Interface,
        columns: Mapping[str, Mapping[int, Any]],
        started: float,
        rebooted: bool,
        uptime: int | None,
        table_changed: bool,
        consistent: bool,
    ) -> dict[str, Any] | None:
        index = info.if_index
        admin = columns.get("admin", {}).get(index)
        oper = columns.get("oper", {}).get(index)
        # An out-of-range status would make the server reject the whole poll.
        if not (isinstance(admin, int) and 1 <= admin <= 3 and isinstance(oper, int) and 1 <= oper <= 7):
            return None
        speed = _speed(columns, index)
        entry: dict[str, Any] = {
            "if_index": index,
            "name": info.name,
            "descr": info.descr,
            "alias": info.alias,
            "if_type": info.if_type,
            "speed_bps": speed,
            "admin_status": admin,
            "oper_status": oper,
        }
        if info.monitored:
            entry["counters"] = self._counters(index, columns, speed, started, rebooted, uptime, table_changed, consistent)
        return entry

    def _counters(
        self,
        index: int,
        columns: Mapping[str, Mapping[int, Any]],
        speed: int | None,
        started: float,
        rebooted: bool,
        uptime: int | None,
        table_changed: bool,
        consistent: bool,
    ) -> dict[str, Any]:
        in64 = columns.get("in_octets64", {}).get(index)
        out64 = columns.get("out_octets64", {}).get(index)
        if in64 is not None and out64 is not None:
            bits = 64
            octets = {"in_octets": in64, "out_octets": out64}
        else:
            bits = 32
            octets = {
                "in_octets": columns.get("in_octets32", {}).get(index),
                "out_octets": columns.get("out_octets32", {}).get(index),
            }
        raw: dict[str, int | None] = {}
        for name in COUNTER_NAMES:
            value = octets[name] if name in octets else columns.get(_COUNTER_COLUMNS[name], {}).get(index)
            raw[name] = bounded_raw(name, value if isinstance(value, int) else None, bits)

        reported = columns.get("discontinuity", {}).get(index)
        marker = usable_marker(reported, uptime, wrapped=self._uptime_wrapped)
        if reported is not None and marker is None and index not in self._marker_warned:
            self._marker_warned.add(index)
            logger.warning(
                "SNMP device %s: interface %d reports ifCounterDiscontinuityTime %r, which is not a moment "
                "its sysUpTime (%s) has reached, so it is not believed (garbage, or older than a sysUpTime "
                "wrap that the agent did not see); a different value later still counts as a discontinuity",
                self.device.name,
                index,
                reported,
                uptime,
            )
        snapshot = CounterSnapshot(
            taken_at=started,
            octets_bits=bits,
            speed_bps=speed,
            raw=raw,
            discontinuity=marker,
            marker_seen=marker_value(reported),
        )
        previous = self._previous.get(index)
        result = compute_delta(
            previous,
            snapshot,
            rebooted=rebooted,
            max_gap_seconds=GAP_FACTOR * self.device.poll_interval_seconds,
            table_changed=table_changed or index in self._unproven,
            consistent=consistent,
        )
        self._unproven.discard(index)
        self._previous[index] = snapshot
        moved = (
            not rebooted
            and previous is not None
            and previous.discontinuity is not None
            and marker is not None
            and previous.discontinuity != marker
        )
        self._marker_streak[index] = self._marker_streak.get(index, 0) + 1 if moved else 0

        counters: dict[str, Any] = {
            "octets_bits": bits,
            "delta_state": result.state,
            "raw": raw,
        }
        if result.interval_seconds is not None:
            counters["interval_seconds"] = result.interval_seconds
        if result.delta is not None:
            counters["delta"] = dict(result.delta)
        return counters

    def _warn_frequent_markers(self, now: float, interfaces: Mapping[int, _Interface]) -> None:
        """Say so (rarely) when interfaces report a discontinuity at poll after poll.

        Every change stays a discontinuity: a device may really be clearing its counters that often.
        But a marker that moves at every poll leaves no traffic rate at all, which is worth knowing.
        """
        frequent = sorted(i for i, n in self._marker_streak.items() if n >= FREQUENT_MARKER_CHANGES)
        if not frequent:
            return
        if self._marker_warned_at is not None and now - self._marker_warned_at < FREQUENT_MARKER_WARNING_SECONDS:
            return
        self._marker_warned_at = now
        names = ", ".join(interfaces[i].name or str(i) for i in frequent[:5])
        logger.warning(
            "SNMP device %s: ifCounterDiscontinuityTime of %d interface(s) (%s%s) changed at %d polls in a "
            "row; each change is treated as a counter discontinuity, so their traffic deltas are not reported",
            self.device.name,
            len(frequent),
            names,
            ", ..." if len(frequent) > 5 else "",
            FREQUENT_MARKER_CHANGES,
        )

    # -- state changes ------------------------------------------------------------

    def _note_failure(self, exc: SnmpFetchError) -> None:
        if self._last_error != exc.category:
            logger.warning(
                "SNMP device %s (%s) is unreachable: %s (%s)",
                self.device.name,
                self.device.id,
                exc.category,
                str(exc)[:200],
            )
        else:
            logger.debug("SNMP device %s still unreachable: %s", self.device.name, exc.category)
        self._last_error = exc.category

    def _note_success(self) -> None:
        if self._last_error is not None:
            logger.info("SNMP device %s is reachable again", self.device.name)
            self._last_error = None

    def _warn_once(self, key: str, message: str) -> None:
        if key not in self._warned:
            self._warned.add(key)
            logger.warning("SNMP device %s: %s", self.device.name, message)


class _Interface:
    """What discovery learned about one interface."""

    __slots__ = ("if_index", "name", "descr", "alias", "if_type", "monitored")

    def __init__(self, if_index: int, name: str, descr: str, alias: str, if_type: int) -> None:
        self.if_index = if_index
        self.name = name
        self.descr = descr
        self.alias = alias
        self.if_type = if_type
        self.monitored = False


def select_interfaces(interfaces: Any, selection: InterfaceSelection) -> list[int]:
    """ifIndexes to monitor, in index order.

    ``exclude`` patterns always win. With ``include`` patterns only matching
    interfaces are monitored (even a loopback or VLAN interface they name);
    without them, everything except loopback, VLAN, tunnel and other virtual
    interface types. Patterns are shell-style and match the interface name or
    description, case-sensitively.
    """
    selected = []
    for info in interfaces:
        names = [text for text in (info.name, info.descr) if text]
        if any(fnmatchcase(text, pattern) for pattern in selection.exclude for text in names):
            continue
        if selection.include:
            if not any(fnmatchcase(text, pattern) for pattern in selection.include for text in names):
                continue
        elif info.if_type in DEFAULT_EXCLUDED_TYPES:
            continue
        selected.append(info.if_index)
    return sorted(selected)


def _speed(columns: Mapping[str, Mapping[int, Any]], index: int) -> int | None:
    high = columns.get("high_speed", {}).get(index)
    if isinstance(high, int) and high > 0:
        speed = high * 1_000_000
    else:
        plain = columns.get("speed", {}).get(index)
        # Saturated or zero ifSpeed without ifHighSpeed means "unknown".
        if not isinstance(plain, int) or plain <= 0 or plain >= SATURATED_IF_SPEED:
            return None
        speed = plain
    return speed if speed <= MAX_SPEED_BPS else None


def _system(system: Mapping[str, str]) -> dict[str, str]:
    limits = {"name": MAX_SYS_NAME, "descr": MAX_SYS_DESCR}
    cleaned = {key: _text(value, limit) for key, limit in limits.items() if (value := system.get(key))}
    object_id = system.get("object_id")
    # A value that is not a dotted OID would make the server reject the whole
    # discovery poll (and with it the inventory): leave it out.
    if isinstance(object_id, str) and len(object_id) <= 255 and _OID_RE.fullmatch(object_id):
        cleaned["object_id"] = object_id
    return cleaned


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    # Lone surrogates cannot be encoded as UTF-8 (the queue stores UTF-8).
    return value[:limit].encode("utf-8", "replace").decode("utf-8")

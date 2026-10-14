"""Counter deltas for SNMP interfaces.

The agent reads raw counters and calculates the increase since its previous
poll; the server stores both (docs/snmp.md). This module is that calculation,
free of any I/O so every edge case can be tested directly.

Each calculation ends in a ``delta_state``:

``ok``             deltas valid
``speed_changed``  deltas valid, but the interface speed changed in between
``first``          no previous counters (first poll, or nothing countable)
``reboot``         the device restarted (``sysUpTime`` went backwards)
``reset``          the counters are not comparable: one went backwards and that
                   is not a plausible wrap, or the device says (or cannot rule
                   out) that they suffered a discontinuity in between
``gap``            the previous sample is too old for a meaningful delta

Only ``ok`` and ``speed_changed`` carry delta values. A single implausible
counter marks the whole interface ``reset``: a partial delta would mislead
more than none.

Discontinuities. ``ifCounterDiscontinuityTime`` is the ``sysUpTime`` (not a wall
clock) at which any counter of the interface last had a discontinuity, 0 if none
since the device started. If it differs between two reads of the same interface,
something discontinuous happened in between, whatever the two counter values
look like: a cleared counter that has grown past its old value, or a 32-bit one
restarted near zero after a high reading, passes for ordinary traffic when only
the values are compared. So a changed marker is a ``reset``. Markers of
different ``sysUpTime`` epochs are never compared: a restart (``reboot``) is
decided first. Without a usable marker on both reads (a device that lacks it, or
a value that cannot be one: see ``usable_marker``) the rules below apply as
before, and so does one more: when the interface table changed
(``ifTableLastChange``), an interface without that proof cannot be shown to be
the same one (rows were created or deleted, and the table does not say which),
so its delta is a ``reset`` as well; the doubt stays with an interface that a poll
had to skip, until a poll reads it.

The walks of a poll are not one snapshot, so ``sysUpTime`` is read before and
after them. A marker may be as high as the later reading (a counter reset while
the walks ran). A smaller later reading is a restart if the span through the wrap
is longer than the collection took on the monotonic clock, and otherwise it cannot
be told from a wrap shortly after a restart, so no delta is vouched for. Without
the later reading (that GET failed) none is either. At startup the agent
does not know whether ``sysUpTime`` wrapped before it first looked: a marker above
the uptime is then not believed, but a different plausible marker at the next poll
is still a change.

How a decrease is read:

* a 64-bit counter does not wrap in practice: a decrease is a ``reset``;
* a 32-bit **octet** counter that decreases has wrapped if the traffic that
  implies fits the link (the increase over the interval, as a rate, is at most
  1.5 times the interface speed). That is what busy links with 32-bit counters
  do all the time, so it must not be called a reset. If the speed is unknown
  the stricter rule below applies;
* any other 32-bit counter (errors, discards, or octets of unknown speed) is
  taken as wrapped only if the implied increase is below half the range:
  such counters practically never wrap, and a large "wrap" is almost surely a
  counter that was cleared. A device restart is caught separately (``reboot``).

Known limits: a 32-bit counter that wraps *more than once* between two polls
looks like one wrap or none, and the delta is then too low; and a counter that
is cleared by hand on a busy 32-bit link can look like a plausible wrap. Only
the 64-bit ``ifHC*`` counters are reliable on fast links; the collector
prefers them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from agent.snmp_payload import (
    COUNTER_NAMES,
    DELTA_FIRST,
    DELTA_GAP,
    DELTA_OK,
    DELTA_REBOOT,
    DELTA_RESET,
    DELTA_SPEED_CHANGED,
    OCTET_COUNTERS,
)

COUNTER32_MODULUS = 2**32
MAX_RAW_COUNTER32 = COUNTER32_MODULUS - 1
# The server stores raw 64-bit octet counters in a signed bigint.
MAX_RAW_COUNTER64 = 2**63 - 1
SYS_UPTIME_MODULUS = 2**32  # TimeTicks (hundredths of a second) wrap after ~497 days
# For counters whose rate cannot be checked against a link speed, a decrease
# is a wrap only if the implied increase is below half the range.
MAX_PLAUSIBLE_WRAP = COUNTER32_MODULUS // 2
# Octet increases across a wrap may exceed the link rate by this factor
# (rate is measured over a slightly uncertain interval) before they count as
# a reset.
SPEED_TOLERANCE = 1.5
# The server refuses an interval above this (a week).
MAX_INTERVAL_SECONDS = 7 * 24 * 3600
# sysUpTime read after a wrap should land within this of the expected value.
UPTIME_WRAP_TOLERANCE_TICKS = 6000
# The device-time between two readings of sysUpTime in one poll cannot be longer than the poll took on
# the agent's monotonic clock; this much is allowed on top, for the rates of the two clocks and for the
# moment each reading was taken within the collection (100 ticks are a second).
COLLECTION_RATE_TOLERANCE = 0.01
COLLECTION_SLACK_TICKS = 100


@dataclass(frozen=True)
class CounterSnapshot:
    """The counters of one interface at one poll."""

    taken_at: float  # monotonic seconds; only differences are used
    octets_bits: int  # 64 when the ifHC* octet counters were read, else 32
    speed_bps: int | None
    raw: Mapping[str, int | None] = field(default_factory=dict)
    # ifCounterDiscontinuityTime as read and believed, or None if absent or unusable (``usable_marker``).
    discontinuity: int | None = None
    # The value as the device gave it, if it is a TimeTicks value at all, even one that was not believed
    # (above the uptime: garbage, or from before a wrap of sysUpTime that the agent never saw).
    marker_seen: int | None = None


@dataclass(frozen=True)
class DeltaResult:
    state: str
    interval_seconds: float | None = None
    delta: Mapping[str, int | None] | None = None


def counter_bits(name: str, octets_bits: int) -> int:
    """Width of a counter: octets follow ``octets_bits``; errors and discards are 32-bit."""
    return octets_bits if name in OCTET_COUNTERS else 32


def raw_limit(name: str, octets_bits: int) -> int:
    """Largest raw value the server accepts for this counter."""
    if name in OCTET_COUNTERS and octets_bits == 64:
        return MAX_RAW_COUNTER64
    return MAX_RAW_COUNTER32


def bounded_raw(name: str, value: int | None, octets_bits: int) -> int | None:
    """``value`` if the server accepts it, else ``None`` (never send an out-of-range value)."""
    if value is None or value < 0 or value > raw_limit(name, octets_bits):
        return None
    return value


def marker_value(value: object) -> int | None:
    """``value`` if it is a ``TimeTicks`` value (an integer in 0..2**32-1), else ``None``."""
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < SYS_UPTIME_MODULUS:
        return None
    return value


def usable_marker(value: object, uptime_ticks: int | None, *, wrapped: bool) -> int | None:
    """``ifCounterDiscontinuityTime`` if it can be believed, else ``None``.

    It names a moment of the device's own ``sysUpTime``, so it cannot be above the uptime
    at the end of the poll that read it. The exception is a ``sysUpTime`` that has wrapped
    (every ~497 days) since the device started: a marker from before the wrap is then
    legitimately above it. The agent knows of a wrap only if it saw one; at startup a marker
    above the uptime is ambiguous (garbage, or older than a wrap it never saw) and is not
    believed, see ``compute_delta`` for what is still concluded from it.
    """
    marker = marker_value(value)
    if marker is None:
        return None
    if uptime_ticks is not None and marker > uptime_ticks and not wrapped:
        return None
    return marker


def uptime_wrapped(previous_ticks: int | None, current_ticks: int | None, elapsed_seconds: float) -> bool:
    """True if ``sysUpTime`` decreased only because the 32-bit tick counter wrapped (not a restart)."""
    if previous_ticks is None or current_ticks is None or current_ticks >= previous_ticks:
        return False
    return not uptime_went_backwards(previous_ticks, current_ticks, elapsed_seconds)


def uptime_went_backwards(
    previous_ticks: int | None, current_ticks: int | None, elapsed_seconds: float
) -> bool:
    """True if ``sysUpTime`` shows a restart between two polls.

    A decrease is not a restart when the 32-bit tick counter simply wrapped
    in between (every ~497 days): then the new value is where the old one
    would have been after ``elapsed_seconds``.
    """
    if previous_ticks is None or current_ticks is None or current_ticks >= previous_ticks:
        return False
    expected = previous_ticks + int(max(0.0, elapsed_seconds) * 100)
    if expected >= SYS_UPTIME_MODULUS:
        wrapped = expected - SYS_UPTIME_MODULUS
        if abs(current_ticks - wrapped) <= UPTIME_WRAP_TOLERANCE_TICKS:
            return False
    return True


def compute_delta(
    previous: CounterSnapshot | None,
    current: CounterSnapshot,
    *,
    rebooted: bool,
    max_gap_seconds: float,
    table_changed: bool = False,
    consistent: bool = True,
) -> DeltaResult:
    """Deltas of ``current`` against ``previous`` and the state that qualifies them.

    ``table_changed``: continuity of the interface with the previous poll is in doubt
    because the interface table gained or lost a row, and nothing else has shown that this
    interface is unaffected. ``consistent``: the readings of ``current`` can be treated as
    one observation (``sysUpTime`` read before and after the walks agree); if not, no
    delta is vouched for.
    """
    if previous is None:
        return DeltaResult(DELTA_FIRST)

    interval = current.taken_at - previous.taken_at
    # The interval is optional for states without deltas, and the server
    # rejects the whole poll if it is out of range: leave it out then.
    known_interval = round(interval, 3) if 0 < interval <= MAX_INTERVAL_SECONDS else None
    if rebooted:
        return DeltaResult(DELTA_REBOOT, known_interval)
    if known_interval is None or interval > max_gap_seconds:
        return DeltaResult(DELTA_GAP, known_interval)
    if previous.octets_bits != current.octets_bits:
        # HC counters appeared or disappeared: the two reads are not comparable.
        return DeltaResult(DELTA_RESET, known_interval)

    if not consistent:
        return DeltaResult(DELTA_RESET, known_interval)
    if previous.discontinuity is not None and current.discontinuity is not None:
        if previous.discontinuity != current.discontinuity:
            return DeltaResult(DELTA_RESET, known_interval)
    elif (
        current.discontinuity is not None
        and previous.marker_seen is not None
        and previous.marker_seen != current.discontinuity
    ):
        # The previous marker was not believed (above its uptime), the current one is, and they
        # differ: the marker moved, whatever the first one was.
        return DeltaResult(DELTA_RESET, known_interval)
    elif table_changed:
        return DeltaResult(DELTA_RESET, known_interval)  # continuity cannot be shown

    delta: dict[str, int | None] = {}
    for name in COUNTER_NAMES:
        before = previous.raw.get(name)
        after = current.raw.get(name)
        if before is None or after is None:
            delta[name] = None
            continue
        increase = _increase(
            name,
            before,
            after,
            bits=counter_bits(name, current.octets_bits),
            interval=interval,
            speed_bps=current.speed_bps,
        )
        if increase is None:
            return DeltaResult(DELTA_RESET, known_interval)
        delta[name] = increase

    if all(value is None for value in delta.values()):
        return DeltaResult(DELTA_FIRST)  # nothing was countable on both polls

    speed_changed = (
        previous.speed_bps is not None
        and current.speed_bps is not None
        and previous.speed_bps != current.speed_bps
    )
    return DeltaResult(
        DELTA_SPEED_CHANGED if speed_changed else DELTA_OK,
        known_interval,
        delta,
    )


def _increase(
    name: str,
    before: int,
    after: int,
    *,
    bits: int,
    interval: float,
    speed_bps: int | None,
) -> int | None:
    """Increase from ``before`` to ``after``, or ``None`` for a reset."""
    if after >= before:
        return after - before
    if bits >= 64:
        return None  # a 64-bit counter does not wrap in practice
    wrapped = after + COUNTER32_MODULUS - before
    if name in OCTET_COUNTERS and speed_bps:
        if wrapped * 8 / interval > speed_bps * SPEED_TOLERANCE:
            return None  # faster than the link can carry: not a wrap
        return wrapped
    return wrapped if wrapped < MAX_PLAUSIBLE_WRAP else None

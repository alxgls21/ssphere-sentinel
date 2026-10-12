"""Counter deltas for SNMP interfaces.

The agent reads raw counters and calculates the increase since its previous
poll; the server stores both (docs/snmp.md). This module is that calculation,
free of any I/O so every edge case can be tested directly.

Each calculation ends in a ``delta_state``:

``ok``             deltas valid
``speed_changed``  deltas valid, but the interface speed changed in between
``first``          no previous counters (first poll, or nothing countable)
``reboot``         the device restarted (``sysUpTime`` went backwards)
``reset``          a counter went backwards and that is not a plausible wrap
``gap``            the previous sample is too old for a meaningful delta

Only ``ok`` and ``speed_changed`` carry delta values. A single implausible
counter marks the whole interface ``reset``: a partial delta would mislead
more than none.

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


@dataclass(frozen=True)
class CounterSnapshot:
    """The counters of one interface at one poll."""

    taken_at: float  # monotonic seconds; only differences are used
    octets_bits: int  # 64 when the ifHC* octet counters were read, else 32
    speed_bps: int | None
    raw: Mapping[str, int | None] = field(default_factory=dict)


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
) -> DeltaResult:
    """Deltas of ``current`` against ``previous`` and the state that qualifies them."""
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

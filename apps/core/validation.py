"""Primitive validators shared by the agent payload parsers.

Each subsystem (telemetry, Docker, network) raises its own exception type so
callers can reject one section without affecting the others; the helpers take
that type as ``error``.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any

from django.utils import timezone
from django.utils.dateparse import parse_datetime

# Reject timestamps absurdly far in the future (clock skew allowance).
MAX_FUTURE_SKEW = timedelta(minutes=5)
# PostgreSQL bigint range (BigIntegerField).
BIGINT_MAX = 2**63 - 1


def parse_timestamp(value: Any, *, field: str, error: type[Exception]) -> datetime:
    """Parse an ISO-8601 timestamp; naive values are UTC. Returns UTC.

    Values that cannot be represented in UTC (before year 1) are rejected:
    PostgreSQL would store them but they could not be loaded back.
    """
    if not isinstance(value, str) or not value.strip():
        raise error(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = parse_datetime(value.strip())
    except ValueError:
        parsed = None
    if parsed is None:
        raise error(f"{field} must be an ISO-8601 timestamp")
    if timezone.is_naive(parsed):
        parsed = parsed.replace(tzinfo=dt_timezone.utc)
    try:
        parsed = parsed.astimezone(dt_timezone.utc)
    except OverflowError as exc:
        raise error(f"{field} is out of range") from exc
    if parsed > timezone.now() + MAX_FUTURE_SKEW:
        raise error(f"{field} is too far in the future")
    return parsed


def require_number(
    value: Any,
    *,
    field: str,
    error: type[Exception],
    minimum: float,
    maximum: float,
) -> float:
    """A finite JSON number (not a bool) within ``[minimum, maximum]``.

    ``json.loads`` accepts ``NaN``/``Infinity``; NaN passes every comparison,
    so finiteness is checked explicitly.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error(f"{field} must be a number")
    try:
        number = float(value)
    except OverflowError:  # an int too large for a float
        number = math.inf
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise error(f"{field} must be between {minimum} and {maximum}")
    return number


def require_integer(
    value: Any,
    *,
    field: str,
    error: type[Exception],
    minimum: int,
    maximum: int = BIGINT_MAX,
    allow_integral_float: bool = False,
) -> int:
    """A JSON integer (not a bool) within ``[minimum, maximum]``.

    With ``allow_integral_float``, values such as ``5.0`` are accepted too.
    """
    if isinstance(value, bool):
        raise error(f"{field} must be an integer")
    if isinstance(value, float):
        if not allow_integral_float or not value.is_integer():
            raise error(f"{field} must be an integer")
        value = int(value)
    if not isinstance(value, int):
        raise error(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise error(f"{field} must be between {minimum} and {maximum}")
    return value

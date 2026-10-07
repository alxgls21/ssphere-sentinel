"""Derive server liveness from last_seen_at (no background worker required)."""

from __future__ import annotations

from datetime import datetime, timedelta

from django.conf import settings
from django.utils import timezone

from apps.infrastructure.models import Server


def offline_threshold_seconds() -> int:
    return int(settings.SENTINEL_OFFLINE_THRESHOLD)


def evaluate_effective_status(
    server: Server,
    *,
    now: datetime | None = None,
    threshold_seconds: int | None = None,
) -> str:
    """Return current liveness for a server.

    Rules:
    - never reported (``last_seen_at`` is null) → ``unknown``
    - last seen within the offline threshold → ``online``
    - last seen older than the threshold → ``offline``

    Stored ``Server.status`` remains writable for heartbeat updates and future
    warning/error features; ``effective_status`` is the read-time liveness view
    derived from ``last_seen_at``.
    """
    if server.last_seen_at is None:
        return Server.Status.UNKNOWN

    current = now if now is not None else timezone.now()
    threshold = (
        threshold_seconds
        if threshold_seconds is not None
        else offline_threshold_seconds()
    )
    cutoff = current - timedelta(seconds=threshold)
    if server.last_seen_at >= cutoff:
        return Server.Status.ONLINE
    return Server.Status.OFFLINE

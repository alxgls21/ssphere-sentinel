"""Health thresholds the console applies, from settings (``SENTINEL_THRESHOLD_*``).

These are the limits health is judged by, not alert rules; the alert engine
observes that same health (``apps.alerts.observations``), so a changed limit
also changes when a rule fires. They live in one place on the server, and
``/session/`` publishes them so the UI can label what a status means without
keeping its own copy.
"""

from __future__ import annotations

from django.conf import settings


def thresholds() -> dict[str, int]:
    return {
        "resourceWarnPercent": settings.SENTINEL_THRESHOLD_RESOURCE_WARN_PERCENT,
        "resourceCritPercent": settings.SENTINEL_THRESHOLD_RESOURCE_CRIT_PERCENT,
        "probeLossWarnPercent": settings.SENTINEL_THRESHOLD_PROBE_LOSS_WARN_PERCENT,
        "probeLatencyWarnMs": settings.SENTINEL_THRESHOLD_PROBE_LATENCY_WARN_MS,
        "targetCritFailures": settings.SENTINEL_THRESHOLD_TARGET_CRIT_FAILURES,
    }

"""Host telemetry collection (cross-platform via psutil).

No knowledge of Django, HTTP, or authentication — returns structured dicts
suitable for the versioned heartbeat telemetry payload.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import psutil

TELEMETRY_VERSION = 1
# Short sample window so the first reading is meaningful without blocking long.
CPU_SAMPLE_INTERVAL_SECONDS = 0.1


def collect_telemetry(*, root_path: str = "/") -> dict[str, Any]:
    """Collect current host metrics.

    Units:
    - percentages: 0..100 (float)
    - memory/disk: bytes (int)
    - uptime: seconds (int)
    - collected_at: UTC ISO-8601 string
    """
    cpu_percent = float(psutil.cpu_percent(interval=CPU_SAMPLE_INTERVAL_SECONDS))
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage(root_path)
    uptime_seconds = max(0, int(time.time() - psutil.boot_time()))
    collected_at = datetime.now(timezone.utc).isoformat()

    memory_total = int(memory.total)
    memory_used = int(memory.used)
    disk_total = int(disk.total)
    disk_used = int(disk.used)

    return {
        "version": TELEMETRY_VERSION,
        "collected_at": collected_at,
        "cpu_percent": cpu_percent,
        "memory_total_bytes": memory_total,
        "memory_used_bytes": memory_used,
        "memory_percent": _percent(memory_used, memory_total),
        "disk_total_bytes": disk_total,
        "disk_used_bytes": disk_used,
        "disk_percent": _percent(disk_used, disk_total),
        "uptime_seconds": uptime_seconds,
    }


def _percent(used: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((used / total) * 100.0, 2)

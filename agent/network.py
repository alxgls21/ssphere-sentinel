"""Collect due network measurements for the heartbeat payload."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from agent.errors import ConfigError
from agent.network_config import NetworkTargetConfig, load_network_targets
from agent.network_probe import ProbeResult, probe_target

logger = logging.getLogger("sentinel_agent")

NETWORK_PAYLOAD_VERSION = 1

_monitor: NetworkMonitor | None = None


class NetworkMonitor:
    """Tracks last probe times and runs due targets."""

    def __init__(
        self,
        targets: list[NetworkTargetConfig] | None = None,
        *,
        probe_fn: Callable[[NetworkTargetConfig], ProbeResult] = probe_target,
        time_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self._targets = list(targets or [])
        self._probe_fn = probe_fn
        self._time_fn = time_fn
        self._last_probed: dict[uuid.UUID, float] = {}

    @classmethod
    def from_environment(cls) -> NetworkMonitor:
        return cls(targets=load_network_targets())

    def collect_due_measurements(
        self,
        *,
        force_all: bool = False,
    ) -> dict[str, Any]:
        """Probe due enabled targets and return a versioned network payload."""
        measurements: list[dict[str, Any]] = []
        now = self._time_fn()

        for target in self._targets:
            if not target.enabled:
                continue
            last = self._last_probed.get(target.id)
            due = (
                force_all
                or last is None
                or (now - last) >= target.monitoring_interval_seconds
            )
            if not due:
                continue

            try:
                result = self._probe_fn(target)
            except Exception as exc:  # noqa: BLE001 - keep agent alive
                logger.warning(
                    "Network probe failed for target %s: %s",
                    target.id,
                    exc,
                )
                continue

            self._last_probed[target.id] = now
            measurements.append(_measurement_payload(target, result))

        return {
            "version": NETWORK_PAYLOAD_VERSION,
            "measurements": measurements,
        }


def get_network_monitor() -> NetworkMonitor:
    """Return a process-wide monitor (caches local target config)."""
    global _monitor
    if _monitor is None:
        try:
            _monitor = NetworkMonitor.from_environment()
        except ConfigError as exc:
            logger.warning("Network target configuration error: %s", exc)
            _monitor = NetworkMonitor(targets=[])
    return _monitor


def reset_network_monitor() -> None:
    """Clear cached monitor (for tests)."""
    global _monitor
    _monitor = None


def collect_network() -> dict[str, Any]:
    """Collect due network measurements for inclusion in a heartbeat."""
    return get_network_monitor().collect_due_measurements()


def _measurement_payload(
    target: NetworkTargetConfig,
    result: ProbeResult,
) -> dict[str, Any]:
    return {
        "measurement_id": str(uuid.uuid4()),
        "target_id": str(target.id),
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "success": result.success,
        "latency_ms": result.latency_ms,
        "packet_loss_percentage": result.packet_loss_percentage,
        "probe_count": result.probe_count,
        "successful_probes": result.successful_probes,
        "failure_reason": result.failure_reason,
    }

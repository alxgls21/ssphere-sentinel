"""Wire the probe scheduler, persistent queue, and delivery together."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent.errors import ConfigError
from agent.measurement_queue import (
    MeasurementQueue,
    QueueError,
    QueueStorageError,
    default_queue_path,
    validate_queue_path,
)
from agent.network_config import NetworkTargetConfig, load_network_targets
from agent.network_delivery import NetworkDelivery
from agent.network_probe import ProbeResult
from agent.probe_scheduler import (
    DEFAULT_MAX_CONCURRENT_PROBES,
    MAX_CONCURRENT_PROBES,
    ProbeScheduler,
)

logger = logging.getLogger("sentinel_agent")

ENV_QUEUE_PATH = "SENTINEL_QUEUE_PATH"
ENV_QUEUE_MAX_MEASUREMENTS = "SENTINEL_QUEUE_MAX_MEASUREMENTS"
ENV_QUEUE_MAX_AGE_SECONDS = "SENTINEL_QUEUE_MAX_AGE_SECONDS"
ENV_MAX_CONCURRENT_PROBES = "SENTINEL_NETWORK_MAX_CONCURRENT_PROBES"

DEFAULT_QUEUE_MAX_MEASUREMENTS = 10_000
DEFAULT_QUEUE_MAX_AGE_SECONDS = 7 * 24 * 3600
SHUTDOWN_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class NetworkRuntimeConfig:
    queue_path: Path | None
    max_measurements: int = DEFAULT_QUEUE_MAX_MEASUREMENTS
    max_age_seconds: int = DEFAULT_QUEUE_MAX_AGE_SECONDS
    max_concurrent_probes: int = DEFAULT_MAX_CONCURRENT_PROBES


def load_runtime_config(environ: dict[str, str] | None = None) -> NetworkRuntimeConfig:
    """Read queue/probe settings. Invalid values are logged and defaulted so a
    configuration mistake never stops heartbeats."""
    env = environ if environ is not None else os.environ
    raw_path = (env.get(ENV_QUEUE_PATH) or "").strip()
    queue_path: Path | None
    if raw_path:
        try:
            queue_path = validate_queue_path(raw_path)
        except QueueStorageError as exc:
            logger.warning(
                "%s is invalid (%s); using an in-memory network queue", ENV_QUEUE_PATH, exc
            )
            queue_path = None
    else:
        queue_path = default_queue_path(env)

    return NetworkRuntimeConfig(
        queue_path=queue_path,
        max_measurements=_bounded_int(
            env, ENV_QUEUE_MAX_MEASUREMENTS, DEFAULT_QUEUE_MAX_MEASUREMENTS, 100, 1_000_000
        ),
        max_age_seconds=_bounded_int(
            env, ENV_QUEUE_MAX_AGE_SECONDS, DEFAULT_QUEUE_MAX_AGE_SECONDS, 3600, 30 * 24 * 3600
        ),
        max_concurrent_probes=_bounded_int(
            env,
            ENV_MAX_CONCURRENT_PROBES,
            DEFAULT_MAX_CONCURRENT_PROBES,
            1,
            MAX_CONCURRENT_PROBES,
        ),
    )


class NetworkRuntime:
    """Network monitoring for one agent process: probes -> queue -> heartbeat."""

    def __init__(
        self,
        targets: list[NetworkTargetConfig],
        queue: MeasurementQueue,
        *,
        max_concurrent_probes: int = DEFAULT_MAX_CONCURRENT_PROBES,
        probe_fn: Callable[[NetworkTargetConfig], ProbeResult] | None = None,
    ) -> None:
        self.queue = queue
        self.delivery = NetworkDelivery(queue)
        self.scheduler = ProbeScheduler(
            targets,
            sink=self.enqueue,
            probe_fn=probe_fn,
            max_workers=max_concurrent_probes,
        )

    @classmethod
    def from_environment(
        cls, environ: dict[str, str] | None = None
    ) -> NetworkRuntime | None:
        """Build the runtime, or return None when there is nothing to do.

        Nothing to do means: no enabled targets and no existing queue file to
        drain. In that case no queue file is created.
        """
        env = environ if environ is not None else os.environ
        try:
            targets = load_network_targets(env)
        except ConfigError as exc:
            logger.warning("Network target configuration error: %s", exc)
            targets = []
        config = load_runtime_config(env)
        has_targets = any(target.enabled for target in targets)
        has_backlog = config.queue_path is not None and config.queue_path.exists()
        if not has_targets and not has_backlog:
            return None
        queue = MeasurementQueue.open(
            config.queue_path,
            max_measurements=config.max_measurements,
            max_age_seconds=config.max_age_seconds,
        )
        return cls(targets, queue, max_concurrent_probes=config.max_concurrent_probes)

    def enqueue(self, measurement: dict[str, Any]) -> None:
        try:
            self.queue.enqueue(measurement)
        except QueueError as exc:
            logger.warning(
                "Network measurement %s could not be queued and is lost: %s",
                measurement.get("measurement_id"),
                exc,
            )

    def start(self) -> None:
        self.scheduler.start()

    def probe_once(self, timeout: float | None = None) -> int:
        return self.scheduler.run_once(timeout)

    def stop(self, timeout: float = SHUTDOWN_TIMEOUT_SECONDS) -> None:
        try:
            self.scheduler.stop(timeout)
        finally:
            self.queue.close()


def _bounded_int(
    env: dict[str, str], name: str, default: int, minimum: int, maximum: int
) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = None
    if value is None or value < minimum or value > maximum:
        logger.warning(
            "%s must be an integer between %d and %d; using %d",
            name,
            minimum,
            maximum,
            default,
        )
        return default
    return value

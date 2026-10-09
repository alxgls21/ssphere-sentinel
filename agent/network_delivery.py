"""Deliver queued network measurements inside heartbeats and apply acks."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agent.acknowledgement import Acknowledgement, parse_acknowledgement
from agent.measurement_queue import MeasurementQueue, QueueError

logger = logging.getLogger("sentinel_agent")

NETWORK_PAYLOAD_VERSION = 1
# Must not exceed the server's MAX_MEASUREMENTS_PER_REPORT.
MAX_BATCH_SIZE = 100
BATCH_BACKOFF_BASE_SECONDS = 30.0
BATCH_BACKOFF_MAX_SECONDS = 600.0
MAX_LOGGED_DROPS = 5


@dataclass(frozen=True)
class DeliveryBatch:
    measurements: tuple[dict[str, Any], ...] = ()

    @property
    def ids(self) -> list[str]:
        return [str(item.get("measurement_id")) for item in self.measurements]

    def section(self) -> dict[str, Any]:
        return {"version": NETWORK_PAYLOAD_VERSION, "measurements": list(self.measurements)}


class NetworkDelivery:
    """Batches pending measurements and removes them only on explicit ack.

    Batch-level failures (transport errors, non-2xx, malformed or ambiguous
    responses, section-level rejection) leave every row untouched and pause
    network batches with exponential backoff; heartbeats continue without a
    network section meanwhile. Item-level outcomes are applied per ID.
    """

    def __init__(
        self,
        queue: MeasurementQueue,
        *,
        batch_size: int = MAX_BATCH_SIZE,
        time_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self.queue = queue
        self.batch_size = max(1, min(batch_size, MAX_BATCH_SIZE))
        self._time_fn = time_fn
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._backoff_until = 0.0

    @property
    def backoff_remaining(self) -> float:
        with self._lock:
            return max(0.0, self._backoff_until - self._time_fn())

    def prepare_batch(self) -> DeliveryBatch:
        if self.backoff_remaining > 0:
            return DeliveryBatch()
        try:
            self.queue.purge_expired()
            measurements = self.queue.pending_batch(self.batch_size)
        except QueueError as exc:
            logger.warning("Network queue unavailable for delivery: %s", exc)
            return DeliveryBatch()
        return DeliveryBatch(tuple(measurements))

    def record_failure(self, batch: DeliveryBatch, reason: str) -> None:
        """Batch was not acknowledged (transport/HTTP error): keep everything."""
        if batch.measurements:
            self._back_off(reason, len(batch.measurements))

    def acknowledge(self, batch: DeliveryBatch, body: str) -> Acknowledgement | None:
        if not batch.measurements:
            return None
        ack = parse_acknowledgement(body, batch.ids)
        if ack.is_batch_failure:
            self._back_off(ack.batch_failure or "ambiguous response", len(batch.measurements))
            return ack

        with self._lock:
            self._consecutive_failures = 0
            self._backoff_until = 0.0

        _log_permanent_rejections(ack.permanent)
        if ack.unresolved:
            logger.warning(
                "Sentinel did not acknowledge %d network measurement(s); will retry",
                len(ack.unresolved),
            )
        try:
            self.queue.remove(ack.stored | set(ack.permanent))
            self.queue.mark_retry(set(ack.retryable) | ack.unresolved)
        except QueueError as exc:
            # Rows stay queued and are resent; the server treats them as duplicates.
            logger.warning("Could not update network queue after acknowledgement: %s", exc)
        return ack

    def _back_off(self, reason: str, count: int) -> None:
        with self._lock:
            self._consecutive_failures += 1
            delay = min(
                BATCH_BACKOFF_BASE_SECONDS * (2 ** (self._consecutive_failures - 1)),
                BATCH_BACKOFF_MAX_SECONDS,
            )
            self._backoff_until = self._time_fn() + delay
        logger.warning(
            "Network batch of %d measurement(s) not acknowledged (%s); "
            "kept queued, next attempt in %ds",
            count,
            reason[:200],
            int(delay),
        )


def _log_permanent_rejections(permanent: dict[str, str]) -> None:
    if not permanent:
        return
    logger.warning(
        "Dropping %d network measurement(s) permanently rejected by Sentinel",
        len(permanent),
    )
    for measurement_id, reason in list(permanent.items())[:MAX_LOGGED_DROPS]:
        logger.warning(
            "Rejected measurement %s: %s",
            measurement_id,
            "".join(ch if ch.isprintable() else " " for ch in reason)[:200] or "-",
        )

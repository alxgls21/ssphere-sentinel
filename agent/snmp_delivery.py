"""Deliver queued SNMP polls inside heartbeats and apply the acknowledgement.

The counterpart of ``network_delivery`` for the ``snmp`` section: a poll leaves
the queue only when the server names it as stored (``created`` or
``duplicate``) or rejects it permanently. Anything else stays queued.

Batch-level failures (transport errors, non-2xx, malformed or ambiguous
responses, a rejected section) leave every row untouched and pause SNMP
batches with exponential backoff; heartbeats continue without an ``snmp``
section meanwhile, so a failing SNMP section never delays telemetry, Docker or
network data. Item-level outcomes are applied per poll.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agent.acknowledgement import SNMP, Acknowledgement, parse_acknowledgement
from agent.measurement_queue import MeasurementQueue, QueueError
from agent.network_delivery import (
    BATCH_BACKOFF_BASE_SECONDS,
    BATCH_BACKOFF_MAX_SECONDS,
    MAX_LOGGED_DROPS,
)
from agent.snmp_payload import (
    MAX_INTERFACES_PER_REPORT,
    MAX_POLLS_PER_REPORT,
    MAX_REPORT_BYTES,
    SNMP_PAYLOAD_VERSION,
)

logger = logging.getLogger("sentinel_agent")


@dataclass(frozen=True)
class SnmpBatch:
    polls: tuple[dict[str, Any], ...] = ()

    @property
    def ids(self) -> list[str]:
        return [str(poll.get("poll_id")) for poll in self.polls]

    def section(self) -> dict[str, Any]:
        return {"version": SNMP_PAYLOAD_VERSION, "polls": list(self.polls)}


class SnmpDelivery:
    def __init__(
        self,
        queue: MeasurementQueue,
        *,
        time_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self.queue = queue
        self._time_fn = time_fn
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._backoff_until = 0.0

    @property
    def backoff_remaining(self) -> float:
        with self._lock:
            return max(0.0, self._backoff_until - self._time_fn())

    def prepare_batch(self) -> SnmpBatch:
        if self.backoff_remaining > 0:
            return SnmpBatch()
        try:
            self.queue.purge_expired_snmp()
            polls = self.queue.pending_snmp_batch(
                max_polls=MAX_POLLS_PER_REPORT,
                max_interfaces=MAX_INTERFACES_PER_REPORT,
                max_bytes=MAX_REPORT_BYTES,
            )
        except QueueError as exc:
            logger.warning("SNMP queue unavailable for delivery: %s", exc)
            return SnmpBatch()
        return SnmpBatch(tuple(polls))

    def record_failure(self, batch: SnmpBatch, reason: str) -> None:
        """Batch was not acknowledged (transport/HTTP error): keep everything."""
        if batch.polls:
            self._back_off(reason, len(batch.polls))

    def acknowledge(self, batch: SnmpBatch, body: str) -> Acknowledgement | None:
        if not batch.polls:
            return None
        ack = parse_acknowledgement(body, batch.ids, SNMP)
        if ack.is_batch_failure:
            self._back_off(ack.batch_failure or "ambiguous response", len(batch.polls))
            return ack

        with self._lock:
            self._consecutive_failures = 0
            self._backoff_until = 0.0

        _log_permanent_rejections(ack.permanent)
        if ack.unresolved:
            logger.warning(
                "Sentinel did not acknowledge %d SNMP poll(s); will retry", len(ack.unresolved)
            )
        if ack.retryable:
            logger.warning(
                "Sentinel could not accept %d SNMP poll(s) yet (for example the device is not "
                "assigned to this agent or has no SNMP configuration); will retry",
                len(ack.retryable),
            )
        try:
            self.queue.remove_snmp(ack.stored | set(ack.permanent))
            self.queue.mark_snmp_retry(set(ack.retryable) | ack.unresolved)
        except QueueError as exc:
            # Rows stay queued and are resent; the server treats them as duplicates.
            logger.warning("Could not update SNMP queue after acknowledgement: %s", exc)
        return ack

    def _back_off(self, reason: str, count: int) -> None:
        with self._lock:
            self._consecutive_failures += 1
            # The exponent is capped: after about a week of failures (a server
            # that never learns SNMP, say) 2 ** n no longer fits a float.
            delay = min(
                BATCH_BACKOFF_BASE_SECONDS * (2 ** min(self._consecutive_failures - 1, 16)),
                BATCH_BACKOFF_MAX_SECONDS,
            )
            self._backoff_until = self._time_fn() + delay
        logger.warning(
            "SNMP batch of %d poll(s) not acknowledged (%s); kept queued, next attempt in %ds",
            count,
            reason[:200],
            int(delay),
        )


def _log_permanent_rejections(permanent: dict[str, str]) -> None:
    if not permanent:
        return
    logger.warning(
        "Dropping %d SNMP poll(s) permanently rejected by Sentinel", len(permanent)
    )
    for poll_id, reason in list(permanent.items())[:MAX_LOGGED_DROPS]:
        logger.warning(
            "Rejected SNMP poll %s: %s",
            poll_id,
            "".join(ch if ch.isprintable() else " " for ch in reason)[:200] or "-",
        )

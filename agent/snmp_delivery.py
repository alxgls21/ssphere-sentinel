"""Deliver queued SNMP polls inside heartbeats and apply the acknowledgement.

The counterpart of ``network_delivery`` for the ``snmp`` section: a poll leaves
the queue only when the server names it as stored (``created`` or
``duplicate``) or rejects it permanently. Anything else stays queued.

Batch-level failures (transport errors, non-2xx, malformed or ambiguous
responses, a rejected section) leave every row untouched and pause SNMP
batches with exponential backoff; heartbeats continue without an ``snmp``
section meanwhile, so a failing SNMP section never delays telemetry, Docker or
network data. Item-level outcomes are applied per poll.

Size. A batch is the longest run of due polls, in queue order, that keeps the
request within ``MAX_REQUEST_BYTES`` and the ``snmp`` section within
``MAX_REPORT_BYTES``, both measured in the bytes that are sent. That is exact,
not an estimate: serialized JSON is the sum of its parts, so the polls add
their own sizes and a ``", "`` between two of them to the size of the request
without them. A poll that does not fit next to the other sections of the
heartbeat makes the batch ``deferred``: the heartbeat then sends it in a request
of its own. One that cannot fit even there can never be sent: it is removed
from the queue, with an error in the log, and the polls behind it go on.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from agent.acknowledgement import SNMP, Acknowledgement, parse_acknowledgement
from agent.http_client import MAX_REQUEST_BYTES, encoded_size, size_with_member
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

# ", " between two polls of a request.
POLL_SEPARATOR_BYTES = 2


def empty_section() -> dict[str, Any]:
    return {"version": SNMP_PAYLOAD_VERSION, "polls": []}


EMPTY_SECTION_BYTES = encoded_size(empty_section())


def request_size_with_empty_section(size: int, has_members: bool) -> int:
    """The size of a request of ``size`` bytes (``has_members`` unless it is ``{}``) once it gets an
    empty ``snmp`` section: what the polls of a batch join. Only a request that will carry polls
    has this section; the size of one that will not is its own."""
    return size_with_member(size, has_members, "snmp", EMPTY_SECTION_BYTES)


# The request that carries nothing but the section of a batch.
SNMP_ONLY_REQUEST_BYTES = request_size_with_empty_section(2, False)


@dataclass(frozen=True)
class SnmpBatch:
    polls: tuple[dict[str, Any], ...] = ()
    # The first due poll fits a request of its own but not the one being built:
    # it has to go in a separate request.
    deferred: bool = False

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

    def prepare_batch(self, request_bytes: int = SNMP_ONLY_REQUEST_BYTES) -> SnmpBatch:
        """The polls to send now. ``request_bytes`` is the size of the request they would join, with
        the empty section they bring (``request_size_with_empty_section``); the default is a request
        of their own.
        """
        if self.backoff_remaining > 0:
            return SnmpBatch()
        try:
            self.queue.purge_expired_snmp()
            # The queue's byte cap counts stored bytes, never more than the bytes sent: it only
            # limits how much is loaded, and the fit below decides.
            polls = self.queue.pending_snmp_batch(
                max_polls=MAX_POLLS_PER_REPORT,
                max_interfaces=MAX_INTERFACES_PER_REPORT,
                max_bytes=MAX_REPORT_BYTES,
            )
        except QueueError as exc:
            logger.warning("SNMP queue unavailable for delivery: %s", exc)
            return SnmpBatch()
        return self._fit(polls, request_bytes)

    def _fit(self, polls: list[dict[str, Any]], request_bytes: int) -> SnmpBatch:
        selected: list[dict[str, Any]] = []
        added = 0  # what the selected polls add to the request
        deferred = False
        for poll in polls:
            size = encoded_size(poll)
            if SNMP_ONLY_REQUEST_BYTES + size > MAX_REQUEST_BYTES:
                self._drop_unsendable(poll, SNMP_ONLY_REQUEST_BYTES + size)
                continue
            grown = added + size + (POLL_SEPARATOR_BYTES if selected else 0)
            if request_bytes + grown > MAX_REQUEST_BYTES:
                deferred = not selected
                break
            if selected and EMPTY_SECTION_BYTES + grown > MAX_REPORT_BYTES:
                break
            selected.append(poll)
            added = grown
        return SnmpBatch(tuple(selected), deferred)

    def _drop_unsendable(self, poll: dict[str, Any], request_size: int) -> None:
        """Remove a poll that no request can carry; it would otherwise block every poll behind it."""
        poll_id = str(poll.get("poll_id"))
        logger.error(
            "SNMP poll %s of device %s cannot be sent and is removed from the queue: the smallest "
            "request that could carry it is %d bytes, over the limit of %d bytes",
            poll_id,
            poll.get("device_id"),
            request_size,
            MAX_REQUEST_BYTES,
        )
        try:
            self.queue.remove_snmp([poll_id])
        except QueueError as exc:
            logger.warning("Could not remove SNMP poll %s from the queue: %s", poll_id, exc)

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

"""Run SNMP polls on per-device intervals, independent of heartbeats.

The same pattern as the network probe scheduler, with its own worker pool so
slow SNMP devices can never delay ICMP/TCP probes (or the other way round):

- Each enabled device is polled every ``poll_interval_seconds`` (start to
  start). A device never has two polls in flight: if a poll overruns its
  interval, the next one starts when it finishes, and missed slots are
  skipped rather than run in a burst.
- First polls are spread over the first seconds after start (random jitter,
  a quarter of a second per device, at most 30 s), so a restart does not hit
  every device at once yet a small deployment gets its first data promptly.
- At most ``max_workers`` polls run concurrently; threads are created once by
  the pool, never per poll.
- The scheduler thread sleeps until the next due time or a completion.
- Results go to ``sink``; failures are logged and never propagate.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from functools import partial
from typing import Any
from uuid import UUID

from agent.snmp_collector import DevicePoller
from agent.snmp_fetch import SnmpFetchCancelled

logger = logging.getLogger("sentinel_agent")

DEFAULT_MAX_CONCURRENT_POLLS = 4
MAX_CONCURRENT_POLLS = 16
# Upper bound on how long the scheduler sleeps before re-checking due devices.
MAX_IDLE_WAIT_SECONDS = 5.0
# First polls start within STAGGER_SECONDS_PER_DEVICE x devices seconds, at most
# MAX_START_JITTER_SECONDS (and never later than the device's own interval).
STAGGER_SECONDS_PER_DEVICE = 0.25
MAX_START_JITTER_SECONDS = 30.0


class SnmpScheduler:
    def __init__(
        self,
        pollers: list[DevicePoller],
        *,
        sink: Callable[[dict[str, Any]], None],
        max_workers: int = DEFAULT_MAX_CONCURRENT_POLLS,
        time_fn: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
    ) -> None:
        self._pollers = [poller for poller in pollers if poller.device.enabled]
        self._sink = sink
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._max_workers = max(1, min(max_workers, MAX_CONCURRENT_POLLS))
        self._time_fn = time_fn
        self._rng = rng or random.Random()
        self._lock = threading.Lock()
        self._in_flight: dict[UUID, Future[None]] = {}
        self._next_due: dict[UUID, float] = {}
        self._executor: ThreadPoolExecutor | None = None
        self._thread: threading.Thread | None = None

    @property
    def has_devices(self) -> bool:
        return bool(self._pollers)

    @property
    def device_count(self) -> int:
        """Number of enabled devices this scheduler polls."""
        return len(self._pollers)

    @property
    def max_workers(self) -> int:
        return self._max_workers

    def start(self) -> None:
        if not self._pollers or self._thread is not None:
            return
        self._executor = ThreadPoolExecutor(
            max_workers=self._max_workers, thread_name_prefix="sentinel-snmp"
        )
        now = self._time_fn()
        window = min(
            MAX_START_JITTER_SECONDS, STAGGER_SECONDS_PER_DEVICE * len(self._pollers)
        )
        self._next_due = {
            poller.device.id: now
            + self._rng.uniform(0.0, min(float(poller.device.poll_interval_seconds), window))
            for poller in self._pollers
        }
        self._thread = threading.Thread(
            target=self._loop, name="sentinel-snmp-scheduler", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> bool:
        """Stop dispatching and wait (bounded) for running polls.

        Running polls are cancelled and end within a fraction of a second.
        Returns False if some poll was still running when ``timeout`` expired.
        """
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)
        if self._executor is None:
            return True
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            pending = list(self._in_flight.values())
        running = [future for future in pending if not future.cancelled()]
        _done, not_done = wait(running, timeout=timeout)
        if not_done:
            logger.warning("%d SNMP poll(s) still running at shutdown", len(not_done))
        return not not_done

    def run_once(self, timeout: float | None = None) -> int:
        """Poll every enabled device once (one-shot CLI). Returns polls started."""
        if not self._pollers:
            return 0
        with ThreadPoolExecutor(
            max_workers=self._max_workers, thread_name_prefix="sentinel-snmp"
        ) as executor:
            futures = [executor.submit(self._run_one, poller) for poller in self._pollers]
            wait(futures, timeout=timeout)
            if timeout is not None:
                self._stop.set()  # cancels polls that outlived the timeout
        return len(futures)

    # -- internals ---------------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                delay = self._dispatch_due()
            except Exception as exc:  # noqa: BLE001 - scheduler must keep running
                logger.warning("SNMP poll scheduling error: %s", exc)
                delay = MAX_IDLE_WAIT_SECONDS
            self._wake.wait(timeout=delay)
            self._wake.clear()

    def _dispatch_due(self) -> float:
        now = self._time_fn()
        soonest: float | None = None
        for poller in self._pollers:
            device = poller.device
            with self._lock:
                busy = device.id in self._in_flight
            due = self._next_due[device.id]
            if busy:
                continue  # completion wakes the loop
            if now >= due:
                if not self._submit(poller):
                    return MAX_IDLE_WAIT_SECONDS
                interval = device.poll_interval_seconds
                following = due + interval
                # After a stall, skip missed slots instead of bursting.
                self._next_due[device.id] = following if following > now else now + interval
                continue
            soonest = due if soonest is None else min(soonest, due)
        if soonest is None:
            return MAX_IDLE_WAIT_SECONDS
        return max(0.0, min(soonest - now, MAX_IDLE_WAIT_SECONDS))

    def _submit(self, poller: DevicePoller) -> bool:
        if self._executor is None or self._stop.is_set():
            return False
        with self._lock:
            try:
                future = self._executor.submit(self._run_one, poller)
            except RuntimeError:  # executor already shut down
                return False
            self._in_flight[poller.device.id] = future
        future.add_done_callback(partial(self._finished, poller.device.id))
        return True

    def _finished(self, device_id: UUID, _future: Future[None]) -> None:
        with self._lock:
            self._in_flight.pop(device_id, None)
        self._wake.set()

    def _run_one(self, poller: DevicePoller) -> None:
        if self._stop.is_set():
            return
        try:
            poll = poller.poll(cancel=self._stop)
        except SnmpFetchCancelled:
            return
        except Exception as exc:  # noqa: BLE001 - one device must not affect others
            logger.warning("SNMP poll failed for device %s: %s", poller.device.id, exc)
            return
        try:
            self._sink(poll)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "SNMP poll for device %s could not be stored: %s", poller.device.id, exc
            )

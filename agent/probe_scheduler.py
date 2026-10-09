"""Run network probes on per-target intervals, independent of heartbeats."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from functools import partial
from typing import Any
from uuid import UUID

from agent.network import build_measurement
from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeCancelled, ProbeResult, probe_target

logger = logging.getLogger("sentinel_agent")

DEFAULT_MAX_CONCURRENT_PROBES = 4
MAX_CONCURRENT_PROBES = 16
# Upper bound on how long the scheduler sleeps before re-checking due targets.
MAX_IDLE_WAIT_SECONDS = 5.0


class ProbeScheduler:
    """Dispatch due probes to a fixed-size worker pool.

    - Each enabled target is probed every ``monitoring_interval_seconds``
      (start to start). A target never has two probes in flight: if a probe
      overruns its interval, the next one starts when it finishes.
    - At most ``max_workers`` probes run concurrently; threads are created
      once by the pool, never per probe.
    - The scheduler thread sleeps until the next due time or a probe
      completion (no busy loop).
    - Results go to ``sink``; failures are logged and never propagate.
    """

    def __init__(
        self,
        targets: list[NetworkTargetConfig],
        *,
        sink: Callable[[dict[str, Any]], None],
        probe_fn: Callable[[NetworkTargetConfig], ProbeResult] | None = None,
        max_workers: int = DEFAULT_MAX_CONCURRENT_PROBES,
        time_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self._targets = [target for target in targets if target.enabled]
        self._sink = sink
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._probe_fn = probe_fn or partial(probe_target, stop_event=self._stop)
        self._max_workers = max(1, min(max_workers, MAX_CONCURRENT_PROBES))
        self._time_fn = time_fn
        self._lock = threading.Lock()
        self._in_flight: dict[UUID, Future[None]] = {}
        self._next_due: dict[UUID, float] = {}
        self._executor: ThreadPoolExecutor | None = None
        self._thread: threading.Thread | None = None

    @property
    def has_targets(self) -> bool:
        return bool(self._targets)

    @property
    def max_workers(self) -> int:
        return self._max_workers

    def start(self) -> None:
        if not self._targets or self._thread is not None:
            return
        self._executor = ThreadPoolExecutor(
            max_workers=self._max_workers, thread_name_prefix="sentinel-probe"
        )
        now = self._time_fn()
        self._next_due = {target.id: now for target in self._targets}
        self._thread = threading.Thread(
            target=self._loop, name="sentinel-probe-scheduler", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> bool:
        """Stop dispatching and wait (bounded) for running probes.

        Running probes stop at their next attempt boundary. Returns False if
        some probe was still running when ``timeout`` expired.
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
        # Futures cancelled by shutdown never reach a "done" state for wait().
        running = [future for future in pending if not future.cancelled()]
        _done, not_done = wait(running, timeout=timeout)
        if not_done:
            logger.warning(
                "%d network probe(s) still running at shutdown", len(not_done)
            )
        return not not_done

    def run_once(self, timeout: float | None = None) -> int:
        """Probe every enabled target once (one-shot CLI). Returns probes run."""
        if not self._targets:
            return 0
        with ThreadPoolExecutor(
            max_workers=self._max_workers, thread_name_prefix="sentinel-probe"
        ) as executor:
            futures = [executor.submit(self._run_one, target) for target in self._targets]
            wait(futures, timeout=timeout)
            if timeout is not None:
                self._stop.set()
        return len(futures)

    # -- internals -----------------------------------------------------------------

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                delay = self._dispatch_due()
            except Exception as exc:  # noqa: BLE001 - scheduler must keep running
                logger.warning("Network probe scheduling error: %s", exc)
                delay = MAX_IDLE_WAIT_SECONDS
            self._wake.wait(timeout=delay)
            self._wake.clear()

    def _dispatch_due(self) -> float:
        now = self._time_fn()
        soonest: float | None = None
        for target in self._targets:
            with self._lock:
                busy = target.id in self._in_flight
            due = self._next_due[target.id]
            if busy:
                continue  # completion wakes the loop
            if now >= due:
                if not self._submit(target):
                    return MAX_IDLE_WAIT_SECONDS
                interval = target.monitoring_interval_seconds
                following = due + interval
                # After a stall, skip missed slots instead of bursting.
                self._next_due[target.id] = following if following > now else now + interval
                continue
            soonest = due if soonest is None else min(soonest, due)
        if soonest is None:
            return MAX_IDLE_WAIT_SECONDS
        return max(0.0, min(soonest - now, MAX_IDLE_WAIT_SECONDS))

    def _submit(self, target: NetworkTargetConfig) -> bool:
        if self._executor is None or self._stop.is_set():
            return False
        with self._lock:
            try:
                future = self._executor.submit(self._run_one, target)
            except RuntimeError:  # executor already shut down
                return False
            self._in_flight[target.id] = future
        future.add_done_callback(partial(self._finished, target.id))
        return True

    def _finished(self, target_id: UUID, _future: Future[None]) -> None:
        with self._lock:
            self._in_flight.pop(target_id, None)
        self._wake.set()

    def _run_one(self, target: NetworkTargetConfig) -> None:
        if self._stop.is_set():
            return
        try:
            result = self._probe_fn(target)
        except ProbeCancelled:
            return
        except Exception as exc:  # noqa: BLE001 - one target must not affect others
            logger.warning("Network probe failed for target %s: %s", target.id, exc)
            return
        try:
            self._sink(build_measurement(target, result))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Network measurement for target %s could not be stored: %s",
                target.id,
                exc,
            )

"""Synchronization helpers for tests that exercise the schedulers.

Tests must not depend on how quickly a loaded host wakes a sleeping thread, so
they either control the scheduler's clock and drive its dispatch step directly
(``ManualClock``, ``InlineExecutor``, ``prime``), or wait for the event they
expect instead of sleeping for a fixed time (``Tally``, ``LogWatcher``).
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import Future

# Upper bound for conditions that are certain to happen. A passing test never
# waits this long; only a failing one does.
WAIT_SECONDS = 30.0


class Tally:
    """A thread-safe counter whose waiters wake as soon as a value is reached."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._value = 0

    @property
    def value(self) -> int:
        with self._condition:
            return self._value

    def increment(self) -> None:
        with self._condition:
            self._value += 1
            self._condition.notify_all()

    def wait_for(self, minimum: int, timeout: float = WAIT_SECONDS) -> bool:
        with self._condition:
            return self._condition.wait_for(lambda: self._value >= minimum, timeout)


class ManualClock:
    """A monotonic clock that only moves when the test says so."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


class InlineExecutor:
    """Runs submitted work in the calling thread, so a dispatch step completes synchronously."""

    def submit(self, fn, *args, **kwargs) -> Future:
        future: Future = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 - mirrors a real executor
            future.set_exception(exc)
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        pass


class DeferredExecutor:
    """Queues submitted work until the test runs it, so a poll can be "in flight" for as long as needed."""

    def __init__(self) -> None:
        self.pending: list[tuple[Future, object, tuple, dict]] = []

    def submit(self, fn, *args, **kwargs) -> Future:
        future: Future = Future()
        self.pending.append((future, fn, args, kwargs))
        return future

    def run_next(self) -> None:
        future, fn, args, kwargs = self.pending.pop(0)
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:  # noqa: BLE001 - mirrors a real executor
            future.set_exception(exc)

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        pass


def prime(scheduler, ids, clock: ManualClock, executor=None) -> None:
    """Make every device or target due now and run the scheduler's work on ``executor``.

    The scheduler's thread is never started: the test calls ``_dispatch_due()``
    itself after moving ``clock``, which makes each scheduling decision
    exact and repeatable. Without an ``executor`` the work runs inline.
    """
    scheduler._executor = executor or InlineExecutor()
    scheduler._next_due = {identifier: clock() for identifier in ids}


class LogWatcher(logging.Handler):
    """Collects log messages and lets a test wait for one to appear."""

    def __init__(self, logger_name: str = "sentinel_agent") -> None:
        super().__init__(level=logging.WARNING)
        self._condition = threading.Condition()
        self._messages: list[str] = []
        self._logger = logging.getLogger(logger_name)

    def __enter__(self) -> LogWatcher:
        self._logger.addHandler(self)
        return self

    def __exit__(self, *_exc) -> None:
        self._logger.removeHandler(self)

    def emit(self, record: logging.LogRecord) -> None:
        with self._condition:
            self._messages.append(record.getMessage())
            self._condition.notify_all()

    @property
    def messages(self) -> list[str]:
        with self._condition:
            return list(self._messages)

    def wait_for(self, text: str, timeout: float = WAIT_SECONDS) -> bool:
        with self._condition:
            return self._condition.wait_for(
                lambda: any(text in message for message in self._messages), timeout
            )

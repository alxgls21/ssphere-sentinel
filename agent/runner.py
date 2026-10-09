"""Foreground continuous heartbeat loop (network probes run separately)."""

from __future__ import annotations

import logging
import signal
import sys
import threading
import time
from collections.abc import Callable

from agent.config import Config
from agent.errors import AgentError
from agent.heartbeat import send_heartbeat

logger = logging.getLogger("sentinel_agent")


def _redact(text: str, secret: str) -> str:
    if secret and secret in text:
        return text.replace(secret, "***")
    return text


def run_continuous(
    config: Config,
    *,
    send_fn: Callable[[Config], None] = send_heartbeat,
    stop_event: threading.Event | None = None,
    max_iterations: int | None = None,
    install_signal_handlers: bool = True,
    time_fn: Callable[[], float] = time.monotonic,
) -> int:
    """Send heartbeats until stopped.

    Sends one heartbeat immediately, then on a fixed-rate monotonic schedule:
    attempt N starts at ``start + N * heartbeat_interval`` regardless of how
    long each attempt took. If an attempt overruns one or more slots, the
    missed slots are skipped (logged) rather than sent in a burst. Heartbeat
    failures are logged and the loop continues. Returns ``0`` on graceful
    shutdown.
    """
    stop = stop_event if stop_event is not None else threading.Event()
    previous_handlers: dict[int, object] = {}

    def _request_stop(signum: int, _frame: object) -> None:
        logger.info("Received signal %s; stopping", signum)
        stop.set()

    if install_signal_handlers:
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, _request_stop)

    interval = config.heartbeat_interval
    iterations = 0
    next_run = time_fn()
    try:
        while not stop.is_set():
            try:
                send_fn(config)
                print("Heartbeat successful.")
            except AgentError as exc:
                message = _redact(str(exc), config.agent_token)
                print(f"Heartbeat failed: {message}", file=sys.stderr)
                logger.warning("Heartbeat failed: %s", message)
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                message = _redact(str(exc), config.agent_token)
                print(f"Heartbeat failed: {message}", file=sys.stderr)
                logger.warning("Heartbeat failed: %s", message)

            iterations += 1
            if max_iterations is not None and iterations >= max_iterations:
                break

            now = time_fn()
            if interval > 0:
                next_run += interval
                if next_run <= now:
                    missed = int((now - next_run) // interval) + 1
                    next_run += missed * interval
                    logger.warning(
                        "Heartbeat took longer than the interval; skipped %d slot(s)",
                        missed,
                    )
            else:
                next_run = now

            # Interruptible sleep until the next scheduled heartbeat.
            if stop.wait(timeout=max(0.0, next_run - now)):
                break
    finally:
        if install_signal_handlers:
            for sig, handler in previous_handlers.items():
                signal.signal(sig, handler)  # type: ignore[arg-type]

    print("Agent stopped.", file=sys.stderr)
    return 0

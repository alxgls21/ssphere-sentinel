"""Command-line interface for the SSphere Sentinel agent."""

from __future__ import annotations

import argparse
import logging
import sys
from functools import partial

from agent import __version__
from agent.config import Config, load_config
from agent.errors import ConfigError, redact
from agent.heartbeat import send_heartbeat
from agent.logs import LOGGER_NAME, configure_logging
from agent.network_runtime import NetworkRuntime
from agent.runner import run_continuous

logger = logging.getLogger(LOGGER_NAME)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sentinel-agent",
        description="SSphere Sentinel agent for monitored hosts",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "heartbeat",
        help="Send a single heartbeat to the Sentinel server",
    )
    subparsers.add_parser(
        "run",
        help=(
            "Run continuously in the foreground, sending heartbeats on an "
            "interval (for systemd or another supervisor)"
        ),
    )
    return parser


def _build_network_runtime() -> NetworkRuntime | None:
    try:
        return NetworkRuntime.from_environment()
    except Exception as exc:  # noqa: BLE001 - network must never block heartbeats
        logger.warning("Network monitoring disabled: %s", exc)
        return None


def run_heartbeat() -> int:
    """Execute the one-shot heartbeat subcommand. Returns a process exit code.

    With network monitoring configured, probes every enabled target once,
    queues the results, and delivers pending measurements in this heartbeat.
    """
    token_for_redaction = ""
    runtime: NetworkRuntime | None = None
    try:
        config = load_config()
        token_for_redaction = config.agent_token
        runtime = _build_network_runtime()
        if runtime is None:
            send_heartbeat(config)
        else:
            runtime.probe_once()
            send_heartbeat(config, network_delivery=runtime.delivery)
    except ConfigError as exc:
        print(f"Heartbeat failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level CLI boundary
        message = redact(str(exc), token_for_redaction)
        print(f"Heartbeat failed: {message}", file=sys.stderr)
        return 1
    finally:
        if runtime is not None:
            runtime.stop()

    print("Heartbeat successful.")
    return 0


def run_agent() -> int:
    """Execute the continuous foreground run loop.

    Network probes (if configured) run on their own scheduler threads and
    feed the persistent queue; the heartbeat loop delivers queued batches.
    """
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"Agent failed: {exc}", file=sys.stderr)
        return 1

    runtime = _build_network_runtime()
    _log_startup(config, runtime)
    if runtime is None:
        send_fn = send_heartbeat
    else:
        send_fn = partial(send_heartbeat, network_delivery=runtime.delivery)
        runtime.start()
    try:
        return run_continuous(config, send_fn=send_fn)
    except KeyboardInterrupt:
        # Fallback if a signal races past our handlers.
        logger.info("Agent stopped")
        return 0
    finally:
        if runtime is not None:
            runtime.stop()


def _log_startup(config: Config, runtime: NetworkRuntime | None) -> None:
    """One summary of what this agent process will do (never the token)."""
    logger.info(
        "SSphere Sentinel agent %s starting: server %s, heartbeat every %ds",
        __version__,
        config.sentinel_url,
        config.heartbeat_interval,
    )
    if runtime is None:
        logger.info("Network monitoring: no enabled targets configured")
        return
    queue = runtime.queue
    logger.info(
        "Network monitoring: %d enabled target(s), queue %s",
        runtime.scheduler.target_count,
        queue.path if queue.persistent else "in memory (not persistent)",
    )


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "heartbeat":
        return run_heartbeat()
    if args.command == "run":
        return run_agent()

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

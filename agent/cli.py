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
from agent.snmp_runtime import SnmpRuntime

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


def _build_snmp_runtime(network: NetworkRuntime | None) -> SnmpRuntime | None:
    try:
        return SnmpRuntime.from_environment(queue=network.queue if network is not None else None)
    except Exception as exc:  # noqa: BLE001 - SNMP must never block heartbeats
        logger.warning("SNMP monitoring disabled: %s", exc)
        return None


def _deliveries(network: NetworkRuntime | None, snmp: SnmpRuntime | None) -> dict[str, object]:
    """Keyword arguments for ``send_heartbeat``: only the subsystems that are active."""
    deliveries: dict[str, object] = {}
    if network is not None:
        deliveries["network_delivery"] = network.delivery
    if snmp is not None:
        deliveries["snmp_delivery"] = snmp.delivery
    return deliveries


def run_heartbeat() -> int:
    """Execute the one-shot heartbeat subcommand. Returns a process exit code.

    With network monitoring configured, probes every enabled target once,
    queues the results, and delivers pending measurements in this heartbeat.
    SNMP does the same: every enabled device is polled once.
    """
    token_for_redaction = ""
    runtime: NetworkRuntime | None = None
    snmp: SnmpRuntime | None = None
    try:
        config = load_config()
        token_for_redaction = config.agent_token
        runtime = _build_network_runtime()
        snmp = _build_snmp_runtime(runtime)
        if runtime is None and snmp is None:
            send_heartbeat(config)
        else:
            if runtime is not None:
                runtime.probe_once()
            if snmp is not None:
                snmp.poll_once()
            send_heartbeat(config, **_deliveries(runtime, snmp))
    except ConfigError as exc:
        print(f"Heartbeat failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level CLI boundary
        message = redact(str(exc), token_for_redaction)
        print(f"Heartbeat failed: {message}", file=sys.stderr)
        return 1
    finally:
        # SNMP first: it may share (and must not outlive) the network queue.
        if snmp is not None:
            snmp.stop()
        if runtime is not None:
            runtime.stop()

    print("Heartbeat successful.")
    return 0


def run_agent() -> int:
    """Execute the continuous foreground run loop.

    Network probes and SNMP polls (if configured) run on their own scheduler
    threads and feed the persistent queue; the heartbeat loop delivers queued
    batches.
    """
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"Agent failed: {exc}", file=sys.stderr)
        return 1

    runtime = _build_network_runtime()
    snmp = _build_snmp_runtime(runtime)
    _log_startup(config, runtime, snmp)
    deliveries = _deliveries(runtime, snmp)
    send_fn = partial(send_heartbeat, **deliveries) if deliveries else send_heartbeat
    if runtime is not None:
        runtime.start()
    if snmp is not None:
        snmp.start()
    try:
        return run_continuous(config, send_fn=send_fn)
    except KeyboardInterrupt:
        # Fallback if a signal races past our handlers.
        logger.info("Agent stopped")
        return 0
    finally:
        if snmp is not None:
            snmp.stop()
        if runtime is not None:
            runtime.stop()


def _log_startup(
    config: Config, runtime: NetworkRuntime | None, snmp: SnmpRuntime | None = None
) -> None:
    """One summary of what this agent process will do (never the token)."""
    logger.info(
        "SSphere Sentinel agent %s starting: server %s, heartbeat every %ds",
        __version__,
        config.sentinel_url,
        config.heartbeat_interval,
    )
    if runtime is None:
        logger.info("Network monitoring: no enabled targets configured")
    else:
        queue = runtime.queue
        logger.info(
            "Network monitoring: %d enabled target(s), queue %s",
            runtime.scheduler.target_count,
            queue.path if queue.persistent else "in memory (not persistent)",
        )
    if snmp is not None:
        logger.info(
            "SNMP monitoring: %d enabled device(s), %d concurrent poll(s) at most",
            snmp.scheduler.device_count,
            snmp.scheduler.max_workers,
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

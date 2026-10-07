"""Command-line interface for the SSphere Sentinel agent."""

from __future__ import annotations

import argparse
import logging
import sys

from agent.config import load_config
from agent.errors import AgentError, ConfigError
from agent.heartbeat import send_heartbeat


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.WARNING,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )


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
    return parser


def _redact(text: str, secret: str) -> str:
    if secret and secret in text:
        return text.replace(secret, "***")
    return text


def run_heartbeat(argv: list[str] | None = None) -> int:
    """Execute the heartbeat subcommand. Returns a process exit code."""
    token_for_redaction = ""
    try:
        config = load_config()
        token_for_redaction = config.agent_token
        send_heartbeat(config)
    except ConfigError as exc:
        print(f"Heartbeat failed: {exc}", file=sys.stderr)
        return 1
    except AgentError as exc:
        message = _redact(str(exc), token_for_redaction)
        print(f"Heartbeat failed: {message}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level CLI boundary
        message = _redact(str(exc), token_for_redaction)
        print(f"Heartbeat failed: {message}", file=sys.stderr)
        return 1

    print("Heartbeat successful.")
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_logging()
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.command == "heartbeat":
        return run_heartbeat()

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

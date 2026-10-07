"""Heartbeat command logic."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from agent.config import Config, uses_insecure_http
from agent.docker_discovery import collect_docker
from agent.errors import HeartbeatError
from agent.http_client import post_json
from agent.telemetry import collect_telemetry

logger = logging.getLogger("sentinel_agent")


def build_heartbeat_payload(
    *,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
    docker_fn: Callable[[], dict[str, Any]] = collect_docker,
) -> dict[str, Any]:
    """Build the JSON body for a heartbeat request.

    Telemetry and Docker collectors are independent. Failures in either are
    logged locally; the other subsystem and liveness still proceed.
    """
    payload: dict[str, Any] = {}
    try:
        payload["telemetry"] = collect_fn()
    except Exception as exc:  # noqa: BLE001 - keep liveness working
        logger.warning("Telemetry collection failed: %s", exc)

    try:
        payload["docker"] = docker_fn()
    except Exception as exc:  # noqa: BLE001 - collector should not raise; belt-and-suspenders
        logger.warning("Docker collection failed: %s", exc)

    return payload


def send_heartbeat(
    config: Config,
    *,
    timeout: float | None = None,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
    docker_fn: Callable[[], dict[str, Any]] = collect_docker,
) -> None:
    """POST a heartbeat (with optional telemetry/Docker) to Sentinel."""
    if uses_insecure_http(config):
        logger.warning(
            "SENTINEL_URL uses HTTP; HTTPS is expected for normal deployments"
        )

    headers = {"Authorization": f"Bearer {config.agent_token}"}
    payload = build_heartbeat_payload(collect_fn=collect_fn, docker_fn=docker_fn)
    kwargs: dict[str, Any] = {"payload": payload}
    if timeout is not None:
        kwargs["timeout"] = timeout

    # Token is only passed via the Authorization header, never the URL.
    response = post_json(config.heartbeat_url, headers=headers, **kwargs)

    if 200 <= response.status < 300:
        logger.info("Heartbeat accepted by Sentinel")
        return

    raise HeartbeatError(f"server returned HTTP {response.status}")

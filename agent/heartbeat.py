"""Heartbeat command logic."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from agent.config import Config, uses_insecure_http
from agent.docker_discovery import collect_docker
from agent.errors import HeartbeatError
from agent.http_client import post_json
from agent.network import collect_network
from agent.telemetry import collect_telemetry

logger = logging.getLogger("sentinel_agent")


def build_heartbeat_payload(
    *,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
    docker_fn: Callable[[], dict[str, Any]] = collect_docker,
    network_fn: Callable[[], dict[str, Any]] = collect_network,
) -> dict[str, Any]:
    """Build the JSON body for a heartbeat request.

    Telemetry, Docker, and network collectors are independent. Failures in one
    are logged locally; other subsystems and liveness still proceed.
    """
    payload: dict[str, Any] = {}
    try:
        payload["telemetry"] = collect_fn()
    except Exception as exc:  # noqa: BLE001 - keep liveness working
        logger.warning("Telemetry collection failed: %s", exc)

    try:
        payload["docker"] = docker_fn()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Docker collection failed: %s", exc)

    try:
        network_payload = network_fn()
        # Omit empty measurement lists to keep payloads small/compatible.
        if network_payload.get("measurements"):
            payload["network"] = network_payload
    except Exception as exc:  # noqa: BLE001
        logger.warning("Network collection failed: %s", exc)

    return payload


def send_heartbeat(
    config: Config,
    *,
    timeout: float | None = None,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
    docker_fn: Callable[[], dict[str, Any]] = collect_docker,
    network_fn: Callable[[], dict[str, Any]] = collect_network,
) -> None:
    """POST a heartbeat (with optional telemetry/Docker/network) to Sentinel."""
    if uses_insecure_http(config):
        logger.warning(
            "SENTINEL_URL uses HTTP; HTTPS is expected for normal deployments"
        )

    headers = {"Authorization": f"Bearer {config.agent_token}"}
    payload = build_heartbeat_payload(
        collect_fn=collect_fn,
        docker_fn=docker_fn,
        network_fn=network_fn,
    )
    kwargs: dict[str, Any] = {"payload": payload}
    if timeout is not None:
        kwargs["timeout"] = timeout

    # Token is only passed via the Authorization header, never the URL.
    response = post_json(config.heartbeat_url, headers=headers, **kwargs)

    if 200 <= response.status < 300:
        logger.info("Heartbeat accepted by Sentinel")
        return

    raise HeartbeatError(f"server returned HTTP {response.status}")

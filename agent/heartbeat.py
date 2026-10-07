"""Heartbeat command logic."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from agent.config import Config, uses_insecure_http
from agent.errors import HeartbeatError
from agent.http_client import post_json
from agent.telemetry import collect_telemetry

logger = logging.getLogger("sentinel_agent")


def build_heartbeat_payload(
    *,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
) -> dict[str, Any]:
    """Build the JSON body for a heartbeat request.

    Telemetry collection failures are logged; the payload then omits telemetry
    so liveness can still be reported.
    """
    payload: dict[str, Any] = {}
    try:
        payload["telemetry"] = collect_fn()
    except Exception as exc:  # noqa: BLE001 - keep liveness working
        logger.warning("Telemetry collection failed: %s", exc)
    return payload


def send_heartbeat(
    config: Config,
    *,
    timeout: float | None = None,
    collect_fn: Callable[[], dict[str, Any]] = collect_telemetry,
) -> None:
    """POST a heartbeat (with optional telemetry) to Sentinel."""
    if uses_insecure_http(config):
        logger.warning(
            "SENTINEL_URL uses HTTP; HTTPS is expected for normal deployments"
        )

    headers = {"Authorization": f"Bearer {config.agent_token}"}
    payload = build_heartbeat_payload(collect_fn=collect_fn)
    kwargs: dict[str, Any] = {"payload": payload}
    if timeout is not None:
        kwargs["timeout"] = timeout

    # Token is only passed via the Authorization header, never the URL.
    response = post_json(config.heartbeat_url, headers=headers, **kwargs)

    if 200 <= response.status < 300:
        logger.info("Heartbeat accepted by Sentinel")
        return

    raise HeartbeatError(f"server returned HTTP {response.status}")

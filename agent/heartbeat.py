"""Heartbeat command logic."""

from __future__ import annotations

import logging

from agent.config import Config, uses_insecure_http
from agent.errors import HeartbeatError
from agent.http_client import post_json

logger = logging.getLogger("sentinel_agent")


def send_heartbeat(config: Config, *, timeout: float | None = None) -> None:
    """POST a heartbeat to Sentinel using the configured Bearer token."""
    if uses_insecure_http(config):
        logger.warning(
            "SENTINEL_URL uses HTTP; HTTPS is expected for normal deployments"
        )

    headers = {"Authorization": f"Bearer {config.agent_token}"}
    kwargs = {}
    if timeout is not None:
        kwargs["timeout"] = timeout

    # Token is only passed via the Authorization header, never the URL.
    response = post_json(config.heartbeat_url, headers=headers, **kwargs)

    if 200 <= response.status < 300:
        logger.info("Heartbeat accepted by Sentinel")
        return

    raise HeartbeatError(f"server returned HTTP {response.status}")

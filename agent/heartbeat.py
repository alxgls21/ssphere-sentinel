"""Heartbeat command logic."""

from __future__ import annotations

import functools
import json
import logging
from collections.abc import Callable
from typing import Any

from agent.config import Config, uses_insecure_http
from agent.docker_discovery import collect_docker
from agent.errors import HeartbeatError
from agent.http_client import post_json
from agent.network_delivery import DeliveryBatch, NetworkDelivery
from agent.telemetry import collect_telemetry

logger = logging.getLogger("sentinel_agent")

SUBSYSTEM_DETAIL_KEYS = {
    "telemetry": "detail",
    "docker": "docker_detail",
    "network": "network_detail",
}
MAX_LOGGED_TEXT_LENGTH = 200
MAX_LOGGED_REJECTIONS = 5


def build_heartbeat_payload(
    *,
    collect_fn: Callable[[], dict[str, Any]] | None = None,
    docker_fn: Callable[[], dict[str, Any]] | None = None,
    network_fn: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the JSON body for a heartbeat request.

    Telemetry, Docker, and network collectors are independent. Failures in one
    are logged locally; other subsystems and liveness still proceed. Without
    ``network_fn`` the heartbeat carries no network section: measurements are
    only ever sent from the persistent queue (see ``NetworkDelivery``).
    """
    # Resolved at call time (not as default arguments) so the module-level
    # collectors can be replaced, e.g. patched in tests.
    collect_fn = collect_fn or collect_telemetry
    docker_fn = docker_fn or collect_docker
    payload: dict[str, Any] = {}
    try:
        payload["telemetry"] = collect_fn()
    except Exception as exc:  # noqa: BLE001 - keep liveness working
        logger.warning("Telemetry collection failed: %s", exc)

    try:
        payload["docker"] = docker_fn()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Docker collection failed: %s", exc)

    if network_fn is not None:
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
    collect_fn: Callable[[], dict[str, Any]] | None = None,
    docker_fn: Callable[[], dict[str, Any]] | None = None,
    network_fn: Callable[[], dict[str, Any]] | None = None,
    network_delivery: NetworkDelivery | None = None,
) -> None:
    """POST a heartbeat (with optional telemetry/Docker/network) to Sentinel.

    With ``network_delivery``, the network section is a batch from the
    persistent queue (``network_fn`` is ignored) and queued measurements are
    removed only according to the server's explicit acknowledgement.
    """
    if uses_insecure_http(config):
        _warn_insecure_http(config.sentinel_url)

    batch = DeliveryBatch()
    if network_delivery is not None:
        batch = network_delivery.prepare_batch()
        network_fn = batch.section

    headers = {"Authorization": f"Bearer {config.agent_token}"}
    payload = build_heartbeat_payload(
        collect_fn=collect_fn,
        docker_fn=docker_fn,
        network_fn=network_fn,
    )
    kwargs: dict[str, Any] = {"payload": payload}
    if timeout is not None:
        kwargs["timeout"] = timeout

    try:
        # Token is only passed via the Authorization header, never the URL.
        response = post_json(config.heartbeat_url, headers=headers, **kwargs)
    except Exception:
        if network_delivery is not None:
            network_delivery.record_failure(batch, "request failed")
        raise

    if 200 <= response.status < 300:
        logger.info("Heartbeat accepted by Sentinel")
        log_subsystem_status(response.body)
        if network_delivery is not None:
            network_delivery.acknowledge(batch, response.body)
        return

    if network_delivery is not None:
        network_delivery.record_failure(batch, f"HTTP {response.status}")
    if 300 <= response.status < 400:
        raise HeartbeatError(
            f"server returned HTTP {response.status} redirect; redirects are not "
            "followed, set SENTINEL_URL to the final https:// address"
        )
    raise HeartbeatError(f"server returned HTTP {response.status}")


@functools.cache
def _warn_insecure_http(_url: str) -> None:
    """Warn once per process (per URL) instead of on every heartbeat."""
    logger.warning("SENTINEL_URL uses HTTP; HTTPS is expected for normal deployments")


def log_subsystem_status(body: str) -> dict[str, str]:
    """Log per-subsystem results from a 2xx heartbeat response.

    A 2xx only proves liveness was recorded; telemetry, Docker and network
    data may still have been rejected. Returns ``{subsystem: status}`` for the
    subsystems the server reported on. Only server-generated status fields are
    logged, truncated and stripped of control characters.
    """
    try:
        data = json.loads(body) if body and body.strip() else {}
    except ValueError:
        logger.warning("Heartbeat response is not valid JSON; subsystem status unknown")
        return {}
    if not isinstance(data, dict):
        logger.warning("Heartbeat response is not a JSON object; subsystem status unknown")
        return {}

    statuses: dict[str, str] = {}
    for subsystem, detail_key in SUBSYSTEM_DETAIL_KEYS.items():
        status = data.get(subsystem)
        if not isinstance(status, str):
            continue
        statuses[subsystem] = status
        if subsystem == "network":
            _log_network_status(status, data)
        elif status == "accepted":
            logger.info("Sentinel accepted %s", subsystem)
        else:
            logger.warning(
                "Sentinel %s %s: %s",
                _safe_text(status),
                subsystem,
                _safe_text(data.get(detail_key)),
            )
    return statuses


def _log_network_status(status: str, data: dict[str, Any]) -> None:
    accepted = data.get("network_accepted")
    rejected = data.get("network_rejected")
    if status == "accepted":
        logger.info("Sentinel accepted network measurements (accepted=%s)", accepted)
        return

    logger.warning(
        "Sentinel %s network measurements (accepted=%s, rejected=%s): %s",
        _safe_text(status),
        accepted if isinstance(accepted, int) else "unknown",
        rejected if isinstance(rejected, int) else "unknown",
        _safe_text(data.get("network_detail")),
    )
    rejections = data.get("network_rejections")
    if not isinstance(rejections, list):
        return
    for rejection in rejections[:MAX_LOGGED_REJECTIONS]:
        if not isinstance(rejection, dict):
            continue
        logger.warning(
            "Network measurement %s rejected: %s",
            _safe_text(rejection.get("measurement_id")),
            _safe_text(rejection.get("reason")),
        )
    if len(rejections) > MAX_LOGGED_REJECTIONS:
        logger.warning(
            "%d more network measurement rejection(s) not shown",
            len(rejections) - MAX_LOGGED_REJECTIONS,
        )


def _safe_text(value: Any) -> str:
    if value is None:
        return "-"
    text = "".join(char if char.isprintable() else " " for char in str(value))
    if len(text) > MAX_LOGGED_TEXT_LENGTH:
        text = text[:MAX_LOGGED_TEXT_LENGTH] + "..."
    return text

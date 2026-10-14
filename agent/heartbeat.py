"""Heartbeat command logic."""

from __future__ import annotations

import functools
import json
import logging
from collections.abc import Callable
from typing import Any

from agent.config import Config, uses_insecure_http
from agent.docker_discovery import collect_docker
from agent.errors import HeartbeatError, RequestTooLargeError
from agent.http_client import MAX_REQUEST_BYTES, encoded_size, post_json, size_with_member
from agent.network_delivery import DeliveryBatch, NetworkDelivery
from agent.snmp_delivery import SnmpBatch, SnmpDelivery, request_size_with_empty_section
from agent.telemetry import collect_telemetry

logger = logging.getLogger("sentinel_agent")

SUBSYSTEM_DETAIL_KEYS = {
    "telemetry": "detail",
    "docker": "docker_detail",
    "network": "network_detail",
    "snmp": "snmp_detail",
}
MAX_LOGGED_TEXT_LENGTH = 200
MAX_LOGGED_REJECTIONS = 5


def build_heartbeat_payload(
    *,
    collect_fn: Callable[[], dict[str, Any]] | None = None,
    docker_fn: Callable[[], dict[str, Any]] | None = None,
    network_fn: Callable[[], dict[str, Any]] | None = None,
    snmp_fn: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the JSON body for a heartbeat request.

    Telemetry, Docker, network and SNMP collectors are independent. Failures
    in one are logged locally; other subsystems and liveness still proceed.
    Without ``network_fn`` (``snmp_fn``) the heartbeat carries no network
    (SNMP) section: they are only ever sent from the persistent queue (see
    ``NetworkDelivery`` and ``SnmpDelivery``).
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

    if snmp_fn is not None:
        try:
            snmp_payload = snmp_fn()
            if snmp_payload.get("polls"):
                payload["snmp"] = snmp_payload
        except Exception as exc:  # noqa: BLE001
            logger.warning("SNMP collection failed: %s", exc)

    return payload


def send_heartbeat(
    config: Config,
    *,
    timeout: float | None = None,
    collect_fn: Callable[[], dict[str, Any]] | None = None,
    docker_fn: Callable[[], dict[str, Any]] | None = None,
    network_fn: Callable[[], dict[str, Any]] | None = None,
    network_delivery: NetworkDelivery | None = None,
    snmp_delivery: SnmpDelivery | None = None,
) -> None:
    """POST a heartbeat (with optional telemetry/Docker/network/SNMP) to Sentinel.

    With ``network_delivery``, the network section is a batch from the
    persistent queue (``network_fn`` is ignored) and queued measurements are
    removed only according to the server's explicit acknowledgement.
    ``snmp_delivery`` does the same for the ``snmp`` section.

    Size. No request is ever larger than ``MAX_REQUEST_BYTES``, in the bytes
    that are sent, and none is sent that would be. The telemetry and the Docker
    report (live snapshots, which are never cut down) make the first request.
    What is queued, the network batch and then the SNMP polls, joins it while
    it fits and otherwise goes in a request of its own, right after the first
    has been accepted: nothing is dropped to make room for something else, and
    whatever fits a request alone is sent in every heartbeat. The requests of
    their own do not depend on each other: if one fails (its batch keeps its
    queue and its own backoff) the others are still attempted, and the first
    failure is raised at the end. A request of its own carries only its section (the server applies a section only when the
    request has it) and the liveness every heartbeat carries.

    Only what fits a request even alone can be sent. A Docker report that does
    not (with the telemetry) is left out of the heartbeat, in the log as an
    error: the rest goes on. A telemetry or network section that does not fit
    fails the heartbeat before anything is sent (``RequestTooLargeError``), and
    nothing queued is touched.
    """
    if uses_insecure_http(config):
        _warn_insecure_http(config.sentinel_url)

    batch = DeliveryBatch()
    if network_delivery is not None:
        batch = network_delivery.prepare_batch()
        network_fn = batch.section

    payload = build_heartbeat_payload(
        collect_fn=collect_fn,
        docker_fn=docker_fn,
        network_fn=network_fn,
    )
    network = payload.pop("network", None)
    main, size = _fit_snapshots(payload)

    network_alone = False
    if network is not None:
        network_size = encoded_size(network)
        joined = size_with_member(size, bool(main), "network", network_size)
        if joined <= MAX_REQUEST_BYTES:
            main["network"] = network
            size = joined
        else:
            _require_to_fit_alone("network", network_size)
            network_alone = True
            logger.warning(
                "The network measurements (%d bytes) do not fit next to the telemetry and the Docker "
                "report (%d bytes) in a request of at most %d bytes: they are sent in a request of their own",
                network_size,
                size,
                MAX_REQUEST_BYTES,
            )

    snmp_batch = SnmpBatch()
    if snmp_delivery is not None:
        snmp_batch = snmp_delivery.prepare_batch(request_size_with_empty_section(size, bool(main)))
        if snmp_batch.polls:
            main["snmp"] = snmp_batch.section()

    _exchange(
        config,
        main,
        timeout=timeout,
        network_delivery=network_delivery,
        network_batch=DeliveryBatch() if network_alone else batch,
        snmp_delivery=snmp_delivery,
        snmp_batch=snmp_batch,
    )

    # The requests of their own are independent: each one keeps its own queue and its own backoff,
    # so one that fails must not stop the others. All are attempted, then the first failure is raised.
    failures: list[Exception] = []
    if network_alone:
        _attempt(
            failures,
            config,
            {"network": network},
            timeout=timeout,
            network_delivery=network_delivery,
            network_batch=batch,
            snmp_delivery=None,
            snmp_batch=SnmpBatch(),
        )

    if snmp_delivery is not None and snmp_batch.deferred:
        alone = snmp_delivery.prepare_batch()
        if alone.polls:
            logger.info(
                "The SNMP polls do not fit next to the other sections of the heartbeat (%d bytes of "
                "at most %d): %d of them are sent in a request of their own",
                size,
                MAX_REQUEST_BYTES,
                len(alone.polls),
            )
            _attempt(
                failures,
                config,
                {"snmp": alone.section()},
                timeout=timeout,
                network_delivery=None,
                network_batch=DeliveryBatch(),
                snmp_delivery=snmp_delivery,
                snmp_batch=alone,
            )

    if failures:
        for other in failures[1:]:
            logger.warning("Another request of this heartbeat failed too: %s", other)
        raise failures[0]


def _attempt(failures: list[Exception], *args: Any, **kwargs: Any) -> None:
    """``_exchange`` for a request that does not stop the ones after it: a failure is kept, not raised."""
    try:
        _exchange(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - raised by send_heartbeat once every request was tried
        failures.append(exc)


def _fit_snapshots(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """The telemetry and the Docker report as the first request, and its exact size.

    Within the limit they are sent as they are. Otherwise the Docker report is the only part
    that can be at fault (telemetry is a few hundred bytes): if the request fits without it, the
    report is left out, whole, because a snapshot cut down would mark the containers it no
    longer lists as absent. If it does not fit without it either, nothing can be sent.
    """
    size = encoded_size(payload)
    if size <= MAX_REQUEST_BYTES:
        return payload, size

    if "docker" in payload:
        without = {key: value for key, value in payload.items() if key != "docker"}
        without_size = encoded_size(without)
        if without_size <= MAX_REQUEST_BYTES:
            logger.error(
                "The Docker report cannot be sent: with the telemetry it makes a heartbeat of %d bytes, "
                "over the limit of %d bytes, and a report is never cut down. It is left out of this "
                "heartbeat, so the console shows this host's containers as unknown until it fits again "
                "(fewer containers, shorter names)",
                size,
                MAX_REQUEST_BYTES,
            )
            return without, without_size

    sections = ", ".join(f"{name}={encoded_size(value)}" for name, value in payload.items())
    raise RequestTooLargeError(
        f"the heartbeat is {size} bytes ({sections}), over the limit of {MAX_REQUEST_BYTES} bytes "
        "even without the Docker report; nothing was sent"
    )


def _require_to_fit_alone(name: str, section_size: int) -> None:
    alone = size_with_member(2, False, name, section_size)
    if alone > MAX_REQUEST_BYTES:
        raise RequestTooLargeError(
            f"the {name} section is {section_size} bytes, so a request of its own would be {alone} bytes, "
            f"over the limit of {MAX_REQUEST_BYTES} bytes; nothing was sent"
        )


def _exchange(
    config: Config,
    payload: dict[str, Any],
    *,
    timeout: float | None,
    network_delivery: NetworkDelivery | None,
    network_batch: DeliveryBatch,
    snmp_delivery: SnmpDelivery | None,
    snmp_batch: SnmpBatch,
) -> None:
    """POST one request and apply the response to the batches it carried."""
    headers = {"Authorization": f"Bearer {config.agent_token}"}
    kwargs: dict[str, Any] = {"payload": payload}
    if timeout is not None:
        kwargs["timeout"] = timeout

    try:
        # Token is only passed via the Authorization header, never the URL.
        response = post_json(config.heartbeat_url, headers=headers, **kwargs)
    except RequestTooLargeError:
        # Nothing went out: no failure of the server or the network, and no batch is touched.
        raise
    except Exception:
        if network_delivery is not None:
            network_delivery.record_failure(network_batch, "request failed")
        if snmp_delivery is not None:
            snmp_delivery.record_failure(snmp_batch, "request failed")
        raise

    if 200 <= response.status < 300:
        logger.debug("Heartbeat accepted by Sentinel")
        log_subsystem_status(response.body)
        if network_delivery is not None:
            network_delivery.acknowledge(network_batch, response.body)
        if snmp_delivery is not None:
            snmp_delivery.acknowledge(snmp_batch, response.body)
        return

    failure = _http_failure(response.status, payload)
    if network_delivery is not None:
        network_delivery.record_failure(network_batch, failure)
    if snmp_delivery is not None:
        snmp_delivery.record_failure(snmp_batch, failure)
    if 300 <= response.status < 400:
        raise HeartbeatError(
            f"server returned HTTP {response.status} redirect; redirects are not "
            "followed, set SENTINEL_URL to the final https:// address"
        )
    raise HeartbeatError(f"server returned {failure}")


def _http_failure(status: int, payload: dict[str, Any]) -> str:
    """``HTTP <status>``, with the size of the request for the statuses that refuse one for its size."""
    if status in (400, 413):
        return f"HTTP {status} (request body {encoded_size(payload)} bytes)"
    return f"HTTP {status}"


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
        elif subsystem == "snmp":
            _log_snmp_status(status, data)
        elif status == "accepted":
            logger.debug("Sentinel accepted %s", subsystem)
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
        logger.debug("Sentinel accepted network measurements (accepted=%s)", accepted)
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


def _log_snmp_status(status: str, data: dict[str, Any]) -> None:
    accepted = data.get("snmp_accepted")
    rejected = data.get("snmp_rejected")
    if status == "accepted":
        logger.debug("Sentinel accepted SNMP polls (accepted=%s)", accepted)
        return

    logger.warning(
        "Sentinel %s SNMP polls (accepted=%s, rejected=%s): %s",
        _safe_text(status),
        accepted if isinstance(accepted, int) else "unknown",
        rejected if isinstance(rejected, int) else "unknown",
        _safe_text(data.get("snmp_detail")),
    )
    rejections = data.get("snmp_rejections")
    if not isinstance(rejections, list):
        return
    for rejection in rejections[:MAX_LOGGED_REJECTIONS]:
        if not isinstance(rejection, dict):
            continue
        logger.warning(
            "SNMP poll %s rejected: %s",
            _safe_text(rejection.get("poll_id")),
            _safe_text(rejection.get("reason")),
        )
    if len(rejections) > MAX_LOGGED_REJECTIONS:
        logger.warning(
            "%d more SNMP poll rejection(s) not shown",
            len(rejections) - MAX_LOGGED_REJECTIONS,
        )


def _safe_text(value: Any) -> str:
    if value is None:
        return "-"
    text = "".join(char if char.isprintable() else " " for char in str(value))
    if len(text) > MAX_LOGGED_TEXT_LENGTH:
        text = text[:MAX_LOGGED_TEXT_LENGTH] + "..."
    return text

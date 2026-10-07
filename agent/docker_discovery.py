"""Optional Docker Engine discovery (read-only).

Uses the official Docker SDK. Never crashes the agent: always returns a
versioned status payload. Does not collect env vars, mounts, labels, commands,
or logs.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("sentinel_agent")

DOCKER_PAYLOAD_VERSION = 1

STATUS_AVAILABLE = "available"
STATUS_UNAVAILABLE = "unavailable"
STATUS_PERMISSION_DENIED = "permission_denied"
STATUS_ERROR = "error"

ALLOWED_STATES = frozenset(
    {
        "running",
        "exited",
        "paused",
        "restarting",
        "created",
        "dead",
        "unknown",
    }
)
ALLOWED_HEALTH = frozenset(
    {
        "healthy",
        "unhealthy",
        "starting",
        "none",
        "unknown",
    }
)


def collect_docker() -> dict[str, Any]:
    """Discover containers when Docker is reachable; never raise to callers."""
    collected_at = datetime.now(timezone.utc).isoformat()
    try:
        import docker  # type: ignore[import-untyped]
        from docker.errors import APIError, DockerException
    except ImportError:
        return _status_payload(
            available=False,
            status=STATUS_UNAVAILABLE,
            collected_at=collected_at,
            containers=[],
        )

    client = None
    try:
        client = docker.from_env(timeout=2)
        client.ping()
        containers = [
            _serialize_container(container)
            for container in client.containers.list(all=True)
        ]
        return _status_payload(
            available=True,
            status=STATUS_AVAILABLE,
            collected_at=collected_at,
            containers=containers,
        )
    except Exception as exc:  # noqa: BLE001 - classify and continue
        status = _classify_docker_error(exc)
        logger.warning("Docker discovery unavailable (%s)", status)
        return _status_payload(
            available=False,
            status=status,
            collected_at=collected_at,
            containers=[],
        )
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass


def normalize_state(raw: str | None) -> str:
    if not raw:
        return "unknown"
    value = raw.strip().lower()
    if value in ALLOWED_STATES:
        return value
    if value == "removing":
        return "unknown"
    return "unknown"


def normalize_health(raw: str | None, *, has_healthcheck: bool) -> str:
    if not has_healthcheck:
        return "none"
    if not raw:
        return "unknown"
    value = raw.strip().lower()
    if value in ALLOWED_HEALTH:
        return value
    return "unknown"


def _status_payload(
    *,
    available: bool,
    status: str,
    collected_at: str,
    containers: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "version": DOCKER_PAYLOAD_VERSION,
        "available": available,
        "status": status,
        "collected_at": collected_at,
        "containers": containers,
    }


def _classify_docker_error(exc: BaseException) -> str:
    # Import locally so tests can exercise classification without docker installed
    # in constrained environments; message-based matching remains the fallback.
    msg = str(exc).lower()
    if isinstance(exc, PermissionError) or "permission denied" in msg:
        return STATUS_PERMISSION_DENIED
    if isinstance(
        exc,
        (FileNotFoundError, ConnectionError, ConnectionRefusedError, TimeoutError),
    ):
        return STATUS_UNAVAILABLE
    unavailable_markers = (
        "no such file",
        "cannot connect",
        "connection refused",
        "connection aborted",
        "error while fetching server api version",
        "docker desktop is not running",
        "is the docker daemon running",
    )
    if any(marker in msg for marker in unavailable_markers):
        return STATUS_UNAVAILABLE
    if "access denied" in msg or "permission" in msg:
        return STATUS_PERMISSION_DENIED
    return STATUS_ERROR


def _serialize_container(container: Any) -> dict[str, Any]:
    attrs = getattr(container, "attrs", None) or {}
    state = attrs.get("State") or {}
    config = attrs.get("Config") or {}

    container_id = str(attrs.get("Id") or getattr(container, "id", "") or "")
    name = _container_name(attrs, container)
    image = str(
        config.get("Image")
        or attrs.get("Image")
        or getattr(container, "image", "")
        or ""
    )
    # Prefer tags from image object when attrs only has a digest id.
    try:
        tags = getattr(getattr(container, "image", None), "tags", None) or []
        if tags and (not image or image.startswith("sha256:")):
            image = tags[0]
    except Exception:  # noqa: BLE001 - image inspect can fail; keep attrs image
        pass

    health_block = state.get("Health")
    has_healthcheck = bool(health_block) or bool(config.get("Healthcheck"))
    health_status = None
    if isinstance(health_block, dict):
        health_status = health_block.get("Status")

    created_at = _docker_timestamp(attrs.get("Created"))
    started_raw = state.get("StartedAt")
    started_at = _docker_timestamp(started_raw)

    return {
        "container_id": container_id,
        "name": name,
        "image": image,
        "state": normalize_state(state.get("Status") or getattr(container, "status", None)),
        "health": normalize_health(health_status, has_healthcheck=has_healthcheck),
        "created_at": created_at,
        "started_at": started_at,
    }


def _container_name(attrs: dict[str, Any], container: Any) -> str:
    name = attrs.get("Name") or getattr(container, "name", "") or ""
    name = str(name)
    if name.startswith("/"):
        name = name[1:]
    return name


def _docker_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.startswith("0001-01-01"):
        return None
    # Docker may include nanoseconds; trim to microseconds for fromisoformat.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if "." in text:
        head, rest = text.split(".", 1)
        frac = ""
        tz = ""
        for index, char in enumerate(rest):
            if char.isdigit():
                frac += char
            else:
                tz = rest[index:]
                break
        frac = (frac + "000000")[:6]
        text = f"{head}.{frac}{tz}"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()

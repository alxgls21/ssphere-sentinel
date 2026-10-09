"""Validate and apply Docker discovery reports from agents."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.infrastructure.models import DockerContainer, DockerHostState, Server

SUPPORTED_DOCKER_VERSION = 1
MAX_CONTAINERS_PER_REPORT = 1000
MAX_CONTAINER_ID_LENGTH = 64
MAX_NAME_LENGTH = 255
MAX_IMAGE_LENGTH = 512
MAX_FUTURE_SKEW = timedelta(minutes=5)

ALLOWED_HOST_STATUSES = frozenset(DockerHostState.Status.values)
ALLOWED_STATES = frozenset(DockerContainer.State.values)
ALLOWED_HEALTH = frozenset(DockerContainer.Health.values)


class DockerValidationError(Exception):
    """Raised when a Docker payload is invalid."""


@dataclass(frozen=True)
class ValidatedDockerContainer:
    container_id: str
    name: str
    image: str
    state: str
    health: str
    created_at: datetime | None
    started_at: datetime | None


@dataclass(frozen=True)
class ValidatedDockerReport:
    available: bool
    status: str
    collected_at: datetime
    containers: tuple[ValidatedDockerContainer, ...]
    authoritative: bool


def validate_docker_payload(raw: Any) -> ValidatedDockerReport:
    if not isinstance(raw, dict):
        raise DockerValidationError("docker must be an object")

    version = raw.get("version")
    if version != SUPPORTED_DOCKER_VERSION:
        raise DockerValidationError(
            f"unsupported docker version (expected {SUPPORTED_DOCKER_VERSION})"
        )

    available = raw.get("available")
    if not isinstance(available, bool):
        raise DockerValidationError("available must be a boolean")

    status = raw.get("status")
    if not isinstance(status, str) or status not in ALLOWED_HOST_STATUSES:
        raise DockerValidationError("status is invalid")

    if available and status != DockerHostState.Status.AVAILABLE:
        raise DockerValidationError(
            "available=true requires status=available"
        )
    if not available and status == DockerHostState.Status.AVAILABLE:
        raise DockerValidationError(
            "available=false cannot use status=available"
        )

    collected_at = _parse_timestamp(raw.get("collected_at"), field="collected_at")
    containers_raw = raw.get("containers")
    if not isinstance(containers_raw, list):
        raise DockerValidationError("containers must be a list")
    if len(containers_raw) > MAX_CONTAINERS_PER_REPORT:
        raise DockerValidationError(
            f"containers exceeds maximum of {MAX_CONTAINERS_PER_REPORT}"
        )

    if not available and containers_raw:
        raise DockerValidationError(
            "containers must be empty when Docker is unavailable"
        )

    seen_ids: set[str] = set()
    containers: list[ValidatedDockerContainer] = []
    for item in containers_raw:
        container = _validate_container(item)
        if container.container_id in seen_ids:
            raise DockerValidationError(
                f"duplicate container_id: {container.container_id}"
            )
        seen_ids.add(container.container_id)
        containers.append(container)

    authoritative = available and status == DockerHostState.Status.AVAILABLE
    return ValidatedDockerReport(
        available=available,
        status=status,
        collected_at=collected_at,
        containers=tuple(containers),
        authoritative=authoritative,
    )


@transaction.atomic
def apply_docker_report(
    server: Server,
    report: ValidatedDockerReport,
    *,
    received_at: datetime | None = None,
) -> None:
    """Persist host state; sync containers only for authoritative discoveries."""
    received = received_at if received_at is not None else timezone.now()

    DockerHostState.objects.update_or_create(
        server=server,
        defaults={
            "available": report.available,
            "status": report.status,
            "collected_at": report.collected_at,
            "received_at": received,
        },
    )

    if not report.authoritative:
        # Non-authoritative reports must not mark containers absent.
        return

    seen_ids: list[str] = []
    for item in report.containers:
        seen_ids.append(item.container_id)
        DockerContainer.objects.update_or_create(
            server=server,
            container_id=item.container_id,
            defaults={
                "name": item.name,
                "image": item.image,
                "state": item.state,
                "health": item.health,
                "container_created_at": item.created_at,
                "started_at": item.started_at,
                "present": True,
                "last_seen_at": received,
                "received_at": received,
            },
        )

    missing = DockerContainer.objects.filter(server=server, present=True)
    if seen_ids:
        missing = missing.exclude(container_id__in=seen_ids)
    missing.update(present=False, received_at=received)


def _validate_container(raw: Any) -> ValidatedDockerContainer:
    if not isinstance(raw, dict):
        raise DockerValidationError("each container must be an object")

    container_id = raw.get("container_id")
    if not isinstance(container_id, str) or not container_id.strip():
        raise DockerValidationError("container_id is required")
    container_id = container_id.strip()
    if len(container_id) > MAX_CONTAINER_ID_LENGTH:
        raise DockerValidationError("container_id is too long")
    if not all(char.isalnum() or char in "-_" for char in container_id):
        raise DockerValidationError("container_id contains invalid characters")

    name = _require_string(raw, "name", max_length=MAX_NAME_LENGTH)
    image = _require_string(raw, "image", max_length=MAX_IMAGE_LENGTH)

    state = raw.get("state")
    if not isinstance(state, str) or state not in ALLOWED_STATES:
        raise DockerValidationError("state is invalid")

    health = raw.get("health")
    if not isinstance(health, str) or health not in ALLOWED_HEALTH:
        raise DockerValidationError("health is invalid")

    created_at = _parse_optional_timestamp(raw.get("created_at"), field="created_at")
    started_at = _parse_optional_timestamp(raw.get("started_at"), field="started_at")

    return ValidatedDockerContainer(
        container_id=container_id,
        name=name,
        image=image,
        state=state,
        health=health,
        created_at=created_at,
        started_at=started_at,
    )


def _require_string(raw: dict[str, Any], field: str, *, max_length: int) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise DockerValidationError(f"{field} is required")
    value = value.strip()
    if len(value) > max_length:
        raise DockerValidationError(f"{field} is too long")
    return value


def _parse_timestamp(value: Any, *, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise DockerValidationError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = parse_datetime(value.strip())
    except ValueError:
        parsed = None
    if parsed is None:
        raise DockerValidationError(f"{field} must be an ISO-8601 timestamp")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, dt_timezone.utc)
    if parsed > timezone.now() + MAX_FUTURE_SKEW:
        raise DockerValidationError(f"{field} is too far in the future")
    return parsed


def _parse_optional_timestamp(value: Any, *, field: str) -> datetime | None:
    if value is None or value == "":
        return None
    return _parse_timestamp(value, field=field)

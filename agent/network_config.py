"""Load agent-local network monitoring targets.

Targets are configured on the agent host (not pushed remotely in v0.1).
Each target ``id`` must match a server-side NetworkTarget UUID assigned to
this agent.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.errors import ConfigError

ENV_NETWORK_TARGETS_FILE = "SENTINEL_NETWORK_TARGETS_FILE"
MAX_TARGETS = 50
MAX_PROBE_COUNT = 20
MIN_INTERVAL_SECONDS = 10
MAX_INTERVAL_SECONDS = 86400
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 30

# Hostnames: labels of alphanumerics/hyphen, no underscores/spaces/shell chars.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$"
)


@dataclass(frozen=True)
class NetworkTargetConfig:
    id: UUID
    name: str
    hostname_or_ip: str
    protocol: str
    port: int | None
    enabled: bool
    monitoring_interval_seconds: int
    timeout_seconds: int
    probe_count: int


def load_network_targets(
    environ: dict[str, str] | None = None,
) -> list[NetworkTargetConfig]:
    """Load targets from SENTINEL_NETWORK_TARGETS_FILE if set; else empty list."""
    env = environ if environ is not None else os.environ
    path_raw = (env.get(ENV_NETWORK_TARGETS_FILE) or "").strip()
    if not path_raw:
        return []

    path = Path(path_raw).expanduser()
    if not path.is_file():
        raise ConfigError(
            f"{ENV_NETWORK_TARGETS_FILE} does not point to a readable file: {path}"
        )

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"{ENV_NETWORK_TARGETS_FILE} is not valid JSON: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise ConfigError("network targets file must be a JSON object")

    targets_raw = data.get("targets")
    if not isinstance(targets_raw, list):
        raise ConfigError("network targets file must contain a 'targets' list")
    if len(targets_raw) > MAX_TARGETS:
        raise ConfigError(f"network targets exceed maximum of {MAX_TARGETS}")

    targets = [_parse_target(item, index=index) for index, item in enumerate(targets_raw)]
    ids = [target.id for target in targets]
    if len(ids) != len(set(ids)):
        raise ConfigError("network targets contain duplicate ids")
    return targets


def validate_hostname_or_ip(value: str) -> str:
    """Return a sanitized host/IP or raise ConfigError."""
    host = value.strip()
    if not host or len(host) > 255:
        raise ConfigError("hostname_or_ip is invalid")
    if any(char.isspace() for char in host):
        raise ConfigError("hostname_or_ip must not contain whitespace")
    # Reject shell / path metacharacters even though we never use shell=True.
    if re.search(r"[;&|`$<>\\\"'\\]", host):
        raise ConfigError("hostname_or_ip contains forbidden characters")
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    if not _HOSTNAME_RE.match(host):
        raise ConfigError("hostname_or_ip is not a valid hostname or IP")
    return host


def _parse_target(raw: Any, *, index: int) -> NetworkTargetConfig:
    if not isinstance(raw, dict):
        raise ConfigError(f"targets[{index}] must be an object")

    try:
        target_id = UUID(str(raw.get("id", "")).strip())
    except ValueError as exc:
        raise ConfigError(f"targets[{index}].id must be a UUID") from exc

    name = str(raw.get("name", "")).strip()
    if not name or len(name) > 255:
        raise ConfigError(f"targets[{index}].name is invalid")

    host = validate_hostname_or_ip(str(raw.get("hostname_or_ip", "")))

    protocol = str(raw.get("protocol", "")).strip().lower()
    if protocol not in {"icmp", "tcp"}:
        raise ConfigError(f"targets[{index}].protocol must be icmp or tcp")

    port_raw = raw.get("port")
    if protocol == "tcp":
        if not isinstance(port_raw, int) or isinstance(port_raw, bool):
            raise ConfigError(f"targets[{index}].port is required for TCP")
        if port_raw < 1 or port_raw > 65535:
            raise ConfigError(f"targets[{index}].port out of range")
        port = port_raw
    else:
        if port_raw not in (None, ""):
            raise ConfigError(f"targets[{index}].port must be null for ICMP")
        port = None

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ConfigError(f"targets[{index}].enabled must be a boolean")

    interval = _require_int(
        raw,
        "monitoring_interval_seconds",
        index=index,
        default=60,
        minimum=MIN_INTERVAL_SECONDS,
        maximum=MAX_INTERVAL_SECONDS,
    )
    timeout = _require_int(
        raw,
        "timeout_seconds",
        index=index,
        default=2,
        minimum=MIN_TIMEOUT_SECONDS,
        maximum=MAX_TIMEOUT_SECONDS,
    )
    probe_count = _require_int(
        raw,
        "probe_count",
        index=index,
        default=4,
        minimum=1,
        maximum=MAX_PROBE_COUNT,
    )

    return NetworkTargetConfig(
        id=target_id,
        name=name,
        hostname_or_ip=host,
        protocol=protocol,
        port=port,
        enabled=enabled,
        monitoring_interval_seconds=interval,
        timeout_seconds=timeout,
        probe_count=probe_count,
    )


def _require_int(
    raw: dict[str, Any],
    field: str,
    *,
    index: int,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    if field not in raw or raw[field] is None:
        return default
    value = raw[field]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"targets[{index}].{field} must be an integer")
    if value < minimum or value > maximum:
        raise ConfigError(
            f"targets[{index}].{field} must be between {minimum} and {maximum}"
        )
    return value

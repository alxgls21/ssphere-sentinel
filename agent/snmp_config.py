"""Load the agent-local SNMP configuration: devices and credential profiles.

Two files, both on the agent host and nowhere else:

* **Devices file** (``SENTINEL_SNMP_DEVICES_FILE``): which devices to poll,
  where, how often, and under which *profile name*. Each ``id`` must match a
  device UUID in Sentinel that is assigned to this agent. No secrets.
* **Credentials file** (``SENTINEL_SNMP_CREDENTIALS_FILE``): the profiles that
  hold the community strings and SNMPv3 keys. It must be a regular file,
  not a symlink, owned by the agent's user or root, and not accessible to
  other users. Sentinel stores only the profile *name*; the secrets are read
  here, handed to the SNMP library, and never queued, logged or sent.

SNMPv1, MD5 authentication and DES privacy are refused by design.

Everything is validated strictly (unknown keys are errors) so that a typo such
as ``priv_pasword`` can never silently downgrade a device to weaker security.
"""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

from agent.errors import ConfigError
from agent.network_config import validate_hostname_or_ip

ENV_SNMP_DEVICES_FILE = "SENTINEL_SNMP_DEVICES_FILE"
ENV_SNMP_CREDENTIALS_FILE = "SENTINEL_SNMP_CREDENTIALS_FILE"

MAX_DEVICES = 200
MAX_FILE_BYTES = 1_000_000

# The same bounds the server enforces on a device's SNMP configuration.
MIN_POLL_INTERVAL_SECONDS = 30
MAX_POLL_INTERVAL_SECONDS = 86_400
DEFAULT_POLL_INTERVAL_SECONDS = 300
MIN_TIMEOUT_SECONDS = 1
MAX_TIMEOUT_SECONDS = 60
DEFAULT_TIMEOUT_SECONDS = 5
MAX_RETRIES = 5
DEFAULT_RETRIES = 1
DEFAULT_PORT = 161

MIN_DISCOVERY_INTERVAL_SECONDS = 300
MAX_DISCOVERY_INTERVAL_SECONDS = 7 * 86_400
DEFAULT_DISCOVERY_INTERVAL_SECONDS = 6 * 3600
DEFAULT_MAX_INTERFACES = 256
MAX_INTERFACES_LIMIT = 512  # the server accepts at most this many per poll
MAX_PATTERNS = 64
MAX_PATTERN_LENGTH = 128

MIN_PASSPHRASE_LENGTH = 8  # RFC 3414
MAX_SECRET_LENGTH = 256
MAX_USERNAME_LENGTH = 32  # SnmpAdminString
MAX_CONTEXT_LENGTH = 64

_PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

VERSION_2C = "2c"
VERSION_3 = "3"

AUTH_PROTOCOLS = {
    "SHA": "SHA",
    "SHA1": "SHA",
    "SHA224": "SHA-224",
    "SHA256": "SHA-256",
    "SHA384": "SHA-384",
    "SHA512": "SHA-512",
}
PRIV_PROTOCOLS = {
    "AES": "AES-128",
    "AES128": "AES-128",
    "AES192": "AES-192",
    "AES256": "AES-256",
}
_REFUSED_PROTOCOLS = {
    "MD5": "MD5 authentication",
    "DES": "DES privacy",
    "3DES": "3DES privacy",
    "DES3": "3DES privacy",
}
# Protocols that pre-date SHA-2: allowed for old gear, but worth a warning.
WEAK_AUTH_PROTOCOLS = frozenset({"SHA"})


@dataclass(frozen=True)
class SnmpCredential:
    """One credential profile. Secret fields never appear in ``repr``."""

    name: str
    version: str
    community: str = field(default="", repr=False)
    username: str = ""
    auth_protocol: str = ""
    auth_password: str = field(default="", repr=False)
    priv_protocol: str = ""
    priv_password: str = field(default="", repr=False)
    context_name: str = ""

    @property
    def security_level(self) -> str:
        if self.version == VERSION_2C:
            return "community"
        return "authPriv" if self.priv_protocol else "authNoPriv"

    def secrets(self) -> tuple[str, ...]:
        """Every secret value, for redacting text that might contain one."""
        return tuple(
            value
            for value in (self.community, self.auth_password, self.priv_password)
            if value
        )


@dataclass(frozen=True)
class InterfaceSelection:
    """Which interfaces of a device are monitored (counters and history)."""

    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    max_interfaces: int = DEFAULT_MAX_INTERFACES


@dataclass(frozen=True)
class SnmpDeviceConfig:
    id: UUID
    name: str
    address: str
    credential_profile: str
    port: int = DEFAULT_PORT
    enabled: bool = True
    poll_interval_seconds: int = DEFAULT_POLL_INTERVAL_SECONDS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    retries: int = DEFAULT_RETRIES
    discovery_interval_seconds: int = DEFAULT_DISCOVERY_INTERVAL_SECONDS
    interfaces: InterfaceSelection = field(default_factory=InterfaceSelection)


@dataclass(frozen=True)
class SnmpConfig:
    devices: tuple[SnmpDeviceConfig, ...]
    credentials: dict[str, SnmpCredential] = field(repr=False, default_factory=dict)

    @property
    def enabled_devices(self) -> tuple[SnmpDeviceConfig, ...]:
        return tuple(device for device in self.devices if device.enabled)


def load_snmp_config(environ: dict[str, str] | None = None) -> SnmpConfig | None:
    """Load devices and credentials, or return ``None`` when SNMP is not configured."""
    env = environ if environ is not None else os.environ
    devices_raw = (env.get(ENV_SNMP_DEVICES_FILE) or "").strip()
    if not devices_raw:
        return None
    credentials_raw = (env.get(ENV_SNMP_CREDENTIALS_FILE) or "").strip()
    if not credentials_raw:
        raise ConfigError(
            f"{ENV_SNMP_CREDENTIALS_FILE} is not set (it is required with {ENV_SNMP_DEVICES_FILE})"
        )

    credentials = load_credentials(Path(credentials_raw).expanduser())
    devices = load_devices(Path(devices_raw).expanduser())
    for index, device in enumerate(devices):
        if device.enabled and device.credential_profile not in credentials:
            raise ConfigError(
                f"devices[{index}].credential_profile {device.credential_profile!r} "
                f"is not defined in {ENV_SNMP_CREDENTIALS_FILE}"
            )
    return SnmpConfig(devices=tuple(devices), credentials=credentials)


# -- devices ----------------------------------------------------------------------


def load_devices(path: Path) -> list[SnmpDeviceConfig]:
    if not path.is_file():
        raise ConfigError(f"{ENV_SNMP_DEVICES_FILE} does not point to a readable file: {path}")
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ConfigError("SNMP devices file is too large")
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"SNMP devices file cannot be read: {exc.strerror}") from exc
    except ValueError as exc:
        raise ConfigError(f"SNMP devices file is not valid JSON: {_json_position(exc)}") from exc

    data = _require_object(data, "SNMP devices file", allowed={"devices"})
    items = data.get("devices")
    if not isinstance(items, list):
        raise ConfigError("SNMP devices file must contain a 'devices' list")
    if len(items) > MAX_DEVICES:
        raise ConfigError(f"SNMP devices exceed the maximum of {MAX_DEVICES}")
    devices = [_parse_device(item, index) for index, item in enumerate(items)]
    ids = [device.id for device in devices]
    if len(ids) != len(set(ids)):
        raise ConfigError("SNMP devices contain duplicate ids")
    return devices


_DEVICE_KEYS = {
    "id",
    "name",
    "address",
    "port",
    "credential_profile",
    "enabled",
    "poll_interval_seconds",
    "timeout_seconds",
    "retries",
    "discovery_interval_seconds",
    "interfaces",
}
_SELECTION_KEYS = {"include", "exclude", "max_interfaces"}


def _parse_device(raw: Any, index: int) -> SnmpDeviceConfig:
    where = f"devices[{index}]"
    raw = _require_object(raw, where, allowed=_DEVICE_KEYS)

    try:
        device_id = UUID(str(raw.get("id", "")).strip())
    except ValueError as exc:
        raise ConfigError(f"{where}.id must be a UUID") from exc

    name = str(raw.get("name", "")).strip()
    if not name or len(name) > 255 or _CONTROL_RE.search(name):
        raise ConfigError(f"{where}.name is invalid")

    try:
        address = validate_hostname_or_ip(str(raw.get("address", "")))
    except ConfigError as exc:
        raise ConfigError(f"{where}.address: {exc}") from exc

    profile = str(raw.get("credential_profile", "")).strip()
    if not _PROFILE_RE.fullmatch(profile):
        raise ConfigError(f"{where}.credential_profile is invalid")

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ConfigError(f"{where}.enabled must be a boolean")

    port = _int(raw, "port", where, DEFAULT_PORT, 1, 65535)
    interval = _int(
        raw,
        "poll_interval_seconds",
        where,
        DEFAULT_POLL_INTERVAL_SECONDS,
        MIN_POLL_INTERVAL_SECONDS,
        MAX_POLL_INTERVAL_SECONDS,
    )
    timeout = _int(
        raw, "timeout_seconds", where, DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS
    )
    retries = _int(raw, "retries", where, DEFAULT_RETRIES, 0, MAX_RETRIES)
    if timeout * (retries + 1) >= interval:
        raise ConfigError(
            f"{where}: timeout_seconds x (retries + 1) must be shorter than poll_interval_seconds"
        )
    discovery = _int(
        raw,
        "discovery_interval_seconds",
        where,
        DEFAULT_DISCOVERY_INTERVAL_SECONDS,
        MIN_DISCOVERY_INTERVAL_SECONDS,
        MAX_DISCOVERY_INTERVAL_SECONDS,
    )

    return SnmpDeviceConfig(
        id=device_id,
        name=name,
        address=address,
        credential_profile=profile,
        port=port,
        enabled=enabled,
        poll_interval_seconds=interval,
        timeout_seconds=timeout,
        retries=retries,
        discovery_interval_seconds=discovery,
        interfaces=_parse_selection(raw.get("interfaces"), f"{where}.interfaces"),
    )


def _parse_selection(raw: Any, where: str) -> InterfaceSelection:
    if raw is None:
        return InterfaceSelection()
    raw = _require_object(raw, where, allowed=_SELECTION_KEYS)
    return InterfaceSelection(
        include=_patterns(raw.get("include"), f"{where}.include"),
        exclude=_patterns(raw.get("exclude"), f"{where}.exclude"),
        max_interfaces=_int(
            raw, "max_interfaces", where, DEFAULT_MAX_INTERFACES, 1, MAX_INTERFACES_LIMIT
        ),
    )


def _patterns(raw: Any, where: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > MAX_PATTERNS:
        raise ConfigError(f"{where} must be a list of at most {MAX_PATTERNS} patterns")
    patterns = []
    for item in raw:
        if (
            not isinstance(item, str)
            or not item
            or len(item) > MAX_PATTERN_LENGTH
            or _CONTROL_RE.search(item)
        ):
            raise ConfigError(f"{where} contains an invalid pattern")
        patterns.append(item)
    return tuple(patterns)


# -- credentials ------------------------------------------------------------------

_PROFILE_KEYS = {
    "version",
    "community",
    "username",
    "auth_protocol",
    "auth_password",
    "priv_protocol",
    "priv_password",
    "context_name",
}


def load_credentials(path: Path) -> dict[str, SnmpCredential]:
    data = _read_secret_json(path)
    data = _require_object(data, "SNMP credentials file", allowed={"profiles"})
    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        raise ConfigError("SNMP credentials file must contain a 'profiles' object")
    credentials: dict[str, SnmpCredential] = {}
    for name, raw in profiles.items():
        if not isinstance(name, str) or not _PROFILE_RE.fullmatch(name):
            raise ConfigError("SNMP credentials contain an invalid profile name")
        credentials[name] = _parse_profile(name, raw)
    return credentials


def _parse_profile(name: str, raw: Any) -> SnmpCredential:
    where = f"profile {name!r}"
    raw = _require_object(raw, where, allowed=_PROFILE_KEYS)
    version = str(raw.get("version", "")).strip().lower().removeprefix("v")
    if version == "1":
        raise ConfigError(f"{where}: SNMPv1 is not supported; use 2c or 3")
    if version not in (VERSION_2C, VERSION_3):
        raise ConfigError(f"{where}: version must be '2c' or '3'")

    if version == VERSION_2C:
        for key in ("username", "auth_protocol", "auth_password", "priv_protocol", "priv_password", "context_name"):
            if key in raw:
                raise ConfigError(f"{where}: {key} applies to SNMPv3 only")
        community = _secret(raw, "community", where, minimum=1)
        return SnmpCredential(name=name, version=VERSION_2C, community=community)

    if "community" in raw:
        raise ConfigError(f"{where}: community applies to SNMPv2c only")
    username = str(raw.get("username", "")).strip()
    if not username or len(username) > MAX_USERNAME_LENGTH or _CONTROL_RE.search(username):
        raise ConfigError(f"{where}: username is required (at most {MAX_USERNAME_LENGTH} characters)")
    auth_protocol = _protocol(raw.get("auth_protocol"), AUTH_PROTOCOLS, "auth_protocol", where)
    if not auth_protocol:
        raise ConfigError(f"{where}: SNMPv3 requires authentication (auth_protocol and auth_password)")
    auth_password = _secret(raw, "auth_password", where, minimum=MIN_PASSPHRASE_LENGTH)

    priv_protocol = _protocol(raw.get("priv_protocol"), PRIV_PROTOCOLS, "priv_protocol", where)
    priv_password = ""
    if priv_protocol:
        priv_password = _secret(raw, "priv_password", where, minimum=MIN_PASSPHRASE_LENGTH)
    elif raw.get("priv_password"):
        raise ConfigError(f"{where}: priv_password is set without priv_protocol")

    context = str(raw.get("context_name", "")).strip()
    if len(context) > MAX_CONTEXT_LENGTH or _CONTROL_RE.search(context):
        raise ConfigError(f"{where}: context_name is invalid")
    return SnmpCredential(
        name=name,
        version=VERSION_3,
        username=username,
        auth_protocol=auth_protocol,
        auth_password=auth_password,
        priv_protocol=priv_protocol,
        priv_password=priv_password,
        context_name=context,
    )


def _protocol(value: Any, accepted: dict[str, str], key: str, where: str) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise ConfigError(f"{where}: {key} must be a string")
    normalized = re.sub(r"[\s_-]", "", value).upper()
    if normalized in _REFUSED_PROTOCOLS:
        raise ConfigError(f"{where}: {_REFUSED_PROTOCOLS[normalized]} is not supported (insecure)")
    if normalized not in accepted:
        choices = ", ".join(sorted(set(accepted.values())))
        raise ConfigError(f"{where}: {key} must be one of {choices}")
    return accepted[normalized]


def _secret(raw: dict[str, Any], key: str, where: str, *, minimum: int) -> str:
    value = raw.get(key)
    # Messages name the key and the rule, never the value.
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{where}: {key} is required")
    if len(value) < minimum:
        raise ConfigError(f"{where}: {key} must be at least {minimum} characters")
    if len(value) > MAX_SECRET_LENGTH or _CONTROL_RE.search(value):
        raise ConfigError(f"{where}: {key} is invalid")
    return value


def _read_secret_json(path: Path) -> Any:
    """Read a credentials file after checking it cannot be read or replaced by others."""
    # O_NONBLOCK: opening a FIFO planted at this path must not block forever
    # (it is refused as "not a regular file" below); it changes nothing for files.
    flags = (
        os.O_RDONLY
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    label = f"{ENV_SNMP_CREDENTIALS_FILE}"
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ConfigError(f"{label} cannot be opened: {exc.strerror}") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ConfigError(f"{label} must be a regular file")
        uid = os.getuid() if hasattr(os, "getuid") else None
        if uid is not None and info.st_uid not in (uid, 0):
            raise ConfigError(f"{label} must be owned by the agent's user or root")
        if info.st_mode & 0o007:
            raise ConfigError(f"{label} must not be accessible to other users (use mode 0600 or 0640)")
        if info.st_mode & 0o022:
            raise ConfigError(f"{label} must not be writable by group or others")
        if info.st_size > MAX_FILE_BYTES:
            raise ConfigError("SNMP credentials file is too large")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            content = handle.read(MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise ConfigError(f"{label} cannot be read: {exc.strerror}") from exc
    finally:
        os.close(fd)
    try:
        return json.loads(content.decode("utf-8"))
    except ValueError as exc:
        # Only the position is reported: the text near it may be a secret.
        raise ConfigError(f"SNMP credentials file is not valid JSON: {_json_position(exc)}") from exc


# -- helpers ----------------------------------------------------------------------


def _require_object(value: Any, where: str, *, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{where} must be an object")
    unknown = sorted(str(key) for key in value if key not in allowed)
    if unknown:
        raise ConfigError(f"{where} has unknown field(s): {', '.join(unknown)}")
    return value


def _int(raw: dict[str, Any], key: str, where: str, default: int, minimum: int, maximum: int) -> int:
    if key not in raw or raw[key] is None:
        return default
    value = raw[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{where}.{key} must be an integer")
    if value < minimum or value > maximum:
        raise ConfigError(f"{where}.{key} must be between {minimum} and {maximum}")
    return value


def _json_position(exc: ValueError) -> str:
    line = getattr(exc, "lineno", None)
    column = getattr(exc, "colno", None)
    if line is None:
        return "invalid content"
    return f"line {line}, column {column}"

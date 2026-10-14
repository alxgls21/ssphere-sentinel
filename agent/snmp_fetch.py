"""Read one device over SNMP.

This is the only module that talks to the SNMP library (pysnmp), and it
imports it lazily: an agent installed without the ``[snmp]`` extra can still
import every module and simply reports that SNMP is unavailable.

A fetch is one blocking call per poll. It runs in a worker thread of the
scheduler's bounded pool, creates a private event loop and SNMP engine for
that single poll, and closes both before returning, so nothing is shared
between devices and nothing accumulates. The poll has a hard deadline and can
be cancelled from another thread (agent shutdown).

What it requests is fixed (``snmp_oids``): ``sysUpTime`` and
``ifTableLastChange`` (plus the system group on a discovery poll), then
bulk walks of the IF-MIB columns the plan names. Counter values are returned
as read; deriving deltas is not its job (``snmp_collector``).
"""

from __future__ import annotations

import asyncio
import functools
import ipaddress
import logging
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from agent import snmp_oids as oids
from agent.errors import AgentError
from agent.snmp_config import (
    VERSION_2C,
    SnmpCredential,
    SnmpDeviceConfig,
)
from agent.snmp_payload import (
    ERROR_AUTH_FAILURE,
    ERROR_DNS_FAILURE,
    ERROR_PROTOCOL,
    ERROR_TIMEOUT,
    ERROR_UNKNOWN,
    ERROR_UNREACHABLE,
    ERROR_UNSUPPORTED,
)

logger = logging.getLogger("sentinel_agent")

# Rows requested per GETBULK. Devices return fewer when the response would
# not fit a packet; both are fine.
DEFAULT_MAX_REPETITIONS = 25
# A column with more rows than this is not an interface table we want to hold.
MAX_WALK_ROWS = 4096
# A poll must end within its interval and never run longer than this.
MAX_POLL_SECONDS = 120.0
CANCEL_CHECK_SECONDS = 0.25
MAX_IF_INDEX = 2**31 - 1  # the largest ifIndex the server accepts
MAX_MESSAGE_LENGTH = 200

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]+")
_EXCEPTION_VALUES = frozenset({"NoSuchObject", "NoSuchInstance", "EndOfMibView"})

# pysnmp error indications by class name. Anything not listed is "unknown".
_AUTH_ERRORS = frozenset(
    {
        "UnknownUserName",
        "WrongDigest",
        "UnsupportedSecurityLevel",
        "DecryptionError",
        "EncryptionError",
        "AuthenticationFailure",
        "AuthenticationError",
        "NoAuthentication",
        "NoEncryption",
        "UnknownSecurityName",
        "NotInTimeWindow",
        "UnknownCommunityName",
        "UnsupportedAuthProtocol",
        "UnsupportedPrivProtocol",
        "NoAccessEntry",
        "NoGroupName",
        "NoSuchView",
        "NotInView",
        "NoSuchContext",
    }
)
_PROTOCOL_ERRORS = frozenset(
    {
        "ParseError",
        "DeserializationError",
        "SerializationError",
        "EmptyResponse",
        "DataMismatch",
        "EngineIDMismatch",
        "UnknownEngineID",
        "TooBig",
        "OidNotIncreasing",
        "InvalidMsg",
        "ReportPduReceived",
        "UnknownPDUHandler",
        "UnsupportedPDUtype",
        "UnsupportedMsgProcessingModel",
        "LoopTerminated",
    }
)
_AUTH_STATUSES = frozenset({"authorizationError", "noAccess"})


class SnmpUnavailableError(AgentError):
    """The SNMP library (or its crypto backend) is not installed."""


class SnmpFetchError(AgentError):
    """A device could not be read; ``category`` is one the server accepts."""

    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category


class SnmpFetchCancelled(AgentError):
    """The fetch was cancelled because the agent is stopping."""


@dataclass(frozen=True)
class FetchPlan:
    """What a poll reads beyond the basics."""

    discover: bool = False  # also read the system group and interface names, types, aliases


@dataclass
class RawDeviceData:
    """Values as read, before any interpretation."""

    response_ms: float
    sys_uptime_ticks: int
    if_table_last_change: int | None = None
    system: dict[str, str] = field(default_factory=dict)  # name, descr, object_id
    columns: dict[str, dict[int, Any]] = field(default_factory=dict)  # column -> {ifIndex: value}
    # sysUpTime read again once the interface walks are done (None: that read failed, or a fetcher
    # that does not do it). The walks are not one atomic snapshot: this and ``sys_uptime_ticks`` bracket
    # the time they took. Last, so that the arguments that were positional before still are.
    sys_uptime_end_ticks: int | None = None


class Fetcher(Protocol):
    def fetch(
        self,
        device: SnmpDeviceConfig,
        credential: SnmpCredential,
        plan: FetchPlan,
        cancel: threading.Event | None = None,
    ) -> RawDeviceData: ...


# -- availability -----------------------------------------------------------------


def check_snmp_available(credentials: list[SnmpCredential]) -> None:
    """Raise ``SnmpUnavailableError`` unless the library can serve these profiles."""
    try:
        _load_api()
    except ImportError as exc:
        raise SnmpUnavailableError(
            "pysnmp is not installed; install the agent with the 'snmp' extra "
            "(pip install 'ssphere-sentinel-agent[snmp]')"
        ) from exc
    if any(credential.priv_protocol for credential in credentials):
        try:
            from cryptography.hazmat.decrepit.ciphers.modes import CFB  # noqa: F401
            from cryptography.hazmat.primitives.ciphers import algorithms  # noqa: F401
        except ImportError as exc:
            # pysnmp swallows this import error and then fails obscurely on the
            # first encrypted request, so say it here.
            raise SnmpUnavailableError(
                "SNMPv3 privacy (AES) needs the 'cryptography' package (version 43 or newer); "
                "install the agent with the 'snmp' extra"
            ) from exc


@functools.cache
def _load_api() -> Any:
    import pysnmp.hlapi.v3arch.asyncio as api

    return api


# -- the pysnmp fetcher -----------------------------------------------------------


class PysnmpFetcher:
    """``Fetcher`` backed by pysnmp (v2c and v3)."""

    def __init__(
        self,
        *,
        max_repetitions: int = DEFAULT_MAX_REPETITIONS,
        max_rows: int = MAX_WALK_ROWS,
        max_poll_seconds: float = MAX_POLL_SECONDS,
    ) -> None:
        self._max_repetitions = max_repetitions
        self._max_rows = max_rows
        self._max_poll_seconds = max_poll_seconds

    def fetch(
        self,
        device: SnmpDeviceConfig,
        credential: SnmpCredential,
        plan: FetchPlan,
        cancel: threading.Event | None = None,
    ) -> RawDeviceData:
        deadline = min(float(device.poll_interval_seconds), self._max_poll_seconds)
        started = time.monotonic()
        # Names are resolved here, with the deadline and cancellation honoured:
        # a resolver that hangs would otherwise outlive the poll, because the
        # event loop waits for its helper thread before it can close.
        address = resolve_address(device.address, deadline, cancel)
        remaining = max(1.0, deadline - (time.monotonic() - started))
        try:
            return asyncio.run(
                self._supervised(device, address, credential, plan, remaining, cancel)
            )
        except (SnmpFetchError, SnmpFetchCancelled):
            raise
        except TimeoutError as exc:
            raise SnmpFetchError(ERROR_TIMEOUT, f"poll exceeded its {deadline:g}s deadline") from exc
        except Exception as exc:  # noqa: BLE001 - classified, never propagated raw
            category, message = classify_exception(exc)
            raise SnmpFetchError(category, _scrub(message, credential.secrets())) from exc

    async def _supervised(
        self,
        device: SnmpDeviceConfig,
        address: str,
        credential: SnmpCredential,
        plan: FetchPlan,
        deadline: float,
        cancel: threading.Event | None,
    ) -> RawDeviceData:
        task = asyncio.ensure_future(self._poll(device, address, credential, plan))
        started = time.monotonic()
        try:
            while True:
                done, _pending = await asyncio.wait({task}, timeout=CANCEL_CHECK_SECONDS)
                if done:
                    return task.result()
                if cancel is not None and cancel.is_set():
                    raise SnmpFetchCancelled("poll cancelled")
                if time.monotonic() - started > deadline:
                    raise TimeoutError
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def _poll(
        self, device: SnmpDeviceConfig, address: str, credential: SnmpCredential, plan: FetchPlan
    ) -> RawDeviceData:
        api = _load_api()
        engine = api.SnmpEngine()
        try:
            session = _Session(
                api,
                engine,
                _auth_data(api, credential),
                await _transport(api, device, address),
                api.ContextData(contextName=credential.context_name)
                if credential.context_name
                else api.ContextData(),
                credential.secrets(),
            )
            data = await self._read_system(session, plan)
            await self._read_interfaces(session, plan, data)
            data.sys_uptime_end_ticks = await self._read_uptime_end(session)
            return data
        finally:
            engine.close_dispatcher()

    async def _read_system(self, session: _Session, plan: FetchPlan) -> RawDeviceData:
        wanted = [oids.SYS_UPTIME, oids.IF_TABLE_LAST_CHANGE]
        if plan.discover:
            wanted += [oids.SYS_NAME, oids.SYS_DESCR, oids.SYS_OBJECT_ID]
        started = time.monotonic()
        values = await session.get(wanted)
        response_ms = round((time.monotonic() - started) * 1000, 3)

        uptime = values.get(oids.SYS_UPTIME)
        if not isinstance(uptime, int):
            raise SnmpFetchError(ERROR_UNSUPPORTED, "device does not provide sysUpTime")
        marker = values.get(oids.IF_TABLE_LAST_CHANGE)
        data = RawDeviceData(
            response_ms=response_ms,
            sys_uptime_ticks=uptime,
            if_table_last_change=marker if isinstance(marker, int) else None,
        )
        if plan.discover:
            for key, oid in (
                ("name", oids.SYS_NAME),
                ("descr", oids.SYS_DESCR),
                ("object_id", oids.SYS_OBJECT_ID),
            ):
                value = values.get(oid)
                if isinstance(value, str) and value:
                    data.system[key] = value
        return data

    async def _read_uptime_end(self, session: _Session) -> int | None:
        """``sysUpTime`` again, after the walks. One more GET, so that a restart, a counter reset or a
        wrap while the walks ran can be told from a consistent reading. A failure costs the poll nothing
        (the collector then cannot vouch for the reading), unless the poll itself is cancelled.
        """
        try:
            value = (await session.get([oids.SYS_UPTIME])).get(oids.SYS_UPTIME)
        except Exception:  # noqa: BLE001 - the poll has its data; only the cross-check is lost
            return None
        return value if isinstance(value, int) else None

    async def _read_interfaces(self, session: _Session, plan: FetchPlan, data: RawDeviceData) -> None:
        async def walk(column: str) -> dict[int, Any]:
            rows = await session.walk(oids.COLUMNS[column], self._max_repetitions, self._max_rows)
            data.columns[column] = rows
            return rows

        interfaces = await walk("oper")
        if not interfaces:
            return  # reachable, but no interface table (no IF-MIB)
        wanted = list(oids.POLL_COLUMNS[1:])
        if plan.discover:
            wanted += oids.DISCOVERY_COLUMNS
        for column in wanted:
            await walk(column)

        indexes = set(interfaces)
        if not (
            indexes <= set(data.columns["in_octets64"]) and indexes <= set(data.columns["out_octets64"])
        ):
            for column in oids.FALLBACK_OCTET_COLUMNS:
                await walk(column)
        high_speed = data.columns["high_speed"]
        if any(not high_speed.get(index) for index in indexes):
            await walk(oids.FALLBACK_SPEED_COLUMN)


class _Session:
    """One engine, credentials and target, with the two requests the poll needs."""

    def __init__(
        self,
        api: Any,
        engine: Any,
        auth: Any,
        target: Any,
        context: Any,
        secrets: tuple[str, ...] = (),
    ) -> None:
        self._api = api
        self._engine = engine
        self._auth = auth
        self._target = target
        self._context = context
        self._secrets = secrets

    async def get(self, wanted: list[str]) -> dict[str, Any]:
        api = self._api
        error, status, _index, binds = await api.get_cmd(
            self._engine,
            self._auth,
            self._target,
            self._context,
            *[api.ObjectType(api.ObjectIdentity(oid)) for oid in wanted],
            lookupMib=False,
        )
        _raise_for(error, status, self._secrets)
        return {str(name): _value(value) for name, value in binds if not _is_exception(value)}

    async def walk(self, column_oid: str, repetitions: int, max_rows: int) -> dict[int, Any]:
        api = self._api
        prefix = column_oid + "."
        rows: dict[int, Any] = {}
        walker = api.bulk_walk_cmd(
            self._engine,
            self._auth,
            self._target,
            self._context,
            0,
            repetitions,
            api.ObjectType(api.ObjectIdentity(column_oid)),
            lexicographicMode=False,
            lookupMib=False,
        )
        try:
            async for error, status, _index, binds in walker:
                _raise_for(error, status, self._secrets)
                for name, value in binds:
                    oid = str(name)
                    suffix = oid[len(prefix) :] if oid.startswith(prefix) else ""
                    # ifIndex 1..2**31-1: the server rejects a whole poll for any other.
                    if not suffix.isdigit() or _is_exception(value):
                        continue
                    index = int(suffix)
                    if not 1 <= index <= MAX_IF_INDEX:
                        continue
                    rows[index] = _value(value)
                if len(rows) > max_rows:
                    raise SnmpFetchError(
                        ERROR_PROTOCOL, f"interface table has more than {max_rows} rows"
                    )
        finally:
            await walker.aclose()
        return rows


def _auth_data(api: Any, credential: SnmpCredential) -> Any:
    if credential.version == VERSION_2C:
        return api.CommunityData(credential.community, mpModel=1)
    kwargs: dict[str, Any] = {
        "authKey": credential.auth_password,
        "authProtocol": _AUTH_PROTOCOL_ATTRS[credential.auth_protocol](api),
    }
    if credential.priv_protocol:
        kwargs["privKey"] = credential.priv_password
        kwargs["privProtocol"] = _PRIV_PROTOCOL_ATTRS[credential.priv_protocol](api)
    return api.UsmUserData(credential.username, **kwargs)


_AUTH_PROTOCOL_ATTRS = {
    "SHA": lambda api: api.usmHMACSHAAuthProtocol,
    "SHA-224": lambda api: api.usmHMAC128SHA224AuthProtocol,
    "SHA-256": lambda api: api.usmHMAC192SHA256AuthProtocol,
    "SHA-384": lambda api: api.usmHMAC256SHA384AuthProtocol,
    "SHA-512": lambda api: api.usmHMAC384SHA512AuthProtocol,
}
_PRIV_PROTOCOL_ATTRS = {
    "AES-128": lambda api: api.usmAesCfb128Protocol,
    "AES-192": lambda api: api.usmAesCfb192Protocol,
    "AES-256": lambda api: api.usmAesCfb256Protocol,
}


async def _transport(api: Any, device: SnmpDeviceConfig, address: str) -> Any:
    target_class = api.Udp6TransportTarget if ":" in address else api.UdpTransportTarget
    return await target_class.create(
        (address, device.port),
        timeout=device.timeout_seconds,
        retries=device.retries,
    )


# -- values and errors ------------------------------------------------------------


def _is_exception(value: Any) -> bool:
    return type(value).__name__ in _EXCEPTION_VALUES


def _value(value: Any) -> Any:
    """Plain ``int`` for numbers, ``str`` for text and OIDs."""
    kind = type(value).__name__
    if kind in ("OctetString", "DisplayString"):
        text = bytes(value.asOctets()).decode("utf-8", errors="replace")
        return _CONTROL_RE.sub(" ", text).strip()
    if kind in ("ObjectIdentifier", "ObjectName"):
        return str(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value.prettyPrint()) if hasattr(value, "prettyPrint") else str(value)


def _raise_for(error: Any, status: Any, secrets: tuple[str, ...] = ()) -> None:
    """Turn a pysnmp error indication or error status into ``SnmpFetchError``."""
    if error:
        category, message = classify_exception(error)
        raise SnmpFetchError(category, _scrub(message, secrets))
    if status:
        text = str(status.prettyPrint() if hasattr(status, "prettyPrint") else status)
        category = ERROR_AUTH_FAILURE if text in _AUTH_STATUSES else ERROR_PROTOCOL
        raise SnmpFetchError(category, _scrub(f"device returned error status {text}", secrets))


def classify_exception(exc: BaseException | Any) -> tuple[str, str]:
    """Map a pysnmp error (indication or exception) to ``(category, message)``."""
    name = type(exc).__name__
    message = str(exc) or name  # callers scrub it before shortening
    if name == "RequestTimedOut" or isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return ERROR_TIMEOUT, message
    if _caused_by(exc, socket.gaierror):
        # pysnmp wraps the resolver error in its own exception.
        return ERROR_DNS_FAILURE, "host name cannot be resolved"
    if name in _AUTH_ERRORS:
        return ERROR_AUTH_FAILURE, message
    if name in _PROTOCOL_ERRORS:
        return ERROR_PROTOCOL, message
    if isinstance(exc, OSError):
        return ERROR_UNREACHABLE, exc.strerror or message
    return ERROR_UNKNOWN, message


def _caused_by(exc: BaseException | Any, kind: type[BaseException]) -> bool:
    seen = 0
    while isinstance(exc, BaseException) and seen < 8:
        if isinstance(exc, kind):
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def _scrub(message: str, secrets: tuple[str, ...]) -> str:
    """Remove any secret that a library message might have repeated, then shorten it."""
    for secret in secrets:
        message = message.replace(secret, "***")
    return message[:MAX_MESSAGE_LENGTH]


def resolve_address(
    address: str,
    timeout: float,
    cancel: threading.Event | None = None,
    getaddrinfo=None,
) -> str:
    """An IP literal for ``address``, never blocking longer than ``timeout``.

    IP literals are returned as they are. A host name is resolved (IPv4) in a
    helper thread that is left behind, harmlessly, if the resolver hangs: the
    caller returns at the deadline or when cancelled, and the thread is a
    daemon, so it cannot delay shutdown either.
    """
    try:
        ipaddress.ip_address(address)
        return address
    except ValueError:
        pass

    resolver = getaddrinfo or socket.getaddrinfo  # looked up now, so tests can replace it
    outcome: dict[str, Any] = {}
    finished = threading.Event()

    def lookup() -> None:
        try:
            outcome["address"] = resolver(
                address, None, family=socket.AF_INET, type=socket.SOCK_DGRAM
            )[0][4][0]
        except BaseException as exc:  # noqa: BLE001 - reported to the waiting poll
            outcome["error"] = exc
        finally:
            finished.set()

    threading.Thread(target=lookup, name="sentinel-resolve", daemon=True).start()
    give_up = time.monotonic() + timeout
    while not finished.wait(0.1):
        if cancel is not None and cancel.is_set():
            raise SnmpFetchCancelled("poll cancelled")
        if time.monotonic() >= give_up:
            raise SnmpFetchError(ERROR_DNS_FAILURE, "host name resolution timed out")
    error = outcome.get("error")
    if error is not None:
        if isinstance(error, socket.gaierror):
            raise SnmpFetchError(ERROR_DNS_FAILURE, "host name cannot be resolved") from error
        category, message = classify_exception(error)
        raise SnmpFetchError(category, message[:MAX_MESSAGE_LENGTH]) from error
    return outcome["address"]

"""Shared fixtures for the SNMP tests (not a test module)."""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone

from agent.snmp_config import (
    InterfaceSelection,
    SnmpCredential,
    SnmpDeviceConfig,
)
from agent.snmp_fetch import FetchPlan, RawDeviceData, SnmpFetchError

DEVICE_ID = uuid.UUID("0b8f0a5e-2f0e-4c1c-8f65-1e0d4f0d7d2a")
SECRET = "Sup3rS3cretValue-do-not-leak"


def device(**overrides) -> SnmpDeviceConfig:
    values = {
        "id": DEVICE_ID,
        "name": "core-sw-1",
        "address": "192.0.2.10",
        "credential_profile": "core",
    }
    values.update(overrides)
    return SnmpDeviceConfig(**values)


def selection(**overrides) -> InterfaceSelection:
    return InterfaceSelection(**overrides)


def community(secret: str = SECRET, name: str = "core") -> SnmpCredential:
    return SnmpCredential(name=name, version="2c", community=secret)


def v3(secret: str = SECRET, name: str = "core", **overrides) -> SnmpCredential:
    values = {
        "name": name,
        "version": "3",
        "username": "sentinel",
        "auth_protocol": "SHA-256",
        "auth_password": secret + "-auth",
        "priv_protocol": "AES-128",
        "priv_password": secret + "-priv",
    }
    values.update(overrides)
    return SnmpCredential(**values)


def interface(index: int, **overrides) -> dict:
    """The per-interface values a fetch returns, keyed by column."""
    values = {
        "oper": 1,
        "admin": 1,
        "high_speed": 1000,
        "in_octets64": 1_000,
        "out_octets64": 2_000,
        "in_errors": 0,
        "out_errors": 0,
        "in_discards": 0,
        "out_discards": 0,
        "name": f"Gi0/{index}",
        "descr": f"GigabitEthernet0/{index}",
        "alias": "",
        "type": 6,
    }
    values.update(overrides)
    return values


def raw_data(
    interfaces: dict[int, dict],
    *,
    uptime: int = 1_000_000,
    marker: int | None = 10,
    response_ms: float = 12.5,
    system: dict | None = None,
    discover: bool = False,
) -> RawDeviceData:
    """Build ``RawDeviceData`` from ``{ifIndex: values}``; ``None`` values are absent rows."""
    columns: dict[str, dict[int, object]] = {}
    for index, values in interfaces.items():
        for column, value in values.items():
            if value is not None:
                columns.setdefault(column, {})[index] = value
    columns.setdefault("oper", {})
    if not discover:
        for column in ("name", "descr", "alias", "type"):
            columns.pop(column, None)
    data = RawDeviceData(
        response_ms=response_ms,
        sys_uptime_ticks=uptime,
        if_table_last_change=marker,
        columns=columns,
    )
    if discover:
        data.system = system or {
            "name": "core-sw-1",
            "descr": "Cisco IOS XE",
            "object_id": "1.3.6.1.4.1.9.1.2504",
        }
    return data


class FakeFetcher:
    """Returns scripted results, one per fetch; records what it was asked for."""

    def __init__(self, *results) -> None:
        self.results = list(results)
        self.plans: list[FetchPlan] = []
        self.credentials = []
        self.lock = threading.Lock()

    def push(self, *results) -> None:
        self.results.extend(results)

    def fetch(self, device, credential, plan, cancel=None):
        with self.lock:
            self.plans.append(plan)
            self.credentials.append(credential)
            result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        if callable(result):
            result = result(plan)
        return result


def unreachable(category: str = "timeout", message: str = "no response") -> SnmpFetchError:
    return SnmpFetchError(category, message)


class Clock:
    """Controllable monotonic and wall clocks."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start
        self.wall = datetime(2026, 10, 12, 14, 0, 0, tzinfo=timezone.utc)

    def monotonic(self) -> float:
        return self.now

    def utcnow(self) -> datetime:
        return self.wall

    def advance(self, seconds: float) -> None:
        self.now += seconds
        self.wall += timedelta(seconds=seconds)


def ids():
    """Deterministic poll ids."""
    counter = iter(range(1, 10_000))
    return lambda: uuid.UUID(int=next(counter))

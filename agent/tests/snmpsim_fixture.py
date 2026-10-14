"""A running snmpsim (SNMP agent simulator) with the devices the SNMP tests poll.

Needs the optional libraries (``pip install "./agent[snmp]" snmpsim pysmi``);
``available()`` says whether they are present so tests can skip cleanly.

Simulated devices are data files in a temporary directory. Their names are the
SNMPv2c community and the SNMPv3 context name (snmpsim's convention), so one
file serves both protocols:

``public``   a switch: three interfaces (one down, one loopback), 64-bit
             counters, names, aliases; counters and uptime are writable
``legacy``   an old device: ifTable only, 32-bit counters, saturated ifSpeed
``bare``     answers, but has no IF-MIB
``big``      130 interfaces, to exercise bulk walks over several responses

Writable values (snmpsim's ``writecache`` module) let a test move counters
between two polls with an SNMP SET, which makes deltas exact.
"""

from __future__ import annotations

import asyncio
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

BIG_INTERFACES = 130


def available() -> str | None:
    """``None`` if the simulator and SNMP library can run here, else why not."""
    try:
        import pysnmp.hlapi.v3arch.asyncio  # noqa: F401
        import snmpsim.commands.responder  # noqa: F401
    except ImportError as exc:
        return f"needs pysnmp and snmpsim (pip install snmpsim pysmi): {exc}"
    try:
        from cryptography.hazmat.decrepit.ciphers.modes import CFB  # noqa: F401
    except ImportError:
        return "needs cryptography for SNMPv3 AES"
    return None


@dataclass(frozen=True)
class V3Engine:
    """One simulated SNMPv3 engine (one USM user) on its own port."""

    port: int
    user: str
    auth_protocol: str  # snmpsim spelling: SHA, SHA224, ...
    auth_key: str
    priv_protocol: str  # AES, AES192, AES256 or NONE
    priv_key: str


def _line(oid: str, tag: str, value: object, *, writable: bool = False) -> str:
    kind = f"{tag}:writecache" if writable else tag
    text = f"value={value}" if writable else str(value)
    return f"{oid}|{kind}|{text}"


def system_rows(*, uptime: int = 8_123_456, name: str = "test-sw-1") -> list[str]:
    return [
        _line("1.3.6.1.2.1.1.1.0", "4", "Test Switch OS 1.0"),
        _line("1.3.6.1.2.1.1.2.0", "6", "1.3.6.1.4.1.8072.3.2.10"),
        _line("1.3.6.1.2.1.1.3.0", "67", uptime, writable=True),
        _line("1.3.6.1.2.1.1.5.0", "4", name),
    ]


def if_rows(
    index: int,
    *,
    name: str | None,
    descr: str,
    if_type: int = 6,
    speed: int = 1_000_000_000,
    high_speed: int | None = 1000,
    alias: str | None = "",
    admin: int = 1,
    oper: int = 1,
    hc: bool = True,
    octets: tuple[int, int] = (1000, 2000),
    errors: tuple[int, int] = (0, 0),
    discards: tuple[int, int] = (0, 0),
    writable: bool = True,
    discontinuity: int | None = None,
) -> list[str]:
    ifx = "1.3.6.1.2.1.31.1.1.1"
    rows = [
        _line(f"1.3.6.1.2.1.2.2.1.1.{index}", "2", index),
        _line(f"1.3.6.1.2.1.2.2.1.2.{index}", "4", descr),
        _line(f"1.3.6.1.2.1.2.2.1.3.{index}", "2", if_type),
        _line(f"1.3.6.1.2.1.2.2.1.5.{index}", "66", speed),
        _line(f"1.3.6.1.2.1.2.2.1.7.{index}", "2", admin),
        _line(f"1.3.6.1.2.1.2.2.1.8.{index}", "2", oper),
        _line(f"1.3.6.1.2.1.2.2.1.13.{index}", "65", discards[0], writable=writable),
        _line(f"1.3.6.1.2.1.2.2.1.14.{index}", "65", errors[0], writable=writable),
        _line(f"1.3.6.1.2.1.2.2.1.19.{index}", "65", discards[1], writable=writable),
        _line(f"1.3.6.1.2.1.2.2.1.20.{index}", "65", errors[1], writable=writable),
    ]
    if not hc:
        rows += [
            _line(f"1.3.6.1.2.1.2.2.1.10.{index}", "65", octets[0], writable=writable),
            _line(f"1.3.6.1.2.1.2.2.1.16.{index}", "65", octets[1], writable=writable),
        ]
    if name is not None:
        rows.append(_line(f"{ifx}.1.{index}", "4", name))
    if hc:
        rows += [
            _line(f"{ifx}.6.{index}", "70", octets[0], writable=writable),
            _line(f"{ifx}.10.{index}", "70", octets[1], writable=writable),
        ]
    if high_speed is not None:
        rows.append(_line(f"{ifx}.15.{index}", "66", high_speed))
    if alias is not None:
        rows.append(_line(f"{ifx}.18.{index}", "4", alias))
    if discontinuity is not None:  # ifCounterDiscontinuityTime
        rows.append(_line(f"{ifx}.19.{index}", "67", discontinuity, writable=True))
    return rows


def _write(path: Path, rows: list[str]) -> None:
    def key(row: str) -> tuple[int, ...]:
        return tuple(int(part) for part in row.split("|", 1)[0].split("."))

    path.write_text("\n".join(sorted(rows, key=key)) + "\n", encoding="utf-8")


def write_devices(directory: Path) -> None:
    switch = system_rows()
    switch.append(_line("1.3.6.1.2.1.31.1.5.0", "67", 100, writable=True))  # ifTableLastChange
    switch += if_rows(1, name="Gi0/1", descr="GigabitEthernet0/1", alias="uplink to dc2", octets=(123_456_789_012, 98_765_432_109), discontinuity=0)
    switch += if_rows(
        2, name="Gi0/2", descr="GigabitEthernet0/2", speed=4_294_967_295, high_speed=10_000, oper=2, octets=(5, 7), errors=(2, 0), discards=(1, 0)
    )
    switch += if_rows(3, name="Loopback0", descr="Loopback0", if_type=24, speed=0, high_speed=0, octets=(1, 1))
    _write(directory / "public.snmprec", switch)

    legacy = system_rows(name="old-router")
    legacy += if_rows(1, name=None, descr="eth0", hc=False, high_speed=None, alias=None, octets=(4_294_967_000, 10))
    legacy += if_rows(2, name=None, descr="eth1", hc=False, high_speed=None, alias=None, speed=4_294_967_295, octets=(1, 1), writable=False)
    _write(directory / "legacy.snmprec", legacy)

    _write(directory / "bare.snmprec", system_rows(name="appliance"))

    big = system_rows(name="big-switch")
    for index in range(1, BIG_INTERFACES + 1):
        big += if_rows(index, name=f"Eth1/{index}", descr=f"Ethernet1/{index}", alias=f"port {index}", octets=(index * 1000, index), writable=False)
    _write(directory / "big.snmprec", big)


class Simulator:
    """Starts snmpsim with several SNMPv3 engines and stops it again."""

    V2C_PORT = 0

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.process: subprocess.Popen[bytes] | None = None
        ports = _free_ports(6)
        self.v2c_port = ports[0]
        #            port       user          auth       auth key             priv     priv key
        self.engines = {
            "sha256-aes128": V3Engine(ports[1], "u-sha256", "SHA256", "authpass-sha256", "AES", "privpass-aes128"),
            "sha512-aes256": V3Engine(ports[2], "u-sha512", "SHA512", "authpass-sha512", "AES256", "privpass-aes256"),
            "sha384-aes192": V3Engine(ports[3], "u-sha384", "SHA384", "authpass-sha384", "AES192", "privpass-aes192"),
            "sha224-nopriv": V3Engine(ports[4], "u-sha224", "SHA224", "authpass-sha224", "NONE", ""),
            "sha1-aes128": V3Engine(ports[5], "u-sha1", "SHA", "authpass-sha1", "AES", "privpass-sha1"),
        }

    def start(self) -> None:
        data = self.dir / "data"
        data.mkdir()
        write_devices(data)
        args = [
            sys.executable,
            "-m",
            "snmpsim.commands.responder",
            f"--cache-dir={self.dir / 'cache'}",
            "--logging-method=null",
            "--v3-engine-id=auto",
            f"--data-dir={data}",
            f"--agent-udpv4-endpoint=127.0.0.1:{self.v2c_port}",
        ]
        for engine in self.engines.values():
            args += [
                "--v3-engine-id=auto",
                f"--data-dir={data}",
                f"--agent-udpv4-endpoint=127.0.0.1:{engine.port}",
                f"--v3-user={engine.user}",
                f"--v3-auth-key={engine.auth_key}",
                f"--v3-auth-proto={engine.auth_protocol}",
            ]
            if engine.priv_protocol != "NONE":
                args += [f"--v3-priv-key={engine.priv_key}", f"--v3-priv-proto={engine.priv_protocol}"]
        self.process = subprocess.Popen(  # noqa: S603 - fixed test command
            args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        self._wait_until_ready()

    def stop(self) -> None:
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
            if self.process.stderr:
                self.process.stderr.close()
        self._tmp.cleanup()

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + 30
        ports = [self.v2c_port] + [engine.port for engine in self.engines.values()]
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                error = self.process.stderr.read().decode(errors="replace") if self.process.stderr else ""
                raise RuntimeError(f"snmpsim exited early: {error[-2000:]}")
            if all(_answers(port) for port in ports[:1]) and all(_port_bound(port) for port in ports):
                return
            time.sleep(0.2)
        raise RuntimeError("snmpsim did not start in time")

    def set_values(self, community: str, values: dict[str, tuple[str, int]], *, port: int | None = None) -> None:
        """SNMP SET writable values: ``{oid: (type, value)}`` with type ``counter64``, ``counter32`` or ``timeticks``."""
        asyncio.run(_set(port or self.v2c_port, community, values))


def _free_ports(count: int) -> list[int]:
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def _port_bound(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.bind(("127.0.0.1", port))
    except OSError:
        return True  # in use: the simulator holds it
    finally:
        probe.close()
    return False


def _answers(port: int) -> bool:
    return asyncio.run(_ask(port))


async def _ask(port: int) -> bool:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        UdpTransportTarget,
        get_cmd,
    )

    engine = SnmpEngine()
    try:
        target = await UdpTransportTarget.create(("127.0.0.1", port), timeout=0.5, retries=0)
        error, status, _index, _binds = await get_cmd(
            engine,
            CommunityData("public", mpModel=1),
            target,
            ContextData(),
            ObjectType(ObjectIdentity("1.3.6.1.2.1.1.3.0")),
            lookupMib=False,
        )
        return not error and not status
    finally:
        engine.close_dispatcher()


async def _set(port: int, community: str, values: dict[str, tuple[str, int]]) -> None:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        ContextData,
        Counter32,
        Counter64,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        TimeTicks,
        UdpTransportTarget,
        set_cmd,
    )

    kinds = {"counter64": Counter64, "counter32": Counter32, "timeticks": TimeTicks}
    engine = SnmpEngine()
    try:
        target = await UdpTransportTarget.create(("127.0.0.1", port), timeout=2, retries=1)
        binds = [
            ObjectType(ObjectIdentity(oid), kinds[kind](value)) for oid, (kind, value) in values.items()
        ]
        error, status, _index, _binds = await set_cmd(
            engine, CommunityData(community, mpModel=1), target, ContextData(), *binds, lookupMib=False
        )
        if error or status:
            raise RuntimeError(f"SET failed: {error or status}")
    finally:
        engine.close_dispatcher()

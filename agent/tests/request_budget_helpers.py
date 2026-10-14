"""Polls, sections, a heartbeat driver and a size-enforcing fake server for the request-size tests.

Standard library only: the agent tests run without Django.
"""

from __future__ import annotations

import io
import json
import logging
import urllib.error
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

from agent import http_client
from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import send_heartbeat
from agent.measurement_queue import MeasurementQueue
from agent.network_delivery import NetworkDelivery
from agent.snmp_delivery import SnmpDelivery
from agent.snmp_payload import sanitize_poll
from agent.tests.test_measurement_queue import Clock, measurement

# Django's default DATA_UPLOAD_MAX_MEMORY_SIZE (2.5 MiB). settings.py does not
# override it, so a request body of more bytes is refused with HTTP 400
# (apps/agents/tests/test_request_body_limit.py pins both facts).
SERVER_LIMIT = 2_621_440
# What the agent budgets for the stored form of one SNMP report: the size of the
# compact UTF-8 JSON in its queue, not of the request body.
STORED_BUDGET = 1_000_000

ASCII = "a"
GREEK = "Ω"  # 2 bytes in UTF-8, 6 as an ASCII escape
CJK = "界"  # 3 bytes, 6
EMOJI = "😀"  # 4 bytes, 12 (an escaped surrogate pair)
DEL = "\x7f"  # 1 byte, 6: the one character json.dumps escapes only when it is told to be ASCII
QUOTE = '"'  # 2 bytes escaped either way
CONTROL = "\x01"  # 6 bytes escaped either way

MEASURED_AT = "2026-10-12T14:05:00+00:00"
TELEMETRY = {
    "version": 1,
    "collected_at": "2026-10-12T14:05:00+00:00",
    "cpu_percent": 10.0,
    "memory_total_bytes": 1000,
    "memory_used_bytes": 400,
    "memory_percent": 40.0,
    "disk_total_bytes": 2000,
    "disk_used_bytes": 500,
    "disk_percent": 25.0,
    "uptime_seconds": 99,
}


def interface(index: int, char: str, *, counters: bool) -> dict[str, Any]:
    """An interface whose name, description and alias are as long as the collector allows (128, 128, 64)."""
    entry: dict[str, Any] = {
        "if_index": index,
        "name": char * 128,
        "descr": char * 128,
        "alias": char * 64,
        "if_type": 6,
        "speed_bps": 1_000_000_000,
        "admin_status": 1,
        "oper_status": 1,
    }
    if counters:
        entry["counters"] = {
            "octets_bits": 64,
            "delta_state": "ok",
            "interval_seconds": 300.0,
            "raw": {
                "in_octets": 10**12,
                "out_octets": 2 * 10**12,
                "in_errors": 1,
                "out_errors": 2,
                "in_discards": 3,
                "out_discards": 4,
            },
            "delta": {
                "in_octets": 300_000,
                "out_octets": 600_000,
                "in_errors": 0,
                "out_errors": 1,
                "in_discards": 0,
                "out_discards": 2,
            },
        }
    return entry


def text_poll(
    interfaces: int,
    char: str,
    *,
    counters: bool = False,
    measured_at: str = MEASURED_AT,
    device_id: str | None = None,
) -> dict[str, Any]:
    """A poll of ``interfaces`` interfaces with the longest text the collector produces, made of ``char``."""
    return {
        "poll_id": str(uuid.uuid4()),
        "device_id": device_id or str(uuid.uuid4()),
        "measured_at": measured_at,
        "reachable": True,
        "response_ms": 12.5,
        "sys_uptime_ticks": 8123456,
        "interfaces_complete": False,
        "interfaces": [interface(index, char, counters=counters) for index in range(1, interfaces + 1)],
    }


def short_poll(interfaces: int = 40, *, measured_at: str = MEASURED_AT, device_id: str | None = None) -> dict[str, Any]:
    """An ordinary poll: short ASCII names, counters on every interface."""
    poll = text_poll(interfaces, ASCII, counters=True, measured_at=measured_at, device_id=device_id)
    for index, entry in enumerate(poll["interfaces"], start=1):
        entry.update(name=f"Gi0/{index}", descr=f"GigabitEthernet0/{index} uplink", alias="core")
    return poll


def stored_size(poll: dict[str, Any]) -> int:
    """The bytes the queue counts for a poll (and the report budget sums)."""
    return len(sanitize_poll(poll)[1].encode("utf-8"))


def wire_size(value: Any) -> int:
    """The bytes ``json.dumps`` puts on the wire for ``value`` (the client's default settings)."""
    return len(json.dumps(value).encode("utf-8"))


def docker_section(containers: int = 3, *, name_length: int = 20) -> dict[str, Any]:
    return {
        "version": 1,
        "available": True,
        "status": "available",
        "collected_at": MEASURED_AT,
        "containers": [
            {
                "container_id": uuid.uuid4().hex + uuid.uuid4().hex,
                "name": f"service-{index}-".ljust(name_length, "x"),
                "image": "registry.example.com/team/service-image:1.2.3",
                "state": "running",
                "health": "healthy",
                "created_at": "2026-10-01T10:00:00.123456+00:00",
                "started_at": "2026-10-12T10:00:00.123456+00:00",
            }
            for index in range(containers)
        ],
    }


def docker_for_request(polls: list[dict[str, Any]], total: int) -> dict[str, Any]:
    """A Docker section that makes the heartbeat carrying ``polls`` (with the telemetry) exactly ``total`` bytes."""

    def size(name_length: int) -> int:
        payload = {
            "telemetry": TELEMETRY,
            "docker": docker_section(1, name_length=name_length),
            "snmp": {"version": 1, "polls": polls},
        }
        return wire_size(payload)

    length = 20
    length += total - size(length)
    docker = docker_section(1, name_length=length)
    assert size(length) == total, (size(length), total)
    return docker


def docker_filling(total: int, *, network: dict[str, Any] | None = None) -> dict[str, Any]:
    """A Docker section that makes the heartbeat of the telemetry, it and ``network`` exactly ``total`` bytes."""

    def size(name_length: int) -> int:
        payload: dict[str, Any] = {"telemetry": TELEMETRY, "docker": docker_section(1, name_length=name_length)}
        if network is not None:
            payload["network"] = network
        return wire_size(payload)

    length = 20
    length += total - size(length)
    assert length >= 20, "total is too small for a Docker section"
    docker = docker_section(1, name_length=length)
    assert size(length) == total, (size(length), total)
    return docker


def network_section(measurements: int = 5) -> dict[str, Any]:
    return {"version": 1, "measurements": [measurement() for _ in range(measurements)]}


def pad_poll(poll: dict[str, Any], size: int) -> dict[str, Any]:
    """``poll`` with text added to its system name so that it takes exactly ``size`` bytes in a request.

    DEL characters are most of it (6 bytes each as sent, 1 stored, so even a poll as large as a request
    stays within what the queue stores), and ASCII letters make up the odd bytes.
    """
    poll["system"] = {"name": ""}
    missing = size - wire_size(poll)
    poll["system"]["name"] = DEL * (missing // 6) + "x" * (missing % 6)
    assert wire_size(poll) == size
    return poll


class _Reply:
    status = 200

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Reply:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


class FakeSentinel:
    """The server as the agent sees it: refuses a body over ``limit`` bytes with HTTP 400 (as Django does)
    and otherwise stores every poll it is sent, acknowledging each as created.

    ``fail_when`` is asked about every request that is within the limit (the parsed body) and may answer
    an HTTP status to refuse it with, or an exception to raise from the transport. ``acknowledge`` set to
    ``False`` makes it answer 200 without naming any poll as stored.
    """

    def __init__(self, limit: int = SERVER_LIMIT) -> None:
        self.limit = limit
        self.bodies: list[bytes] = []
        self.refused = 0
        self.stored: list[str] = []
        self.network_stored: list[str] = []
        self.fail_when: Callable[[dict[str, Any]], int | BaseException | None] | None = None
        self.acknowledge = True

    def open(self, request: Any, timeout: float | None = None) -> _Reply:
        body = request.data
        self.bodies.append(body)
        if len(body) > self.limit:
            self.refused += 1
            self._refuse(request, 400)
        payload = json.loads(body)
        failure = self.fail_when(payload) if self.fail_when else None
        if isinstance(failure, BaseException):
            raise failure
        if failure is not None:
            self._refuse(request, failure)
        answer: dict[str, Any] = {"status": "ok"}
        section = payload.get("snmp")
        if section and self.acknowledge:
            results = []
            for poll in section["polls"]:
                if poll["poll_id"] not in self.stored:
                    self.stored.append(poll["poll_id"])
                results.append({"poll_id": poll["poll_id"], "result": "created"})
            answer.update(
                snmp="accepted",
                snmp_created=len(results),
                snmp_duplicates=0,
                snmp_accepted=len(results),
                snmp_rejected=0,
                snmp_results=results,
            )
        elif section:
            answer.update(snmp="accepted", snmp_results=[])
        network = payload.get("network")
        if network and self.acknowledge:
            results = []
            for item in network["measurements"]:
                if item["measurement_id"] not in self.network_stored:
                    self.network_stored.append(item["measurement_id"])
                results.append({"measurement_id": item["measurement_id"], "result": "created"})
            answer.update(
                network="accepted",
                network_created=len(results),
                network_duplicates=0,
                network_accepted=len(results),
                network_rejected=0,
                network_results=results,
            )
        elif network:
            answer.update(network="accepted", network_results=[])
        return _Reply(json.dumps(answer).encode("utf-8"))

    @staticmethod
    def _refuse(request: Any, status: int) -> None:
        raise urllib.error.HTTPError(request.full_url, status, "Refused", None, io.BytesIO(b"Refused"))

    def sections(self, index: int = -1) -> set[str]:
        """The sections the ``index``-th request carried."""
        return set(json.loads(self.bodies[index]))

    @contextmanager
    def installed(self):
        """Route the agent's HTTP client to this server."""
        with patch.object(http_client._opener, "open", side_effect=self.open):
            yield self

    @property
    def largest_body(self) -> int:
        return max(map(len, self.bodies), default=0)


class _Messages(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(f"{record.levelname}: {record.getMessage()}")


@contextmanager
def agent_logs():
    """The agent's log messages (``"LEVEL: text"``), collected instead of printed; none is required."""
    logger = logging.getLogger("sentinel_agent")
    handler = _Messages()
    previous = (logger.propagate, logger.level)
    logger.addHandler(handler)
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    try:
        yield handler.messages
    finally:
        logger.removeHandler(handler)
        logger.propagate, level = previous
        logger.setLevel(level)


class Harness:
    """An agent's queue and deliveries, and the means to send heartbeats from them.

    SNMP delivery is on unless ``snmp=False`` (an agent without SNMP); the network delivery is off
    unless ``network=True``. Both clocks are fake: ``cycle`` moves the monotonic one past any
    backoff, so a test never waits and never depends on the real time.
    """

    def __init__(self, *, snmp: bool = True, network: bool = False) -> None:
        self.wall = Clock()
        self.mono = Clock(0.0)
        self.queue = MeasurementQueue(None, wall_fn=self.wall)
        self.delivery = SnmpDelivery(self.queue, time_fn=self.mono) if snmp else None
        self.network_delivery = NetworkDelivery(self.queue, time_fn=self.mono) if network else None
        self.errors: list[str] = []

    def close(self) -> None:
        self.queue.close()

    def enqueue(self, *polls: dict[str, Any]) -> list[str]:
        for poll in polls:
            self.queue.enqueue_snmp(poll)
        return [poll["poll_id"] for poll in polls]

    def enqueue_measurements(self, count: int) -> list[str]:
        items = [measurement() for _ in range(count)]
        for item in items:
            self.queue.enqueue(item)
        return [item["measurement_id"] for item in items]

    def beat(
        self,
        config: Config,
        *,
        docker: Callable[[], dict[str, Any]] | None = None,
        network: Callable[[], dict[str, Any]] | None = None,
        collect: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        """One heartbeat; a failed one is recorded in ``errors``."""
        try:
            send_heartbeat(
                config,
                collect_fn=collect or (lambda: TELEMETRY),
                docker_fn=docker or (lambda: docker_section(0)),
                network_fn=network,
                network_delivery=self.network_delivery,
                snmp_delivery=self.delivery,
            )
        except HeartbeatError as exc:
            self.errors.append(str(exc))

    def cycle(self, config: Config, **sections: Any) -> None:
        """One heartbeat, then the clock moves past any backoff."""
        self.beat(config, **sections)
        self.mono.now += 700

    def drain(self, config: Config, *, cycles: int = 8, **sections: Any) -> int:
        """Send heartbeats until the SNMP queue is empty or ``cycles`` have been sent; returns the number sent."""
        sent = 0
        while sent < cycles and self.queue.snmp_count():
            self.cycle(config, **sections)
            sent += 1
        return sent

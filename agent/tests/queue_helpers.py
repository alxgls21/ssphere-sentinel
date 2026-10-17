"""Shared queue fixtures for network, SNMP, and heartbeat delivery tests."""

import os
import tempfile
import unittest
import uuid
from pathlib import Path

from agent.measurement_queue import MeasurementQueue


def measurement(**overrides):
    payload = {
        "measurement_id": str(uuid.uuid4()),
        "target_id": str(uuid.uuid4()),
        "measured_at": "2026-10-09T10:00:00+00:00",
        "success": True,
        "latency_ms": 1.5,
        "packet_loss_percentage": 0.0,
        "probe_count": 4,
        "successful_probes": 4,
        "failure_reason": "",
    }
    payload.update(overrides)
    return payload


def poll(count=2, **overrides):
    payload = {
        "poll_id": str(uuid.uuid4()),
        "device_id": str(uuid.uuid4()),
        "measured_at": "2026-10-12T14:05:00+00:00",
        "reachable": True,
        "response_ms": 12.5,
        "sys_uptime_ticks": 8123456,
        "interfaces_complete": False,
        "interfaces": [
            {
                "if_index": index,
                "name": f"Gi0/{index}",
                "admin_status": 1,
                "oper_status": 1,
                "counters": {
                    "octets_bits": 64,
                    "delta_state": "first",
                    "raw": {"in_octets": 1, "out_octets": 2},
                },
            }
            for index in range(1, count + 1)
        ],
    }
    payload.update(overrides)
    return payload


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class QueueTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)
        self.path = self.dir / "state" / "queue.sqlite3"
        self.clock = Clock()
        self.queues = []

    def tearDown(self):
        for queue in self.queues:
            queue.close()
        self._tmp.cleanup()

    def open_queue(self, path=None, **kwargs):
        kwargs.setdefault("wall_fn", self.clock)
        queue = MeasurementQueue.open(self.path if path is None else path, **kwargs)
        self.queues.append(queue)
        return queue

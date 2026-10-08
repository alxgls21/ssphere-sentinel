import unittest
from uuid import uuid4

from agent.network import NetworkMonitor
from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeResult


class NetworkMonitorTests(unittest.TestCase):
    def test_includes_measurements_in_payload(self):
        target = NetworkTargetConfig(
            id=uuid4(),
            name="t",
            hostname_or_ip="127.0.0.1",
            protocol="tcp",
            port=443,
            enabled=True,
            monitoring_interval_seconds=60,
            timeout_seconds=1,
            probe_count=2,
        )

        def probe_fn(_target):
            return ProbeResult(
                success=True,
                latency_ms=5.0,
                packet_loss_percentage=0.0,
                probe_count=2,
                successful_probes=2,
                failure_reason="",
            )

        clock = {"t": 0.0}

        def time_fn():
            return clock["t"]

        monitor = NetworkMonitor([target], probe_fn=probe_fn, time_fn=time_fn)
        first = monitor.collect_due_measurements()
        self.assertEqual(first["version"], 1)
        self.assertEqual(len(first["measurements"]), 1)
        self.assertEqual(first["measurements"][0]["target_id"], str(target.id))

        # Not due yet.
        second = monitor.collect_due_measurements()
        self.assertEqual(second["measurements"], [])

        # Advance past interval.
        clock["t"] = 61.0
        third = monitor.collect_due_measurements()
        self.assertEqual(len(third["measurements"]), 1)

    def test_probe_failure_does_not_raise(self):
        target = NetworkTargetConfig(
            id=uuid4(),
            name="t",
            hostname_or_ip="127.0.0.1",
            protocol="tcp",
            port=443,
            enabled=True,
            monitoring_interval_seconds=60,
            timeout_seconds=1,
            probe_count=1,
        )

        def boom(_target):
            raise RuntimeError("probe crashed")

        monitor = NetworkMonitor([target], probe_fn=boom)
        payload = monitor.collect_due_measurements()
        self.assertEqual(payload["measurements"], [])

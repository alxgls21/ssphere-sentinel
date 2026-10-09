import threading
import time
import unittest
from collections import Counter
from unittest.mock import patch
from uuid import uuid4

from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeAttempt, ProbeResult
from agent.probe_scheduler import ProbeScheduler

OK = ProbeResult(
    success=True,
    latency_ms=1.0,
    packet_loss_percentage=0.0,
    probe_count=1,
    successful_probes=1,
    failure_reason="",
)


def make_target(interval=60.0, *, enabled=True, probe_count=1):
    return NetworkTargetConfig(
        id=uuid4(),
        name="t",
        hostname_or_ip="192.0.2.1",
        protocol="tcp",
        port=443,
        enabled=enabled,
        monitoring_interval_seconds=interval,
        timeout_seconds=1,
        probe_count=probe_count,
    )


class SchedulerTestCase(unittest.TestCase):
    def setUp(self):
        self.sunk = []
        self.lock = threading.Lock()
        self.schedulers = []

    def tearDown(self):
        for scheduler in self.schedulers:
            scheduler.stop(timeout=5)

    def sink(self, measurement):
        with self.lock:
            self.sunk.append(measurement)

    def make(self, targets, **kwargs):
        scheduler = ProbeScheduler(targets, sink=kwargs.pop("sink", self.sink), **kwargs)
        self.schedulers.append(scheduler)
        return scheduler


class IntervalTests(SchedulerTestCase):
    def test_per_target_intervals_are_respected(self):
        fast, slow = make_target(0.1), make_target(0.4)
        scheduler = self.make([fast, slow], probe_fn=lambda _t: OK)
        scheduler.start()
        time.sleep(1.05)
        scheduler.stop()
        counts = Counter(m["target_id"] for m in self.sunk)
        self.assertGreaterEqual(counts[str(fast.id)], 8)
        self.assertLessEqual(counts[str(fast.id)], 12)
        self.assertGreaterEqual(counts[str(slow.id)], 2)
        self.assertLessEqual(counts[str(slow.id)], 4)

    def test_disabled_targets_are_not_probed(self):
        enabled, disabled = make_target(0.1), make_target(0.1, enabled=False)
        scheduler = self.make([enabled, disabled], probe_fn=lambda _t: OK)
        scheduler.start()
        time.sleep(0.25)
        scheduler.stop()
        self.assertTrue(self.sunk)
        self.assertNotIn(str(disabled.id), {m["target_id"] for m in self.sunk})

    def test_each_measurement_has_a_unique_stable_id(self):
        scheduler = self.make([make_target(0.05)], probe_fn=lambda _t: OK)
        scheduler.start()
        time.sleep(0.3)
        scheduler.stop()
        ids = [m["measurement_id"] for m in self.sunk]
        self.assertEqual(len(ids), len(set(ids)))

    def test_idle_scheduler_does_not_busy_loop(self):
        scheduler = self.make([make_target(1000)], probe_fn=lambda _t: OK)
        calls = {"n": 0}
        original = scheduler._dispatch_due

        def counting():
            calls["n"] += 1
            return original()

        scheduler._dispatch_due = counting
        scheduler.start()
        time.sleep(0.5)
        scheduler.stop()
        self.assertLessEqual(calls["n"], 3)


class SlowProbeTests(SchedulerTestCase):
    def test_slow_probe_never_overlaps_itself(self):
        active = {"now": 0, "max": 0}

        def slow(_target):
            with self.lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.3)
            with self.lock:
                active["now"] -= 1
            return OK

        scheduler = self.make([make_target(0.05)], probe_fn=slow)
        scheduler.start()
        time.sleep(1.0)
        scheduler.stop()
        self.assertEqual(active["max"], 1)
        self.assertLessEqual(len(self.sunk), 4)

    def test_concurrency_and_threads_are_bounded(self):
        active = {"now": 0, "max": 0}

        def slow(_target):
            with self.lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.15)
            with self.lock:
                active["now"] -= 1
            return OK

        scheduler = self.make([make_target(0.05) for _ in range(8)], probe_fn=slow, max_workers=2)
        scheduler.start()
        time.sleep(0.6)
        workers = [t for t in threading.enumerate() if t.name.startswith("sentinel-probe_")]
        began = time.monotonic()
        self.assertTrue(scheduler.stop(timeout=5))
        # Queued (cancelled) probes must not make shutdown wait for the timeout.
        self.assertLess(time.monotonic() - began, 1.0)
        self.assertLessEqual(active["max"], 2)
        self.assertLessEqual(len(workers), 2)
        self.assertGreaterEqual(len(self.sunk), 4)

    def test_failing_probes_do_not_stop_scheduler(self):
        calls = {"n": 0}

        def boom(_target):
            calls["n"] += 1
            raise RuntimeError("probe crashed")

        scheduler = self.make([make_target(0.1)], probe_fn=boom)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            scheduler.start()
            time.sleep(0.45)
            scheduler.stop()
        self.assertGreaterEqual(calls["n"], 3)
        self.assertEqual(self.sunk, [])

    def test_sink_failure_is_logged_and_scheduler_continues(self):
        calls = {"n": 0}

        def bad_sink(_measurement):
            calls["n"] += 1
            raise OSError("disk full")

        scheduler = self.make([make_target(0.1)], probe_fn=lambda _t: OK, sink=bad_sink)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            scheduler.start()
            time.sleep(0.35)
            scheduler.stop()
        self.assertGreaterEqual(calls["n"], 2)
        self.assertIn("could not be stored", "\n".join(logs.output))


class ShutdownTests(SchedulerTestCase):
    def test_stop_interrupts_multi_attempt_probe(self):
        started = threading.Event()

        def slow_attempt(host, port, *, timeout_seconds):
            started.set()
            time.sleep(0.2)
            return ProbeAttempt(True, 1.0, "")

        with patch("agent.network_probe.probe_tcp", side_effect=slow_attempt):
            scheduler = self.make([make_target(60, probe_count=20)])
            scheduler.start()
            self.assertTrue(started.wait(2))
            began = time.monotonic()
            finished = scheduler.stop(timeout=5)
            elapsed = time.monotonic() - began
        self.assertTrue(finished)
        self.assertLess(elapsed, 1.0)
        self.assertEqual(self.sunk, [])  # cancelled probe yields no partial result
        for thread in threading.enumerate():
            if thread.name.startswith("sentinel-probe"):
                thread.join(1)
        alive = [t for t in threading.enumerate() if t.name.startswith("sentinel-probe")]
        self.assertEqual(alive, [])

    def test_run_once_probes_every_enabled_target(self):
        targets = [make_target(60), make_target(60), make_target(60, enabled=False)]
        scheduler = self.make(targets, probe_fn=lambda _t: OK)
        self.assertEqual(scheduler.run_once(timeout=5), 2)
        self.assertEqual(len(self.sunk), 2)


if __name__ == "__main__":
    unittest.main()

import threading
import time
import unittest
from collections import Counter
from unittest.mock import patch
from uuid import uuid4

from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeAttempt, ProbeResult
from agent.probe_scheduler import ProbeScheduler
from agent.tests.timing import DeferredExecutor, LogWatcher, ManualClock, Tally, prime

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
        clock = ManualClock()
        fast, slow = make_target(0.25), make_target(1.0)
        scheduler = self.make([fast, slow], probe_fn=lambda _t: OK, time_fn=clock)
        prime(scheduler, [fast.id, slow.id], clock)
        start = clock()
        for step in range(33):  # four seconds in eighth-second steps (exact in binary floating point)
            clock.now = start + step * 0.125
            scheduler._dispatch_due()
        counts = Counter(m["target_id"] for m in self.sunk)
        self.assertEqual(counts[str(fast.id)], 17)  # every 0.25 s, first probe included
        self.assertEqual(counts[str(slow.id)], 5)

    def test_slots_missed_during_a_stall_are_skipped_not_replayed(self):
        clock = ManualClock()
        target = make_target(0.25)
        scheduler = self.make([target], probe_fn=lambda _t: OK, time_fn=clock)
        prime(scheduler, [target.id], clock)
        scheduler._dispatch_due()
        clock.now += 10.0  # forty intervals pass without a dispatch
        scheduler._dispatch_due()
        scheduler._dispatch_due()  # still inside the interval that follows the stall
        self.assertEqual(len(self.sunk), 2)
        clock.now += 0.25
        scheduler._dispatch_due()
        self.assertEqual(len(self.sunk), 3)

    def test_disabled_targets_are_not_probed(self):
        enabled, disabled = make_target(0.1), make_target(0.1, enabled=False)
        probed = Tally()

        def probe(_target):
            probed.increment()
            return OK

        scheduler = self.make([enabled, disabled], probe_fn=probe)
        scheduler.start()
        self.assertTrue(probed.wait_for(2))
        scheduler.stop()
        self.assertTrue(self.sunk)
        self.assertNotIn(str(disabled.id), {m["target_id"] for m in self.sunk})

    def test_each_measurement_has_a_unique_stable_id(self):
        probed = Tally()

        def probe(_target):
            probed.increment()
            return OK

        scheduler = self.make([make_target(0.01)], probe_fn=probe)
        scheduler.start()
        self.assertTrue(probed.wait_for(5))
        scheduler.stop()
        ids = [m["measurement_id"] for m in self.sunk]
        self.assertGreaterEqual(len(ids), 4)
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
        started = Tally()

        def slow(_target):
            with self.lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            started.increment()
            time.sleep(0.1)
            with self.lock:
                active["now"] -= 1
            return OK

        scheduler = self.make([make_target(0.01)], probe_fn=slow)  # due again long before each probe ends
        scheduler.start()
        self.assertTrue(started.wait_for(3))
        scheduler.stop()
        self.assertEqual(active["max"], 1)

    def test_a_busy_target_is_not_dispatched_again_and_the_slots_it_overran_are_skipped(self):
        clock = ManualClock()
        executor = DeferredExecutor()
        target = make_target(0.25)
        scheduler = self.make([target], probe_fn=lambda _t: OK, time_fn=clock)
        prime(scheduler, [target.id], clock, executor)
        scheduler._dispatch_due()  # the first probe is now in flight
        clock.now += 2.0  # eight intervals pass while it is still running
        scheduler._dispatch_due()
        self.assertEqual(len(executor.pending), 1)  # nothing new for a target that is busy
        executor.run_next()  # the first probe finishes
        scheduler._dispatch_due()
        self.assertEqual(len(executor.pending), 1)  # one probe follows, not eight
        executor.run_next()
        scheduler._dispatch_due()
        self.assertEqual(executor.pending, [])  # the next one waits for its interval
        self.assertEqual(len(self.sunk), 2)

    def test_concurrency_and_threads_are_bounded(self):
        active = {"now": 0, "max": 0}
        finished = Tally()

        def slow(_target):
            with self.lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.05)
            with self.lock:
                active["now"] -= 1
            finished.increment()
            return OK

        scheduler = self.make([make_target(0.01) for _ in range(8)], probe_fn=slow, max_workers=2)
        scheduler.start()
        self.assertTrue(finished.wait_for(6))  # three times as many probes as workers have run
        workers = [t for t in threading.enumerate() if t.name.startswith("sentinel-probe_")]
        began = time.monotonic()
        self.assertTrue(scheduler.stop(timeout=5))
        # Queued (cancelled) probes must not make shutdown wait for the timeout.
        self.assertLess(time.monotonic() - began, 1.0)
        self.assertLessEqual(active["max"], 2)
        self.assertLessEqual(len(workers), 2)
        self.assertGreaterEqual(len(self.sunk), 4)

    def test_failing_probes_do_not_stop_scheduler(self):
        calls = Tally()

        def boom(_target):
            calls.increment()
            raise RuntimeError("probe crashed")

        scheduler = self.make([make_target(0.01)], probe_fn=boom)
        with LogWatcher() as logs:
            scheduler.start()
            self.assertTrue(calls.wait_for(3))  # still scheduled after each crash
            scheduler.stop()
        self.assertIn("probe crashed", "\n".join(logs.messages))
        self.assertEqual(self.sunk, [])

    def test_sink_failure_is_logged_and_scheduler_continues(self):
        calls = Tally()

        def bad_sink(_measurement):
            calls.increment()
            raise OSError("disk full")

        scheduler = self.make([make_target(0.01)], probe_fn=lambda _t: OK, sink=bad_sink)
        with LogWatcher() as logs:
            scheduler.start()
            self.assertTrue(calls.wait_for(3))  # probing continues after each failed store
            scheduler.stop()
        self.assertIn("could not be stored", "\n".join(logs.messages))


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

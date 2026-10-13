import random
import threading
import time
import unittest
import uuid
from collections import Counter

from agent.snmp_fetch import SnmpFetchCancelled
from agent.snmp_scheduler import MAX_CONCURRENT_POLLS, MAX_START_JITTER_SECONDS, SnmpScheduler
from agent.tests.snmp_helpers import device
from agent.tests.timing import WAIT_SECONDS, DeferredExecutor, LogWatcher, ManualClock, Tally, prime


class StubPoller:
    """Stands in for DevicePoller: records calls, optionally slow or failing."""

    def __init__(self, interval=0.1, *, enabled=True, delay=0.0, error=None, tracker=None, hold=False):
        self.device = device(id=uuid.uuid4(), poll_interval_seconds=interval, enabled=enabled)
        self.delay = delay
        self.error = error
        self.tracker = tracker
        self.hold = hold  # the poll runs until the scheduler is stopped
        self._calls = Tally()
        self.entered = threading.Event()
        self.cancelled = threading.Event()

    @property
    def calls(self):
        return self._calls.value

    def wait_for_calls(self, minimum):
        return self._calls.wait_for(minimum)

    def poll(self, cancel=None):
        self._calls.increment()
        self.entered.set()
        if self.tracker:
            self.tracker.enter()
        try:
            if self.hold:
                cancel.wait(WAIT_SECONDS)
                self.cancelled.set()
                raise SnmpFetchCancelled("stopping")
            if self.delay:
                deadline = time.monotonic() + self.delay
                while time.monotonic() < deadline:
                    if cancel is not None and cancel.is_set():
                        self.cancelled.set()
                        raise SnmpFetchCancelled("stopping")
                    time.sleep(0.01)
            if self.error:
                raise self.error
            return {"poll_id": str(uuid.uuid4()), "device_id": str(self.device.id), "reachable": True}
        finally:
            if self.tracker:
                self.tracker.leave()


class Concurrency:
    def __init__(self):
        self.lock = threading.Lock()
        self.now = 0
        self.max = 0
        self.entries = Tally()

    def enter(self):
        with self.lock:
            self.now += 1
            self.max = max(self.max, self.now)
        self.entries.increment()

    def leave(self):
        with self.lock:
            self.now -= 1


class SchedulerTestCase(unittest.TestCase):
    def setUp(self):
        self.sunk = []
        self.lock = threading.Lock()
        self.schedulers = []

    def tearDown(self):
        for scheduler in self.schedulers:
            scheduler.stop(timeout=5)

    def sink(self, poll):
        with self.lock:
            self.sunk.append(poll)

    def make(self, pollers, **kwargs):
        kwargs.setdefault("rng", random.Random(1))
        scheduler = SnmpScheduler(pollers, sink=kwargs.pop("sink", self.sink), **kwargs)
        self.schedulers.append(scheduler)
        return scheduler


class IntervalTests(SchedulerTestCase):
    def test_per_device_intervals_are_respected(self):
        clock = ManualClock()
        fast, slow = StubPoller(0.25), StubPoller(1.0)
        scheduler = self.make([fast, slow], time_fn=clock)
        prime(scheduler, [fast.device.id, slow.device.id], clock)
        start = clock()
        for step in range(33):  # four seconds in eighth-second steps (exact in binary floating point)
            clock.now = start + step * 0.125
            scheduler._dispatch_due()
        counts = Counter(p["device_id"] for p in self.sunk)
        self.assertEqual(counts[str(fast.device.id)], 17)  # every 0.25 s, first poll included
        self.assertEqual(counts[str(slow.device.id)], 5)

    def test_slots_missed_during_a_stall_are_skipped_not_replayed(self):
        clock = ManualClock()
        poller = StubPoller(0.25)
        scheduler = self.make([poller], time_fn=clock)
        prime(scheduler, [poller.device.id], clock)
        scheduler._dispatch_due()
        clock.now += 10.0  # forty intervals pass without a dispatch
        scheduler._dispatch_due()
        scheduler._dispatch_due()  # still inside the interval that follows the stall
        self.assertEqual(poller.calls, 2)
        clock.now += 0.25
        scheduler._dispatch_due()
        self.assertEqual(poller.calls, 3)

    def test_disabled_devices_are_not_polled(self):
        enabled, disabled = StubPoller(0.1), StubPoller(0.1, enabled=False)
        scheduler = self.make([enabled, disabled])
        self.assertEqual(scheduler.device_count, 1)
        scheduler.start()
        self.assertTrue(enabled.wait_for_calls(1))
        scheduler.stop()
        self.assertTrue(self.sunk)
        self.assertEqual(disabled.calls, 0)

    def test_no_devices_means_nothing_runs(self):
        scheduler = self.make([StubPoller(enabled=False)])
        self.assertFalse(scheduler.has_devices)
        scheduler.start()  # no-op
        self.assertEqual(scheduler.run_once(), 0)
        self.assertTrue(scheduler.stop())

    def test_first_polls_are_spread_by_jitter(self):
        clock = ManualClock()
        pollers = [StubPoller(1000) for _ in range(200)]
        scheduler = self.make(pollers, rng=random.Random(7), time_fn=clock)
        scheduler.start()
        due = sorted(scheduler._next_due.values())
        self.assertTrue(all(0 <= value - clock() <= MAX_START_JITTER_SECONDS for value in due))
        self.assertGreater(due[-1] - due[0], 20)  # spread out, not all at the same instant
        scheduler.stop()

    def test_a_small_deployment_starts_promptly(self):
        clock = ManualClock()
        scheduler = self.make([StubPoller(1000), StubPoller(1000)], rng=random.Random(7), time_fn=clock)
        scheduler.start()
        self.assertTrue(all(0 <= value - clock() <= 1.0 for value in scheduler._next_due.values()))
        scheduler.stop()

    def test_jitter_never_exceeds_the_devices_own_interval(self):
        clock = ManualClock()
        scheduler = self.make([StubPoller(2)], rng=random.Random(3), time_fn=clock)
        scheduler.start()
        (due,) = scheduler._next_due.values()
        self.assertLessEqual(due - clock(), 2.0)
        scheduler.stop()

    def test_idle_scheduler_does_not_busy_loop(self):
        scheduler = self.make([StubPoller(1000)], rng=random.Random(0))
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


class BoundedConcurrencyTests(SchedulerTestCase):
    def test_at_most_max_workers_polls_run_at_once(self):
        tracker = Concurrency()
        pollers = [StubPoller(0.05, delay=0.2, tracker=tracker) for _ in range(10)]
        scheduler = self.make(pollers, max_workers=3)
        scheduler.start()
        self.assertTrue(tracker.entries.wait_for(10))  # many more polls than workers have started
        scheduler.stop()
        self.assertEqual(tracker.max, 3)

    def test_worker_count_is_clamped(self):
        self.assertEqual(self.make([StubPoller()], max_workers=0).max_workers, 1)
        self.assertEqual(self.make([StubPoller()], max_workers=500).max_workers, MAX_CONCURRENT_POLLS)

    def test_a_slow_device_never_overlaps_itself(self):
        tracker = Concurrency()
        slow = StubPoller(0.01, delay=0.1, tracker=tracker)  # due again long before each poll ends
        scheduler = self.make([slow])
        scheduler.start()
        self.assertTrue(slow.wait_for_calls(3))
        scheduler.stop()
        self.assertEqual(tracker.max, 1)

    def test_a_busy_device_is_not_dispatched_again_and_the_slots_it_overran_are_skipped(self):
        clock = ManualClock()
        executor = DeferredExecutor()
        poller = StubPoller(0.25)
        scheduler = self.make([poller], time_fn=clock)
        prime(scheduler, [poller.device.id], clock, executor)
        scheduler._dispatch_due()  # the first poll is now in flight
        clock.now += 2.0  # eight intervals pass while it is still running
        scheduler._dispatch_due()
        self.assertEqual(len(executor.pending), 1)  # nothing new for a device that is busy
        executor.run_next()  # the first poll finishes
        scheduler._dispatch_due()
        self.assertEqual(len(executor.pending), 1)  # one poll follows, not eight
        executor.run_next()
        scheduler._dispatch_due()
        self.assertEqual(executor.pending, [])  # the next one waits for its interval
        self.assertEqual(poller.calls, 2)

    def test_slow_devices_do_not_starve_fast_ones(self):
        slow = [StubPoller(0.05, hold=True) for _ in range(2)]  # never finish while the test runs
        fast = StubPoller(0.01)
        scheduler = self.make([*slow, fast], max_workers=3)
        scheduler.start()
        for poller in slow:
            self.assertTrue(poller.entered.wait(WAIT_SECONDS))
        # Both slow devices now occupy two of the three workers; the fast one keeps being polled.
        baseline = fast.calls
        self.assertTrue(fast.wait_for_calls(baseline + 5))
        self.assertEqual([poller.calls for poller in slow], [1, 1])  # no second poll: they never overlap themselves
        scheduler.stop()
        self.assertTrue(all(poller.cancelled.is_set() for poller in slow))


class FailureIsolationTests(SchedulerTestCase):
    def test_a_failing_poller_is_logged_and_does_not_affect_the_others(self):
        bad = StubPoller(0.01, error=RuntimeError("boom"))
        good = StubPoller(0.01)
        scheduler = self.make([bad, good])
        with LogWatcher() as logs:
            scheduler.start()
            self.assertTrue(good.wait_for_calls(3))
            self.assertTrue(bad.wait_for_calls(2))  # it keeps being retried each interval
            scheduler.stop()
        self.assertIn("boom", "\n".join(logs.messages))
        self.assertTrue(self.sunk)
        self.assertTrue(all(p["device_id"] == str(good.device.id) for p in self.sunk))

    def test_a_failing_sink_is_logged_and_polling_continues(self):
        calls = Tally()

        def sink(_poll):
            calls.increment()
            raise OSError("disk full")

        poller = StubPoller(0.01)
        scheduler = self.make([poller], sink=sink)
        with LogWatcher() as logs:
            scheduler.start()
            self.assertTrue(calls.wait_for(3))  # polling continues after each failed store
            scheduler.stop()
        self.assertIn("could not be stored", "\n".join(logs.messages))


class ShutdownTests(SchedulerTestCase):
    def test_stop_cancels_running_polls_promptly(self):
        slow = StubPoller(0.05, hold=True)
        scheduler = self.make([slow])
        scheduler.start()
        self.assertTrue(slow.entered.wait(WAIT_SECONDS))
        started = time.monotonic()
        self.assertTrue(scheduler.stop(timeout=5))
        self.assertLess(time.monotonic() - started, 2)
        self.assertTrue(slow.cancelled.is_set())
        self.assertEqual(self.sunk, [])  # a cancelled poll is not reported as a failure

    def test_stop_before_start_is_harmless(self):
        scheduler = self.make([StubPoller()])
        self.assertTrue(scheduler.stop(timeout=1))


class RunOnceTests(SchedulerTestCase):
    def test_polls_each_enabled_device_once(self):
        pollers = [StubPoller(1000) for _ in range(5)]
        scheduler = self.make([*pollers, StubPoller(1000, enabled=False)], max_workers=2)
        self.assertEqual(scheduler.run_once(), 5)
        self.assertEqual([p.calls for p in pollers], [1] * 5)
        self.assertEqual(len(self.sunk), 5)

    def test_run_once_respects_the_concurrency_bound(self):
        tracker = Concurrency()
        pollers = [StubPoller(1000, delay=0.05, tracker=tracker) for _ in range(8)]
        scheduler = self.make(pollers, max_workers=2)
        scheduler.run_once()
        self.assertEqual(tracker.max, 2)

    def test_run_once_with_a_timeout_cancels_the_rest(self):
        pollers = [StubPoller(1000, delay=30) for _ in range(2)]
        scheduler = self.make(pollers, max_workers=2)
        started = time.monotonic()
        scheduler.run_once(timeout=0.2)
        self.assertLess(time.monotonic() - started, 3)
        self.assertTrue(all(p.cancelled.is_set() for p in pollers))


if __name__ == "__main__":
    unittest.main()

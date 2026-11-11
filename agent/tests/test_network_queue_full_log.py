"""A full network queue says so once a minute, not once for every measurement it drops.

During a long server outage every probe result pushes the oldest one out, so a warning per drop is a warning
per probe for as long as the outage lasts. The SNMP half of the queue already reports this way.
"""

import logging
import unittest

from agent.measurement_queue import MeasurementQueue
from agent.tests.queue_helpers import Clock, measurement


class NetworkQueueFullLogTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.queue = MeasurementQueue(None, max_measurements=2, wall_fn=self.clock)
        self.addCleanup(self.queue.close)

    def enqueue(self, count):
        for _ in range(count):
            self.queue.enqueue(measurement())

    def test_drops_are_reported_once_a_minute_with_the_count_since_the_last_report(self):
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self.enqueue(2 + 5)  # five over the limit: five drops, one after the other
            self.clock.now += 61
            self.enqueue(1)
        full = [record.getMessage() for record in logs.records if "queue full" in record.getMessage()]
        self.assertEqual(len(full), 2, full)
        self.assertIn("dropped 1 oldest measurement(s)", full[0])
        self.assertIn("dropped 5 oldest measurement(s)", full[1])  # the four kept quiet, and this one


class LockWatchingQueue(MeasurementQueue):
    """A queue that notes each change of the drop counters made while the queue lock is not held."""

    def __init__(self, *args, **kwargs):
        self.unlocked_changes = []
        super().__init__(*args, **kwargs)

    def _watched(self, name, value):
        lock = self.__dict__.get("_lock")
        if lock is not None and not lock.locked():
            self.unlocked_changes.append(name)
        self.__dict__[name] = value

    @property
    def _network_dropped_unreported(self):
        return self.__dict__["_network_dropped_unreported"]

    @_network_dropped_unreported.setter
    def _network_dropped_unreported(self, value):
        self._watched("_network_dropped_unreported", value)

    @property
    def _network_drop_logged_at(self):
        return self.__dict__["_network_drop_logged_at"]

    @_network_drop_logged_at.setter
    def _network_drop_logged_at(self, value):
        self._watched("_network_drop_logged_at", value)


class LockStateHandler(logging.Handler):
    """Notes whether the queue lock was held while each "queue full" line was logged."""

    def __init__(self, queue_lock):
        super().__init__()
        self.queue_lock = queue_lock  # not ``lock``: that is the handler's own, held while it emits
        self.held = []

    def emit(self, record):
        if "queue full" in record.getMessage():
            self.held.append(self.queue_lock.locked())


class NetworkQueueDropCountersLockTests(unittest.TestCase):
    """The counters behind the once-a-minute report are shared by the probe threads (one per target) that
    enqueue, so they are read and written under the queue lock: no drop is lost between two threads, and
    the minute is judged once. The line itself is logged outside the lock, where nothing waits on it."""

    def test_the_counters_change_only_under_the_lock_and_the_line_is_logged_outside_it(self):
        queue = LockWatchingQueue(None, max_measurements=1, wall_fn=Clock())
        self.addCleanup(queue.close)
        handler = LockStateHandler(queue._lock)
        logger = logging.getLogger("sentinel_agent")
        logger.addHandler(handler)
        self.addCleanup(logger.removeHandler, handler)
        propagate, logger.propagate = logger.propagate, False  # the line stays out of the test output
        self.addCleanup(setattr, logger, "propagate", propagate)
        for _ in range(3):  # fills the queue, then drops one (reported) and one more (counted, kept quiet)
            queue.enqueue(measurement())
        self.assertEqual(queue.unlocked_changes, [])
        self.assertEqual(handler.held, [False])

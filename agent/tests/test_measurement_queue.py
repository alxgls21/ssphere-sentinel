import os
import sqlite3
import stat
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

from agent.measurement_queue import (
    MAX_ITEM_ATTEMPTS,
    RETRY_BASE_SECONDS,
    MeasurementQueue,
    QueueError,
    QueueStorageError,
    validate_queue_path,
)


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


class PersistenceTests(QueueTestCase):
    def test_measurements_survive_restart(self):
        first = self.open_queue()
        items = [measurement() for _ in range(3)]
        for item in items:
            self.assertTrue(first.enqueue(item))
        first.close()

        reopened = self.open_queue()
        self.assertTrue(reopened.persistent)
        batch = reopened.pending_batch(10)
        self.assertEqual([m["measurement_id"] for m in batch], [m["measurement_id"] for m in items])
        self.assertEqual(batch[0], items[0])

    def test_retry_state_survives_restart(self):
        first = self.open_queue()
        item = measurement()
        first.enqueue(item)
        first.mark_retry([item["measurement_id"]])
        first.close()

        reopened = self.open_queue()
        self.assertEqual(reopened.attempts(item["measurement_id"]), 1)
        self.assertEqual(reopened.pending_batch(10), [])
        self.clock.now += RETRY_BASE_SECONDS + 1
        self.assertEqual(len(reopened.pending_batch(10)), 1)

    def test_enqueue_is_idempotent_for_same_id(self):
        queue = self.open_queue()
        item = measurement()
        self.assertTrue(queue.enqueue(item))
        self.assertFalse(queue.enqueue(dict(item)))
        self.assertEqual(queue.count(), 1)

    def test_remove_only_named_ids(self):
        queue = self.open_queue()
        keep, drop = measurement(), measurement()
        queue.enqueue(keep)
        queue.enqueue(drop)
        self.assertEqual(queue.remove([drop["measurement_id"], str(uuid.uuid4())]), 1)
        self.assertEqual(
            [m["measurement_id"] for m in queue.pending_batch(10)], [keep["measurement_id"]]
        )

    def test_batch_is_oldest_first_and_limited(self):
        queue = self.open_queue()
        ids = []
        for _ in range(5):
            item = measurement()
            ids.append(item["measurement_id"])
            queue.enqueue(item)
            self.clock.now += 1
        self.assertEqual([m["measurement_id"] for m in queue.pending_batch(3)], ids[:3])

    def test_clock_moving_backwards_does_not_stall_retries(self):
        queue = self.open_queue()
        item = measurement()
        queue.enqueue(item)
        queue.mark_retry([item["measurement_id"]])
        self.clock.now -= 10 * 24 * 3600
        self.assertEqual(len(queue.pending_batch(10)), 1)


class BoundsTests(QueueTestCase):
    def test_overflow_drops_oldest(self):
        queue = self.open_queue(max_measurements=3)
        ids = []
        for _ in range(5):
            item = measurement()
            ids.append(item["measurement_id"])
            queue.enqueue(item)
            self.clock.now += 1
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            extra = measurement()
            queue.enqueue(extra)
        self.assertEqual(queue.count(), 3)
        remaining = [m["measurement_id"] for m in queue.pending_batch(10)]
        self.assertEqual(remaining, ids[3:] + [extra["measurement_id"]])
        self.assertIn("dropped 1 oldest", "\n".join(logs.output))

    def test_expired_measurements_are_purged_with_warning(self):
        queue = self.open_queue(max_age_seconds=3600)
        old = measurement()
        queue.enqueue(old)
        self.clock.now += 1800
        fresh = measurement()
        queue.enqueue(fresh)
        self.clock.now += 1801
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.assertEqual(queue.purge_expired(), 1)
        self.assertEqual(
            [m["measurement_id"] for m in queue.pending_batch(10)], [fresh["measurement_id"]]
        )

    def test_retries_are_bounded(self):
        queue = self.open_queue()
        item = measurement()
        queue.enqueue(item)
        for _ in range(MAX_ITEM_ATTEMPTS - 1):
            outcome = queue.mark_retry([item["measurement_id"]])
            self.assertEqual(outcome.rescheduled, 1)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            outcome = queue.mark_retry([item["measurement_id"]])
        self.assertEqual(outcome.dropped, 1)
        self.assertEqual(queue.count(), 0)

    def test_oversized_payload_rejected(self):
        queue = self.open_queue()
        with self.assertRaises(QueueError):
            queue.enqueue(measurement(failure_reason="x" * 5000))
        self.assertEqual(queue.count(), 0)

    def test_invalid_measurement_id_rejected(self):
        queue = self.open_queue()
        with self.assertRaises(QueueError):
            queue.enqueue(measurement(measurement_id="nope"))


class SecurityTests(QueueTestCase):
    def test_file_and_directory_permissions(self):
        self.open_queue().enqueue(measurement())
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.path.parent).st_mode), 0o700)
        for sidecar in self.path.parent.iterdir():
            self.assertEqual(stat.S_IMODE(os.stat(sidecar).st_mode) & 0o077, 0, sidecar.name)

    def test_broad_existing_file_permissions_are_restricted(self):
        self.path.parent.mkdir(mode=0o700)
        self.path.touch()
        os.chmod(self.path, 0o644)
        self.open_queue()
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def test_only_whitelisted_fields_and_no_token_persisted(self):
        queue = self.open_queue()
        item = measurement(token="super-secret-agent-token", hostname_or_ip="10.0.0.1")
        queue.enqueue(item)
        queue.close()
        raw = b"".join(p.read_bytes() for p in self.path.parent.iterdir())
        self.assertNotIn(b"super-secret-agent-token", raw)
        self.assertNotIn(b"10.0.0.1", raw)
        reopened = self.open_queue()
        stored = reopened.pending_batch(1)[0]
        self.assertNotIn("token", stored)
        self.assertNotIn("hostname_or_ip", stored)

    def test_symlinked_queue_file_is_refused(self):
        self.path.parent.mkdir(mode=0o700)
        victim = self.dir / "victim.txt"
        victim.write_text("do not touch")
        self.path.symlink_to(victim)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            queue = self.open_queue()
        self.assertFalse(queue.persistent)
        self.assertIn("symlink", "\n".join(logs.output))
        self.assertEqual(victim.read_text(), "do not touch")

    def test_symlinked_sidecar_is_refused(self):
        self.path.parent.mkdir(mode=0o700)
        victim = self.dir / "victim.txt"
        victim.write_text("do not touch")
        Path(str(self.path) + "-wal").symlink_to(victim)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            queue = self.open_queue()
        self.assertFalse(queue.persistent)
        self.assertEqual(victim.read_text(), "do not touch")

    def test_group_writable_directory_is_refused(self):
        self.path.parent.mkdir()
        os.chmod(self.path.parent, 0o777)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            queue = self.open_queue()
        self.assertFalse(queue.persistent)
        self.assertIn("writable by group or others", "\n".join(logs.output))
        self.assertFalse(self.path.exists())

    def test_path_validation(self):
        for bad in ("relative/queue.db", "/tmp/../etc/queue.db", ""):
            with self.subTest(path=bad), self.assertRaises(QueueStorageError):
                validate_queue_path(bad)
        self.assertEqual(validate_queue_path("/a/b.db"), Path("/a/b.db"))

    def test_unusable_location_falls_back_to_memory(self):
        blocker = self.dir / "file"
        blocker.write_text("x")
        with self.assertLogs("sentinel_agent", level="WARNING"):
            queue = self.open_queue(path=blocker / "queue.sqlite3")
        self.assertFalse(queue.persistent)
        self.assertTrue(queue.enqueue(measurement()))
        self.assertEqual(queue.count(), 1)


class CorruptionTests(QueueTestCase):
    def test_corrupted_file_is_quarantined_and_replaced(self):
        self.path.parent.mkdir(mode=0o700)
        self.path.write_bytes(b"this is not a sqlite database" * 100)
        os.chmod(self.path, 0o600)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            queue = self.open_queue()
        self.assertTrue(queue.persistent)
        self.assertTrue(queue.enqueue(measurement()))
        quarantined = [p for p in self.path.parent.iterdir() if ".corrupt-" in p.name]
        self.assertEqual(len(quarantined), 1)
        self.assertIn("Corrupted network queue moved", "\n".join(logs.output))

    def test_corruption_detected_at_runtime_recovers(self):
        queue = self.open_queue()
        queue.enqueue(measurement())

        class BrokenConnection:
            def execute(self, *args, **kwargs):
                raise sqlite3.DatabaseError("database disk image is malformed")

            def close(self):
                pass

        queue._conn = BrokenConnection()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            with self.assertRaises(QueueError):
                queue.enqueue(measurement())
        self.assertTrue(queue.enqueue(measurement()))
        self.assertEqual(queue.count(), 1)

    def test_newer_schema_is_left_untouched(self):
        self.path.parent.mkdir(mode=0o700)
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA user_version = 99")
        conn.close()
        os.chmod(self.path, 0o600)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            queue = self.open_queue()
        self.assertFalse(queue.persistent)
        conn = sqlite3.connect(self.path)
        self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 99)
        conn.close()


class ConcurrencyTests(QueueTestCase):
    def test_concurrent_threads_and_connections(self):
        first = self.open_queue()
        second = self.open_queue()  # separate connection, like a second process
        errors = []

        def producer(queue, count):
            try:
                for _ in range(count):
                    queue.enqueue(measurement())
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def consumer(queue):
            try:
                for _ in range(20):
                    batch = queue.pending_batch(10)
                    queue.remove(m["measurement_id"] for m in batch[:2])
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=producer, args=(first, 50)),
            threading.Thread(target=producer, args=(first, 50)),
            threading.Thread(target=producer, args=(second, 50)),
            threading.Thread(target=consumer, args=(second,)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertEqual(errors, [])
        total = first.count()
        self.assertEqual(total, second.count())
        self.assertGreaterEqual(total, 150 - 40)
        self.assertLessEqual(total, 150)


if __name__ == "__main__":
    unittest.main()

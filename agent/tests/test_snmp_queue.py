import json
import sqlite3
import unittest
import uuid

from agent.measurement_queue import (
    MAX_ITEM_ATTEMPTS,
    RETRY_BASE_SECONDS,
    MeasurementQueue,
    QueueError,
)
from agent.snmp_payload import MAX_POLL_PAYLOAD_BYTES, SnmpPayloadError, sanitize_poll
from agent.tests.queue_helpers import QueueTestCase, measurement, poll
from agent.tests.snmp_helpers import SECRET

LIMITS = {"max_polls": 50, "max_interfaces": 2000, "max_bytes": 1_000_000}


class SanitizerTests(unittest.TestCase):
    def test_only_whitelisted_fields_survive_at_every_level(self):
        dirty = poll(community=SECRET, auth_key=SECRET, system={"name": "x", "community": SECRET})
        dirty["interfaces"][0]["password"] = SECRET
        dirty["interfaces"][0]["counters"]["token"] = SECRET
        dirty["interfaces"][0]["counters"]["raw"]["priv_key"] = SECRET
        dirty["interfaces"][0]["counters"]["delta"] = {"in_octets": 5, "secret": SECRET}
        _id, payload, count = sanitize_poll(dirty)
        self.assertNotIn(SECRET, payload)
        self.assertEqual(count, 2)
        cleaned = json.loads(payload)
        self.assertEqual(cleaned["system"], {"name": "x"})
        self.assertEqual(cleaned["interfaces"][0]["counters"]["delta"], {"in_octets": 5})

    def test_ids_must_be_uuids_and_are_normalised(self):
        upper = str(uuid.uuid4()).upper()
        poll_id, payload, _count = sanitize_poll(poll(poll_id=upper))
        self.assertEqual(poll_id, upper.lower())
        for bad in ("nope", None, 5):
            with self.subTest(bad), self.assertRaises(SnmpPayloadError):
                sanitize_poll(poll(poll_id=bad))
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(device_id="nope"))

    def test_shapes_and_limits(self):
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll([])
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(interfaces="x"))
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(interfaces=["x"]))
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(513))
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(0, system={"descr": "x" * (MAX_POLL_PAYLOAD_BYTES + 1)}))
        with self.assertRaises(SnmpPayloadError):
            sanitize_poll(poll(response_ms=float("nan")))

    def test_an_unreachable_poll_is_valid(self):
        _id, payload, count = sanitize_poll(
            {
                "poll_id": str(uuid.uuid4()),
                "device_id": str(uuid.uuid4()),
                "measured_at": "2026-10-12T14:05:00+00:00",
                "reachable": False,
                "error": "timeout",
            }
        )
        self.assertEqual((json.loads(payload)["error"], count), ("timeout", 0))


class PersistenceTests(QueueTestCase):
    def test_polls_survive_a_restart_and_are_idempotent(self):
        first = self.open_queue()
        item = poll()
        self.assertTrue(first.enqueue_snmp(item))
        self.assertFalse(first.enqueue_snmp(item))
        first.close()
        second = self.open_queue()
        batch = second.pending_snmp_batch(**LIMITS)
        self.assertEqual([p["poll_id"] for p in batch], [item["poll_id"]])
        self.assertEqual(second.snmp_count(), 1)

    def test_oldest_first(self):
        queue = self.open_queue()
        items = [poll() for _ in range(5)]
        for item in items:
            queue.enqueue_snmp(item)
        self.assertEqual([p["poll_id"] for p in queue.pending_snmp_batch(**LIMITS)], [i["poll_id"] for i in items])

    def test_no_secret_reaches_the_queue_file(self):
        queue = self.open_queue()
        dirty = poll(community=SECRET)
        dirty["interfaces"][0]["auth_key"] = SECRET
        queue.enqueue_snmp(dirty)
        queue.close()
        for candidate in self.path.parent.iterdir():
            self.assertNotIn(SECRET.encode(), candidate.read_bytes(), candidate.name)

    def test_the_file_is_private(self):
        self.open_queue().enqueue_snmp(poll())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_invalid_polls_raise_queue_errors(self):
        queue = self.open_queue()
        with self.assertRaises(QueueError):
            queue.enqueue_snmp(poll(poll_id="nope"))
        self.assertEqual(queue.snmp_count(), 0)

    def test_network_and_snmp_rows_are_independent(self):
        queue = self.open_queue()
        queue.enqueue(measurement())
        queue.enqueue_snmp(poll())
        self.assertEqual((queue.count(), queue.snmp_count()), (1, 1))
        queue.remove_snmp([p["poll_id"] for p in queue.pending_snmp_batch(**LIMITS)])
        self.assertEqual((queue.count(), queue.snmp_count()), (1, 0))


class CompatibilityTests(QueueTestCase):
    def test_a_queue_file_from_an_agent_without_snmp_gets_the_new_table(self):
        self.path.parent.mkdir(mode=0o700)
        legacy = sqlite3.connect(self.path)
        legacy.executescript(
            """
            CREATE TABLE pending_measurements (
                measurement_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
                enqueued_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at REAL NOT NULL DEFAULT 0);
            PRAGMA user_version = 1;
            """
        )
        old = measurement()
        legacy.execute(
            "INSERT INTO pending_measurements (measurement_id, payload, enqueued_at) VALUES (?, ?, ?)",
            (old["measurement_id"], json.dumps(old), self.clock()),
        )
        legacy.commit()
        legacy.close()
        queue = self.open_queue()
        self.assertTrue(queue.persistent)
        self.assertEqual(queue.count(), 1)  # the old data is intact
        self.assertTrue(queue.enqueue_snmp(poll()))
        self.assertEqual(queue.snmp_count(), 1)

    def test_the_schema_version_is_unchanged_so_an_older_agent_keeps_using_the_file(self):
        self.open_queue().enqueue_snmp(poll())
        connection = sqlite3.connect(self.path)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            connection.close()
        self.assertEqual(tables, {"pending_measurements", "pending_snmp"})


class BoundTests(QueueTestCase):
    def test_oldest_polls_are_dropped_beyond_the_count_limit(self):
        queue = self.open_queue(max_snmp_polls=3)
        items = [poll() for _ in range(5)]
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            for item in items:
                queue.enqueue_snmp(item)
        self.assertEqual(queue.snmp_count(), 3)
        self.assertEqual(
            [p["poll_id"] for p in queue.pending_snmp_batch(**LIMITS)], [i["poll_id"] for i in items[2:]]
        )
        self.assertIn("dropped", "\n".join(logs.output))

    def test_oldest_polls_are_dropped_beyond_the_byte_limit(self):
        size = len(sanitize_poll(poll(400))[1].encode())
        count = MAX_POLL_PAYLOAD_BYTES // size + 3
        items = [poll(400) for _ in range(count)]
        queue = self.open_queue(max_snmp_bytes=MAX_POLL_PAYLOAD_BYTES)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            for item in items:
                queue.enqueue_snmp(item)
        kept = queue.snmp_count()
        self.assertLess(kept, count)
        self.assertLessEqual(kept * size, MAX_POLL_PAYLOAD_BYTES)
        batch = queue.pending_snmp_batch(max_polls=1000, max_interfaces=10**9, max_bytes=10**9)
        self.assertEqual([p["poll_id"] for p in batch], [i["poll_id"] for i in items[count - kept :]])
        self.assertIn("dropped", "\n".join(logs.output))

    def test_a_full_queue_logs_once_a_minute_not_on_every_enqueue(self):
        queue = self.open_queue(max_snmp_polls=2)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            for _ in range(40):
                queue.enqueue_snmp(poll())
        self.assertEqual(queue.snmp_count(), 2)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("dropped 1 oldest", logs.output[0])
        self.clock.now += 61
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            queue.enqueue_snmp(poll())
        self.assertEqual(len(logs.output), 1)
        self.assertIn("dropped 38 oldest", logs.output[0])  # the 37 dropped meanwhile + this one

    def test_the_byte_total_is_summed_from_an_index_not_by_reading_every_payload(self):
        queue = self.open_queue()
        plan = " ".join(
            str(row[3])
            for row in queue._conn.execute(
                "EXPLAIN QUERY PLAN SELECT COUNT(*), COALESCE(SUM(payload_bytes), 0) FROM pending_snmp"
            )
        )
        self.assertIn("COVERING INDEX", plan.upper())

    def test_a_full_size_poll_with_non_latin_text_is_stored(self):
        text = "日本語" * 100
        big = poll(512)
        for entry in big["interfaces"]:
            entry["name"] = entry["descr"] = text[:128]
            entry["alias"] = text[:64]
        queue = self.open_queue()
        self.assertTrue(queue.enqueue_snmp(big))
        (stored,) = queue.pending_snmp_batch(max_polls=1, max_interfaces=1000, max_bytes=10**7)
        self.assertEqual(stored["interfaces"][0]["alias"], text[:64])  # UTF-8, not escaped

    def test_old_polls_are_purged(self):
        queue = self.open_queue(max_age_seconds=3600)
        queue.enqueue_snmp(poll())
        self.clock.now += 3601
        queue.enqueue_snmp(poll())
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.assertEqual(queue.purge_expired_snmp(), 1)
        self.assertEqual(queue.snmp_count(), 1)

    def test_invalid_limits_are_refused(self):
        with self.assertRaises(ValueError):
            MeasurementQueue(None, max_snmp_polls=0)
        with self.assertRaises(ValueError):
            MeasurementQueue(None, max_snmp_bytes=10)

    def test_batches_respect_the_servers_limits(self):
        queue = self.open_queue()
        items = [poll(40) for _ in range(120)]
        for item in items:
            queue.enqueue_snmp(item)
        by_polls = queue.pending_snmp_batch(max_polls=50, max_interfaces=10**6, max_bytes=10**9)
        self.assertEqual(len(by_polls), 50)
        by_interfaces = queue.pending_snmp_batch(max_polls=50, max_interfaces=2000, max_bytes=10**9)
        self.assertEqual(len(by_interfaces), 50)  # 50 x 40 = 2000 exactly
        by_interfaces = queue.pending_snmp_batch(max_polls=50, max_interfaces=1999, max_bytes=10**9)
        self.assertEqual(len(by_interfaces), 49)
        one = len(json.dumps(by_polls[0], separators=(",", ":"), sort_keys=True))
        by_bytes = queue.pending_snmp_batch(max_polls=50, max_interfaces=10**6, max_bytes=one * 3 + 10)
        self.assertEqual(len(by_bytes), 3)

    def test_the_first_poll_is_always_delivered_even_if_it_alone_exceeds_a_limit(self):
        queue = self.open_queue()
        queue.enqueue_snmp(poll(40))
        batch = queue.pending_snmp_batch(max_polls=50, max_interfaces=10, max_bytes=10)
        self.assertEqual(len(batch), 1)


class RetryTests(QueueTestCase):
    def test_mark_retry_backs_off_and_eventually_drops(self):
        queue = self.open_queue()
        item = poll()
        queue.enqueue_snmp(item)
        outcome = queue.mark_snmp_retry([item["poll_id"]])
        self.assertEqual((outcome.rescheduled, outcome.dropped), (1, 0))
        self.assertEqual(queue.pending_snmp_batch(**LIMITS), [])  # not due yet
        self.clock.now += RETRY_BASE_SECONDS + 1
        self.assertEqual(len(queue.pending_snmp_batch(**LIMITS)), 1)
        dropped = 0
        with self.assertLogs("sentinel_agent", level="WARNING"):
            for _ in range(MAX_ITEM_ATTEMPTS):
                dropped += queue.mark_snmp_retry([item["poll_id"]]).dropped
                self.clock.now += 1000
        self.assertEqual((dropped, queue.snmp_count()), (1, 0))

    def test_remove_ignores_unknown_ids(self):
        queue = self.open_queue()
        item = poll()
        queue.enqueue_snmp(item)
        self.assertEqual(queue.remove_snmp([item["poll_id"], str(uuid.uuid4())]), 1)
        self.assertEqual(queue.remove_snmp([]), 0)


if __name__ == "__main__":
    unittest.main()

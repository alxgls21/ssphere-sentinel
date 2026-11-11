"""Queue robustness: unreadable rows, a failed COMMIT, and quarantine name collisions.

Three classes of problem the other queue tests do not reach. The tests were written
against the defects described here, before the fixes; they pass against the current
code and guard it:

* ``UnreadableRowTests`` - a row whose payload is not JSON was skipped, but it was
  never removed and it still counted against the batch ``LIMIT``, so enough of
  them at the head of the queue starved every good row behind them
  (``measurement_queue.py`` ``pending_batch`` / ``pending_snmp_batch``).
* ``FailedCommitTests`` - ``_write`` did not roll back when ``COMMIT`` itself
  failed. SQLite usually rolls back by itself in that case, so this simulates the
  worst case (the transaction stays open).
* ``QuarantineTests`` - the quarantine name had one-second resolution, so a
  second corruption in the same second overwrote the first quarantined file.
"""

import sqlite3
import unittest
from contextlib import closing
from unittest.mock import patch

from agent.config import Config
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse
from agent.measurement_queue import QueueError, quarantine_corrupt_file
from agent.network_delivery import NetworkDelivery
from agent.tests.queue_helpers import QueueTestCase, measurement, poll

# JSON nested far deeper than the parser can follow: json.loads raises RecursionError, which is not a
# ValueError (audit item "poisoned queue row", X1).
TOO_DEEP = "[" * 1_000_000 + "]" * 1_000_000


class UnreadableRowTests(QueueTestCase):
    def _insert_bad_measurements(self, count, payload="{not json"):
        with closing(sqlite3.connect(self.path, timeout=5)) as conn:
            for index in range(count):
                conn.execute(
                    "INSERT INTO pending_measurements (measurement_id, payload, enqueued_at) "
                    "VALUES (?, ?, ?)",
                    (f"00000000-0000-4000-8000-{index:012d}", payload, self.clock.now),
                )
            conn.commit()

    def _insert_bad_polls(self, count, payload="{not json"):
        with closing(sqlite3.connect(self.path, timeout=5)) as conn:
            for index in range(count):
                conn.execute(
                    "INSERT INTO pending_snmp "
                    "(poll_id, payload, interface_count, payload_bytes, enqueued_at) "
                    "VALUES (?, ?, 1, 10, ?)",
                    (f"00000000-0000-4000-8000-{index:012d}", payload, self.clock.now),
                )
            conn.commit()

    def test_an_unreadable_row_is_skipped_and_the_rest_is_returned(self):
        queue = self.open_queue()
        self._insert_bad_measurements(1)
        good = measurement()
        queue.enqueue(good)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            batch = queue.pending_batch(10)
        self.assertEqual([m["measurement_id"] for m in batch], [good["measurement_id"]])
        self.assertIn("unreadable", "\n".join(logs.output))

    def test_an_unreadable_poll_is_skipped_and_the_rest_is_returned(self):
        queue = self.open_queue()
        self._insert_bad_polls(1)
        good = poll()
        queue.enqueue_snmp(good)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            batch = queue.pending_snmp_batch(max_polls=10, max_interfaces=2000, max_bytes=10**6)
        self.assertEqual([p["poll_id"] for p in batch], [good["poll_id"]])

    def test_unreadable_rows_do_not_starve_good_rows_network(self):
        queue = self.open_queue()
        self._insert_bad_measurements(3)
        good = measurement()
        queue.enqueue(good)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            batch = queue.pending_batch(3)  # the three unreadable rows fill the LIMIT
        self.assertEqual([m["measurement_id"] for m in batch], [good["measurement_id"]])

    def test_unreadable_rows_do_not_starve_good_rows_snmp(self):
        queue = self.open_queue()
        self._insert_bad_polls(3)
        good = poll()
        queue.enqueue_snmp(good)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            batch = queue.pending_snmp_batch(max_polls=3, max_interfaces=2000, max_bytes=10**6)
        self.assertEqual([p["poll_id"] for p in batch], [good["poll_id"]])

    # -- a row nested too deeply to parse is one more unreadable row (X1) ------------

    def test_a_measurement_nested_too_deeply_to_parse_is_removed_and_the_rest_is_returned(self):
        queue = self.open_queue()
        self._insert_bad_measurements(1, payload=TOO_DEEP)
        good = measurement()
        queue.enqueue(good)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            batch = queue.pending_batch(10)
        self.assertEqual([m["measurement_id"] for m in batch], [good["measurement_id"]])
        self.assertEqual(queue.count(), 1)
        self.assertIn("unreadable", "\n".join(logs.output))

    def test_a_poll_nested_too_deeply_to_parse_is_removed_and_the_rest_is_returned(self):
        queue = self.open_queue()
        self._insert_bad_polls(1, payload=TOO_DEEP)
        good = poll()
        queue.enqueue_snmp(good)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            batch = queue.pending_snmp_batch(max_polls=10, max_interfaces=2000, max_bytes=10**6)
        self.assertEqual([p["poll_id"] for p in batch], [good["poll_id"]])
        self.assertEqual(queue.snmp_count(), 1)
        self.assertIn("unreadable", "\n".join(logs.output))

    def test_a_row_nested_too_deeply_to_parse_does_not_fail_the_heartbeat(self):
        # Before: RecursionError left prepare_batch, so every heartbeat failed (liveness included)
        # until the age purge removed the row.
        queue = self.open_queue()
        self._insert_bad_measurements(1, payload=TOO_DEEP)
        good = measurement()
        queue.enqueue(good)
        sent = []

        def fake_post(_url, *, headers=None, payload=None, timeout=None):
            sent.append(payload)
            return HttpResponse(200, '{"status": "ok"}')

        with patch("agent.heartbeat.post_json", side_effect=fake_post), self.assertLogs(
            "sentinel_agent", level="WARNING"
        ):
            send_heartbeat(
                Config(sentinel_url="https://sentinel.example.com", agent_token="token"),
                collect_fn=lambda: {"version": 1},
                docker_fn=lambda: {"version": 1},
                network_delivery=NetworkDelivery(queue),
            )
        self.assertEqual(len(sent), 1)
        self.assertEqual(
            [m["measurement_id"] for m in sent[0]["network"]["measurements"]], [good["measurement_id"]]
        )
        self.assertEqual(queue.count(), 1)  # the unreadable row is gone, the good one waits for its ack


class _CommitFailsOnce:
    """A connection that fails its first COMMIT without executing it."""

    def __init__(self, conn) -> None:
        self._conn = conn
        self.armed = True

    def execute(self, sql, *args):
        if self.armed and sql.strip().upper() == "COMMIT":
            self.armed = False
            raise sqlite3.OperationalError("disk I/O error")
        return self._conn.execute(sql, *args)

    def __getattr__(self, name):
        return getattr(self._conn, name)


class FailedCommitTests(QueueTestCase):
    def test_a_failed_commit_is_reported_as_a_queue_error(self):
        queue = self.open_queue()
        queue._conn = _CommitFailsOnce(queue._conn)
        with self.assertRaises(QueueError):
            queue.enqueue(measurement())


class QuarantineTests(QueueTestCase):
    def test_two_corruptions_in_the_same_second_keep_both_files(self):
        path = self.dir / "queue.sqlite3"
        with patch("agent.measurement_queue.time.time", return_value=1_700_000_000.0):
            with self.assertLogs("sentinel_agent", level="WARNING"):
                path.write_bytes(b"first corrupt file")
                quarantine_corrupt_file(path)
                path.write_bytes(b"second corrupt file")
                quarantine_corrupt_file(path)
        kept = sorted(p for p in self.dir.iterdir() if ".corrupt-" in p.name)
        self.assertEqual(len(kept), 2, [p.name for p in kept])
        self.assertEqual({p.read_bytes() for p in kept}, {b"first corrupt file", b"second corrupt file"})

    def test_a_single_quarantine_moves_the_file_aside(self):
        path = self.dir / "queue.sqlite3"
        path.write_bytes(b"corrupt")
        with self.assertLogs("sentinel_agent", level="WARNING"):
            moved = quarantine_corrupt_file(path)
        self.assertFalse(path.exists())
        self.assertIsNotNone(moved)
        self.assertEqual(moved.read_bytes(), b"corrupt")


if __name__ == "__main__":
    unittest.main()

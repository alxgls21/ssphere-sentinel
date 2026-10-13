"""Telemetry history: samples on ingest, duplicates, out-of-order reports, failure isolation, purge."""

from datetime import datetime, timedelta, timezone as dt_timezone
from io import StringIO
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.db import DatabaseError, connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.infrastructure.models import Server, ServerTelemetry, ServerTelemetrySample
from apps.infrastructure.telemetry import (
    record_telemetry_sample,
    sample_slot,
    upsert_server_telemetry,
    validate_telemetry_payload,
)

BASE = datetime.now(dt_timezone.utc).replace(microsecond=0)
BASE = BASE.replace(second=0) - timedelta(hours=1)  # a minute boundary, an hour ago: never "in the future"
GIB = 1024**3


def payload(collected_at, cpu=10.0, memory=20.0, disk=30.0):
    return {
        "version": 1,
        "collected_at": collected_at.isoformat(),
        "cpu_percent": cpu,
        "memory_total_bytes": 100 * GIB,
        "memory_used_bytes": int(memory * GIB),
        "memory_percent": memory,
        "disk_total_bytes": 100 * GIB,
        "disk_used_bytes": int(disk * GIB),
        "disk_percent": disk,
        "uptime_seconds": 1000,
    }


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60, SENTINEL_TELEMETRY_RETENTION_DAYS=7)
class SampleIngestTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="host", hostname="host.local")
        self.received = BASE + timedelta(hours=1)

    def report(self, offset_seconds, **values):
        validated = validate_telemetry_payload(payload(BASE + timedelta(seconds=offset_seconds), **values))
        upsert_server_telemetry(self.server, validated, received_at=self.received)

    def samples(self):
        return list(ServerTelemetrySample.objects.order_by("sampled_at").values_list("sampled_at", "cpu_percent"))

    def snapshot(self):
        return ServerTelemetry.objects.get(server=self.server)

    def test_a_report_updates_the_snapshot_and_adds_a_sample_on_the_grid(self):
        self.report(75, cpu=11.5)
        self.assertEqual(self.samples(), [(BASE + timedelta(seconds=60), 11.5)])
        self.assertEqual(self.snapshot().cpu_percent, 11.5)
        self.assertEqual(self.snapshot().collected_at, BASE + timedelta(seconds=75))  # the snapshot keeps the exact time

    def test_a_second_report_in_the_same_slot_keeps_the_first_sample_and_refreshes_the_snapshot(self):
        self.report(61, cpu=1.0)
        self.report(105, cpu=2.0)
        self.assertEqual(self.samples(), [(BASE + timedelta(seconds=60), 1.0)])
        self.assertEqual(self.snapshot().cpu_percent, 2.0)

    def test_each_slot_gets_one_sample(self):
        for offset, cpu in ((0, 1.0), (30, 2.0), (60, 3.0), (119, 4.0), (120, 5.0)):
            self.report(offset, cpu=cpu)
        self.assertEqual([c for _, c in self.samples()], [1.0, 3.0, 5.0])

    def test_a_duplicate_report_changes_nothing(self):
        self.report(60, cpu=7.0)
        before = (self.samples(), self.snapshot().received_at)
        self.report(60, cpu=7.0)
        self.assertEqual((self.samples(), self.snapshot().received_at), before)
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)

    def test_an_out_of_order_report_never_replaces_a_newer_snapshot(self):
        self.report(300, cpu=50.0)
        self.report(120, cpu=20.0)  # delayed: collected before the snapshot
        snapshot = self.snapshot()
        self.assertEqual((snapshot.cpu_percent, snapshot.collected_at), (50.0, BASE + timedelta(seconds=300)))
        # ...but its own slot, still free, enters the history.
        self.assertEqual(self.samples(), [(BASE + timedelta(seconds=120), 20.0), (BASE + timedelta(seconds=300), 50.0)])

    def test_an_out_of_order_report_for_a_taken_slot_is_dropped(self):
        self.report(359, cpu=50.0)
        self.report(301, cpu=99.0)  # same slot, collected earlier but received later
        self.assertEqual(self.samples(), [(BASE + timedelta(seconds=300), 50.0)])
        self.assertEqual(self.snapshot().cpu_percent, 50.0)

    def test_a_report_collected_at_the_same_time_still_refreshes_the_snapshot(self):
        self.report(60, cpu=7.0)
        self.server.telemetry  # noqa: B018 (loaded for the comparison below)
        self.received += timedelta(seconds=30)
        self.report(60, cpu=8.0)
        self.assertEqual(self.snapshot().cpu_percent, 8.0)

    def test_a_sample_older_than_the_retention_is_not_stored_but_may_start_the_snapshot(self):
        validated = validate_telemetry_payload(payload(self.received - timedelta(days=8)))
        upsert_server_telemetry(self.server, validated, received_at=self.received)
        self.assertEqual(ServerTelemetrySample.objects.count(), 0)
        self.assertTrue(ServerTelemetry.objects.filter(server=self.server).exists())

    def test_the_boundary_of_the_retention(self):
        for age, stored in ((timedelta(days=7), True), (timedelta(days=7, seconds=1), False)):
            ServerTelemetrySample.objects.all().delete()
            validated = validate_telemetry_payload(payload(self.received - age))
            self.assertEqual(record_telemetry_sample(self.server, validated, received_at=self.received), stored, age)

    def test_a_failing_history_write_never_fails_the_report(self):
        with patch("apps.infrastructure.telemetry._insert_sample", side_effect=DatabaseError("boom")):
            with self.assertLogs("apps.infrastructure", "ERROR"):
                self.report(60, cpu=9.0)
        self.assertEqual(self.snapshot().cpu_percent, 9.0)
        self.assertEqual(ServerTelemetrySample.objects.count(), 0)
        self.report(120, cpu=10.0)  # the connection is still usable (the insert ran in its own savepoint)
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)

    def test_a_real_database_error_inside_a_transaction_does_not_poison_it(self):
        """The failing statement is PostgreSQL's own (a value that is not a number), not a mock: without the
        savepoint the surrounding transaction would be aborted and the next query would fail."""
        from dataclasses import replace

        bad = replace(validate_telemetry_payload(payload(BASE + timedelta(seconds=60))), cpu_percent="not a number")
        with self.assertLogs("apps.infrastructure", "ERROR"):
            self.assertFalse(record_telemetry_sample(self.server, bad, received_at=self.received))
        self.assertEqual(ServerTelemetrySample.objects.count(), 0)  # a query, in the same transaction
        self.report(120)
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)

    def test_the_write_is_one_insert_that_reads_nothing_from_the_history(self):
        self.report(0)
        with CaptureQueriesContext(connection) as queries:
            self.report(30)  # same slot: dropped by the database
            self.report(60)
        sql = [q["sql"] for q in queries]
        history = [s for s in sql if "infrastructure_servertelemetrysample" in s]
        self.assertTrue(all(s.startswith("INSERT") and "ON CONFLICT DO NOTHING" in s for s in history), history)
        self.assertEqual(len(history), 2)

    def test_an_older_report_is_one_update_and_one_upsert_that_changes_nothing(self):
        self.report(300, cpu=50.0)
        with CaptureQueriesContext(connection) as queries:
            self.report(120, cpu=20.0)
        verbs = [q["sql"].split(" ", 1)[0] for q in queries if '"infrastructure_servertelemetry"' in q["sql"]]
        self.assertEqual(verbs, ["UPDATE", "INSERT"])
        self.assertEqual(self.snapshot().cpu_percent, 50.0)

    def test_a_stale_snapshot_gives_way_when_the_agents_clock_steps_back(self):
        """Every report after a backward clock step looks older than the snapshot; it must not stay frozen."""
        self.received = BASE + timedelta(hours=2)
        self.report(3600, cpu=10.0)  # collected "at BASE+1h", received now
        self.received += timedelta(minutes=2)
        self.report(0, cpu=90.0)  # the clock stepped back an hour; the snapshot was refreshed 2 minutes ago: ignored
        self.assertEqual(self.snapshot().cpu_percent, 10.0)
        self.received += timedelta(minutes=4)  # the snapshot has not been refreshed for 6 minutes (> the skew)
        self.report(30, cpu=91.0)
        snapshot = self.snapshot()
        self.assertEqual((snapshot.cpu_percent, snapshot.collected_at), (91.0, BASE + timedelta(seconds=30)))
        self.received += timedelta(seconds=30)
        self.report(60, cpu=92.0)  # and it moves forward again from the new baseline
        self.assertEqual(self.snapshot().cpu_percent, 92.0)

    def test_the_snapshot_upsert_settles_every_case_in_one_statement(self):
        from apps.infrastructure.telemetry import _insert_or_replace_snapshot

        def values(offset, cpu):
            v = validate_telemetry_payload(payload(BASE + timedelta(seconds=offset), cpu=cpu))
            return {
                "cpu_percent": v.cpu_percent, "memory_total_bytes": v.memory_total_bytes, "memory_used_bytes": v.memory_used_bytes,
                "memory_percent": v.memory_percent, "disk_total_bytes": v.disk_total_bytes, "disk_used_bytes": v.disk_used_bytes,
                "disk_percent": v.disk_percent, "uptime_seconds": v.uptime_seconds, "collected_at": v.collected_at, "received_at": self.received,
            }

        stale = self.received - timedelta(minutes=5)
        _insert_or_replace_snapshot(self.server, values(100, 1.0), stale)  # no row: created
        self.assertEqual(self.snapshot().cpu_percent, 1.0)
        _insert_or_replace_snapshot(self.server, values(200, 2.0), stale)  # the row is older: replaced
        self.assertEqual(self.snapshot().cpu_percent, 2.0)
        _insert_or_replace_snapshot(self.server, values(150, 3.0), stale)  # the row is newer and fresh: untouched
        self.assertEqual(self.snapshot().cpu_percent, 2.0)
        _insert_or_replace_snapshot(self.server, values(150, 4.0), self.received + timedelta(minutes=1))  # the row is stale
        self.assertEqual(self.snapshot().cpu_percent, 4.0)
        self.assertEqual(ServerTelemetry.objects.count(), 1)

    def test_the_sample_grid_follows_the_setting(self):
        moment = BASE + timedelta(seconds=137)
        epoch = int(moment.timestamp())
        for step in (5, 30, 60, 120, 300):
            with override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=step):
                slot = sample_slot(moment)
                self.assertEqual(int(slot.timestamp()), epoch // step * step, step)
                self.assertEqual(slot.tzinfo, dt_timezone.utc)

    def test_deleting_a_server_deletes_its_history_without_loading_it(self):
        self.report(0)
        self.report(60)
        with CaptureQueriesContext(connection) as queries:
            self.server.delete()
        self.assertEqual(ServerTelemetrySample.objects.count(), 0)
        self.assertFalse([q for q in queries if q["sql"].startswith("SELECT") and "servertelemetrysample" in q["sql"]])


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60, SENTINEL_TELEMETRY_RETENTION_DAYS=7)
class AutocommitWriteTests(TransactionTestCase):
    """Heartbeats run in autocommit (no surrounding transaction); a TestCase is always inside one."""

    def test_the_history_write_is_a_single_statement_and_a_failure_is_contained(self):
        server = Server.objects.create(name="host", hostname="host.local")
        received = BASE + timedelta(hours=1)
        validated = validate_telemetry_payload(payload(BASE + timedelta(seconds=60)))
        self.assertFalse(connection.in_atomic_block)
        with CaptureQueriesContext(connection) as queries:
            self.assertTrue(record_telemetry_sample(server, validated, received_at=received))
            self.assertTrue(record_telemetry_sample(server, validated, received_at=received))  # taken: dropped by the database
        sql = [q["sql"] for q in queries]
        self.assertEqual(len(sql), 2, sql)  # no BEGIN/COMMIT or savepoint around either insert
        self.assertTrue(all(q.startswith("INSERT") and "ON CONFLICT DO NOTHING" in q for q in sql), sql)
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)
        with patch("apps.infrastructure.telemetry._insert_sample", side_effect=DatabaseError("boom")):
            with self.assertLogs("apps.infrastructure", "ERROR"):
                self.assertFalse(record_telemetry_sample(server, validated, received_at=received))
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60, SENTINEL_TELEMETRY_RETENTION_DAYS=7)
class ConcurrentFirstReportTests(TransactionTestCase):
    """Real concurrency: the newest of several simultaneous first reports must end up as the snapshot."""

    def test_the_newest_of_concurrent_first_reports_wins(self):
        import threading

        for round_ in range(12):
            server = Server.objects.create(name=f"race-{round_}", hostname=f"race-{round_}.local")
            received = BASE + timedelta(hours=1)
            barrier = threading.Barrier(8)
            errors = []

            def worker(offset, server=server, barrier=barrier, errors=errors):
                try:
                    validated = validate_telemetry_payload(payload(BASE + timedelta(seconds=offset), cpu=float(offset) / 10))
                    barrier.wait(timeout=10)
                    upsert_server_telemetry(server, validated, received_at=received)
                except Exception as exc:  # noqa: BLE001 - reported by the assertion below
                    errors.append(exc)
                finally:
                    connection.close()

            threads = [threading.Thread(target=worker, args=(offset,)) for offset in range(0, 80, 10)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
            self.assertEqual(errors, [])
            snapshot = ServerTelemetry.objects.get(server=server)
            self.assertEqual((snapshot.cpu_percent, snapshot.collected_at), (7.0, BASE + timedelta(seconds=70)), round_)
            self.assertEqual(ServerTelemetrySample.objects.filter(server=server).count(), 2)  # slots 0 and 60


@override_settings(SENTINEL_TELEMETRY_SAMPLE_SECONDS=60, SENTINEL_TELEMETRY_RETENTION_DAYS=7)
class HeartbeatCompatibilityTests(TestCase):
    """Agents are unchanged: the same heartbeat now also feeds the history."""

    def setUp(self):
        self.server = Server.objects.create(name="host", hostname="host.local")
        _agent, self.token = create_agent(server=self.server, name="agent")

    def beat(self, body):
        import json

        return Client().post(
            "/api/v1/agent/heartbeat/", data=json.dumps(body), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )

    def test_a_heartbeat_with_telemetry_is_acknowledged_as_before_and_stored(self):
        response = self.beat({"telemetry": payload(BASE)})
        self.assertEqual(response.json(), {"status": "ok", "telemetry": "accepted"})
        self.assertEqual(ServerTelemetrySample.objects.filter(server=self.server).count(), 1)
        self.assertEqual(ServerTelemetry.objects.get(server=self.server).collected_at, BASE)

    def test_a_heartbeat_without_telemetry_or_with_an_invalid_one_stores_no_history(self):
        self.assertEqual(self.beat({}).json(), {"status": "ok"})
        bad = payload(BASE)
        bad["cpu_percent"] = 140
        self.assertEqual(self.beat({"telemetry": bad}).json()["telemetry"], "rejected")
        self.assertEqual(ServerTelemetrySample.objects.count(), 0)
        self.assertFalse(ServerTelemetry.objects.exists())

    def test_replayed_and_reordered_heartbeats_are_all_accepted_and_safe(self):
        for offset in (120, 60, 120, 0, 180, 60):
            self.assertEqual(self.beat({"telemetry": payload(BASE + timedelta(seconds=offset), cpu=offset / 10)}).json()["telemetry"], "accepted")
        samples = list(ServerTelemetrySample.objects.order_by("sampled_at").values_list("cpu_percent", flat=True))
        self.assertEqual(samples, [0.0, 6.0, 12.0, 18.0])
        self.assertEqual(ServerTelemetry.objects.get(server=self.server).cpu_percent, 18.0)


@override_settings(SENTINEL_TELEMETRY_RETENTION_DAYS=7)
class PurgeTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="host", hostname="host.local")
        self.other = Server.objects.create(name="other", hostname="other.local")
        now = datetime.now(dt_timezone.utc)
        self.now = now
        rows = []
        for server in (self.server, self.other):
            for days, minutes in ((8, 0), (7.5, 1), (6, 0), (1, 0), (0, 5)):
                rows.append(
                    ServerTelemetrySample(
                        server=server, sampled_at=now - timedelta(days=days, minutes=minutes), cpu_percent=1, memory_percent=2, disk_percent=3
                    )
                )
        ServerTelemetrySample.objects.bulk_create(rows)

    def purge(self, **options):
        out = StringIO()
        call_command("purge_telemetry_samples", stdout=out, stderr=out, **options)
        return out.getvalue()

    def test_deletes_only_samples_past_the_retention_for_every_server(self):
        self.assertIn("Deleted 4 telemetry sample(s)", self.purge())
        self.assertEqual(ServerTelemetrySample.objects.count(), 6)
        self.assertFalse(ServerTelemetrySample.objects.filter(sampled_at__lt=self.now - timedelta(days=7)).exists())

    def test_the_days_option_and_dry_run(self):
        self.assertIn("Would delete 4 telemetry sample(s)", self.purge(dry_run=True))
        self.assertEqual(ServerTelemetrySample.objects.count(), 10)
        self.assertIn("Would delete 6 telemetry sample(s)", self.purge(days=3, dry_run=True))
        self.assertEqual(ServerTelemetrySample.objects.count(), 10)
        self.purge(days=3)
        self.assertEqual(ServerTelemetrySample.objects.count(), 4)

    def test_the_cutoff_is_exclusive(self):
        ServerTelemetrySample.objects.all().delete()
        fixed = datetime.now(dt_timezone.utc).replace(microsecond=0)
        cutoff = fixed - timedelta(days=7)
        ServerTelemetrySample.objects.bulk_create(
            ServerTelemetrySample(server=self.server, sampled_at=at, cpu_percent=1, memory_percent=1, disk_percent=1)
            for at in (cutoff - timedelta(microseconds=1), cutoff, cutoff + timedelta(microseconds=1))
        )
        with patch("django.utils.timezone.now", return_value=fixed):
            self.purge()
        self.assertEqual(
            list(ServerTelemetrySample.objects.order_by("sampled_at").values_list("sampled_at", flat=True)),
            [cutoff, cutoff + timedelta(microseconds=1)],
        )

    def test_a_batch_may_be_as_large_as_the_documented_maximum(self):
        """With ``WHERE (server, time) IN (...)`` PostgreSQL ran out of stack above about 6,500 rows."""
        from apps.core.retention import MAX_BATCH_SIZE

        ServerTelemetrySample.objects.all().delete()
        old = self.now - timedelta(days=30)
        ServerTelemetrySample.objects.bulk_create(
            ServerTelemetrySample(server=self.server, sampled_at=old - timedelta(minutes=i), cpu_percent=1, memory_percent=1, disk_percent=1)
            for i in range(8000)
        )
        ServerTelemetrySample.objects.create(server=self.server, sampled_at=self.now, cpu_percent=1, memory_percent=1, disk_percent=1)
        output = self.purge(batch_size=MAX_BATCH_SIZE)
        self.assertIn("Deleted 8000 telemetry sample(s)", output)
        self.assertIn("in 1 batch(es)", output)
        self.assertEqual(ServerTelemetrySample.objects.count(), 1)
        ServerTelemetrySample.objects.bulk_create(
            ServerTelemetrySample(server=self.server, sampled_at=old - timedelta(minutes=i), cpu_percent=1, memory_percent=1, disk_percent=1)
            for i in range(7000)
        )
        self.assertIn("in 2 batch(es)", self.purge(batch_size=4000))

    def test_batches(self):
        output = self.purge(batch_size=1)
        self.assertIn("Deleted 4 telemetry sample(s)", output)
        self.assertIn("in 4 batch(es)", output)

    def test_the_latest_snapshot_is_never_touched(self):
        ServerTelemetry.objects.create(
            server=self.server, cpu_percent=1, memory_total_bytes=1, memory_used_bytes=1, memory_percent=1, disk_total_bytes=1,
            disk_used_bytes=1, disk_percent=1, uptime_seconds=1, collected_at=self.now - timedelta(days=100), received_at=self.now - timedelta(days=100),
        )
        self.purge(days=1)
        self.assertTrue(ServerTelemetry.objects.filter(server=self.server).exists())

    def test_bad_options_fail_loudly(self):
        for options in ({"days": 0}, {"days": -1}, {"batch_size": 0}):
            with self.assertRaises(CommandError):
                self.purge(**options)
        self.assertEqual(ServerTelemetrySample.objects.count(), 10)

    def test_an_empty_table_is_fine(self):
        ServerTelemetrySample.objects.all().delete()
        self.assertIn("Deleted 0 telemetry sample(s)", self.purge())

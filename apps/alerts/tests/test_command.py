"""run_alert_engine: the lock, the heartbeat, one cycle or many, and evaluators at the same time."""

import io
import signal
import threading
from contextlib import contextmanager
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.db import OperationalError, connection
from django.test import TestCase, TransactionTestCase

from apps.alerts import engine
from apps.alerts.management.commands.run_alert_engine import LOCK_KEY, Engine
from apps.alerts.models import AlertEngineHeartbeat, AlertEvaluationState, AlertRule, Incident
from apps.alerts.tests.fleet import PINNED, Fleet, t

COMMAND = "apps.alerts.management.commands.run_alert_engine"


@contextmanager
def another_session():
    """A second database session, as another engine process would have."""
    other = connection.get_new_connection(connection.get_connection_params())
    try:
        yield other
    finally:
        other.close()


def query(session, sql: str):
    with session.cursor() as cursor:
        cursor.execute(sql, [LOCK_KEY])
        return cursor.fetchone()[0]


@PINNED
class LockAndHeartbeatTests(TestCase):
    def test_a_second_engine_waits_while_one_evaluates(self):
        engine_ = Engine(interval=30)
        with another_session() as other:
            query(other, "SELECT pg_advisory_lock(%s)")
            with self.assertLogs("apps.alerts.engine", "INFO") as logs:
                self.assertEqual(engine_.cycle(), "locked")
                self.assertEqual(engine_.cycle(), "locked")
            self.assertEqual(len(logs.records), 1)  # said once, not every cycle
            self.assertFalse(AlertEngineHeartbeat.objects.exists())
            query(other, "SELECT pg_advisory_unlock(%s)")
            self.assertEqual(engine_.cycle(), "done")
            # Released after its cycle: the other engine can take its turn.
            self.assertTrue(query(other, "SELECT pg_try_advisory_lock(%s)"))
            query(other, "SELECT pg_advisory_unlock(%s)")

    def test_each_cycle_is_recorded(self):
        engine_ = Engine(interval=30)
        self.assertEqual(engine_.cycle(), "done")
        beat = AlertEngineHeartbeat.objects.get()
        self.assertEqual((beat.started_at, beat.interval_seconds), (engine_.started_at, 30))
        self.assertIsNotNone(beat.beat_at)
        self.assertIsNotNone(beat.last_cycle_ms)
        self.assertEqual(beat.monitoring_since, beat.beat_at)  # a first cycle starts the window
        self.assertEqual((beat.last_error_at, beat.last_error_type), (None, ""))

    def test_a_failed_cycle_is_recorded_with_its_kind_of_error_only(self):
        engine_ = Engine(interval=30)
        with patch(f"{COMMAND}.run_cycle", side_effect=RuntimeError("password=not-for-the-database")):
            with self.assertLogs("apps.alerts.engine", "ERROR"):
                self.assertEqual(engine_.cycle(), "failed")
        beat = AlertEngineHeartbeat.objects.get()
        self.assertEqual((beat.beat_at, beat.last_error_category, beat.last_error_type), (None, "internal", "RuntimeError"))
        self.assertIsNotNone(beat.last_error_at)
        self.assertNotIn("not-for-the-database", repr(AlertEngineHeartbeat.objects.values().get()))
        self.assertEqual(engine_.cycle(), "done")
        beat.refresh_from_db()
        self.assertIsNotNone(beat.beat_at)
        self.assertEqual(beat.last_error_type, "RuntimeError")  # the last failure stays on record

    def test_a_database_failure_is_told_apart_from_an_internal_one(self):
        engine_ = Engine(interval=60)
        with patch(f"{COMMAND}.run_cycle", side_effect=OperationalError("connection refused")):
            with self.assertLogs("apps.alerts.engine", "ERROR"):
                engine_.cycle()
        beat = AlertEngineHeartbeat.objects.get()
        self.assertEqual((beat.last_error_category, beat.last_error_type, beat.interval_seconds), ("database", "OperationalError", 60))

    def test_once_evaluates_and_says_what_it_did(self):
        out = io.StringIO()
        call_command("run_alert_engine", "--once", stdout=out)
        self.assertIn("Evaluated: opened 0", out.getvalue())
        self.assertIsNotNone(AlertEngineHeartbeat.objects.get().beat_at)

    def test_once_while_another_engine_evaluates_does_nothing(self):
        out = io.StringIO()
        with another_session() as other:
            query(other, "SELECT pg_advisory_lock(%s)")
            with self.assertLogs("apps.alerts.engine", "INFO"):
                call_command("run_alert_engine", "--once", stdout=out)
            query(other, "SELECT pg_advisory_unlock(%s)")
        self.assertIn("Another alert engine is evaluating", out.getvalue())
        self.assertFalse(AlertEngineHeartbeat.objects.exists())

    def test_a_failed_once_exits_with_an_error(self):
        with patch(f"{COMMAND}.run_cycle", side_effect=RuntimeError("boom")), self.assertLogs("apps.alerts.engine", "ERROR"):
            with self.assertRaisesMessage(CommandError, "The evaluation failed"):
                call_command("run_alert_engine", "--once", stdout=io.StringIO())

    def test_it_never_migrates_and_will_not_start_with_migrations_pending(self):
        with patch(f"{COMMAND}.unapplied_migrations", return_value=[("alerts", "9999_future")]):
            with self.assertRaisesMessage(CommandError, "the alert engine never migrates"):
                call_command("run_alert_engine", "--once")
        self.assertFalse(AlertEngineHeartbeat.objects.exists())

    def test_the_interval_is_bounded(self):
        for value in ("4", "3601"):
            with self.subTest(interval=value), self.assertRaises(CommandError):
                call_command("run_alert_engine", "--once", "--interval", value)


@PINNED
class ServingTests(TransactionTestCase):
    """The long-running mode, where the engine also looks after its database connection."""

    def test_the_loop_runs_until_it_is_stopped(self):
        engine_ = Engine(interval=0)
        outcomes = iter(["failed", "done"])
        calls = []

        def cycle():
            calls.append(connection.connection is None)
            outcome = next(outcomes)
            if outcome == "done":
                engine_.stop.set()
            return outcome

        engine_.cycle = cycle
        with self.assertLogs("apps.alerts.engine", "INFO"):
            engine_.serve()
        # After the failed cycle the connection was closed: the next one starts on a new connection.
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1])

    def test_sigterm_stops_it_after_the_cycle_in_progress(self):
        original = signal.getsignal(signal.SIGTERM)
        seen = {}

        def serve(engine_):
            signal.raise_signal(signal.SIGTERM)
            seen["stopped"] = engine_.stop.is_set()

        with patch.object(Engine, "serve", serve):
            call_command("run_alert_engine")
        self.assertTrue(seen["stopped"])
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)


@PINNED
class ConcurrentEvaluationTests(TransactionTestCase):
    def test_two_evaluators_at_once_open_each_incident_once(self):
        AlertRule.objects.update(enabled=False)
        AlertRule.objects.create(
            name="Offline at once", entity_kind="server", health="critical", reason="offline", severity="critical", activation_seconds=0
        )
        fleet = Fleet()
        for index in range(20):
            fleet.server(f"web-{index}", seen=0)
        barrier = threading.Barrier(2)
        errors = []

        def evaluator():
            try:
                barrier.wait()
                engine.evaluate(t(200), monitoring_since=t(-86_400))
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=evaluator) for _ in range(2)]
        # The evaluator that comes second is refused by the database, object by object, and says so.
        with patch.object(engine.logger, "warning") as refused:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(errors, [])
        self.assertLessEqual(refused.call_count, 20)
        self.assertEqual(Incident.objects.count(), 20)
        self.assertEqual(Incident.objects.values("entity_ref").distinct().count(), 20)
        self.assertEqual(AlertEvaluationState.objects.filter(phase="firing").count(), 20)

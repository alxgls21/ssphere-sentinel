import json
import threading
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.db import IntegrityError, OperationalError, connection
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.network import reports
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.reports import apply_network_report, validate_network_payload

MEASUREMENT_TABLE = '"network_networkmeasurement"'


def measurement(target, **overrides):
    payload = {
        "measurement_id": str(uuid.uuid4()),
        "target_id": str(target.pk),
        "measured_at": timezone.now().isoformat(),
        "success": True,
        "latency_ms": 10.0,
        "packet_loss_percentage": 0.0,
        "probe_count": 4,
        "successful_probes": 4,
        "failure_reason": "",
    }
    payload.update(overrides)
    return payload


def statements(captured, verb):
    return [
        q["sql"] for q in captured
        if q["sql"].startswith(verb) and MEASUREMENT_TABLE in q["sql"]
    ]


class IngestTestCase(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="ingest", hostname="ingest.local")
        self.agent, self.token = create_agent(server=self.server, name="ingest-agent")
        self.target = NetworkTarget.objects.create(
            name="edge", hostname_or_ip="192.0.2.1", protocol="tcp", port=443,
            assigned_agent=self.agent,
        )

    def ingest(self, items, agent=None):
        agent = agent or self.agent
        report = validate_network_payload({"version": 1, "measurements": items}, agent=agent)
        return apply_network_report(agent, report)

    def results(self, result):
        return {entry["measurement_id"]: entry for entry in result.results()}


class BatchInsertTests(IngestTestCase):
    def test_batch_is_stored_with_one_insert_and_no_per_row_savepoints(self):
        items = [measurement(self.target) for _ in range(100)]
        with CaptureQueriesContext(connection) as ctx:
            result = self.ingest(items)
        self.assertEqual(len(statements(ctx.captured_queries, "INSERT")), 1)
        savepoints = [q for q in ctx.captured_queries if q["sql"].startswith("SAVEPOINT")]
        # The ingest transaction (a savepoint inside TestCase) plus the one
        # guarding the bulk INSERT; none per measurement.
        self.assertEqual(len(savepoints), 2)
        self.assertEqual(result.created, 100)
        self.assertEqual(NetworkMeasurement.objects.count(), 100)
        self.assertEqual(
            {e["result"] for e in result.results()}, {"created"}
        )

    def test_duplicates_are_detected_without_attempting_an_insert(self):
        items = [measurement(self.target) for _ in range(20)]
        self.ingest(items)
        with CaptureQueriesContext(connection) as ctx:
            result = self.ingest(items)
        self.assertEqual(statements(ctx.captured_queries, "INSERT"), [])
        self.assertEqual(result.duplicates, 20)
        self.assertEqual(result.created, 0)
        self.assertEqual(result.status, "accepted")
        self.assertEqual(NetworkMeasurement.objects.count(), 20)

    def test_mixed_new_and_duplicate_ids(self):
        old = [measurement(self.target) for _ in range(3)]
        self.ingest(old)
        new = [measurement(self.target) for _ in range(2)]
        result = self.ingest(old + new)
        outcomes = self.results(result)
        for item in old:
            self.assertEqual(outcomes[item["measurement_id"]]["result"], "duplicate")
        for item in new:
            self.assertEqual(outcomes[item["measurement_id"]]["result"], "created")
        self.assertEqual(NetworkMeasurement.objects.count(), 5)

    def test_cross_agent_measurement_id_conflict(self):
        other_server = Server.objects.create(name="other", hostname="other.local")
        other_agent, _ = create_agent(server=other_server, name="other-agent")
        other_target = NetworkTarget.objects.create(
            name="other", hostname_or_ip="192.0.2.2", protocol="tcp", port=443,
            assigned_agent=other_agent,
        )
        shared = measurement(other_target)
        self.ingest([shared], agent=other_agent)
        mine = measurement(self.target, measurement_id=shared["measurement_id"])
        fresh = measurement(self.target)
        result = self.ingest([mine, fresh])
        outcomes = self.results(result)
        self.assertEqual(outcomes[shared["measurement_id"]], {
            "measurement_id": shared["measurement_id"],
            "result": "rejected",
            "reason": "measurement_id conflict",
            "retryable": False,
        })
        self.assertEqual(outcomes[fresh["measurement_id"]]["result"], "created")
        self.assertEqual(NetworkMeasurement.objects.get(pk=shared["measurement_id"]).agent, other_agent)

    def test_partial_validation_stores_only_valid_rows(self):
        disabled = NetworkTarget.objects.create(
            name="off", hostname_or_ip="192.0.2.3", protocol="tcp", port=443,
            assigned_agent=self.agent, enabled=False,
        )
        good = [measurement(self.target) for _ in range(3)]
        bad = [
            measurement(disabled),
            measurement(self.target, probe_count=0),
            measurement(self.target, measured_at="not-a-date"),
        ]
        result = self.ingest(good + bad)
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.created, 3)
        self.assertEqual(result.rejected, 3)
        self.assertTrue(all(not r.retryable for r in result.rejections))
        self.assertEqual(NetworkMeasurement.objects.count(), 3)


class InsertFailureTests(IngestTestCase):
    def test_race_after_precheck_falls_back_to_exact_per_row_results(self):
        stored = measurement(self.target)
        self.ingest([stored])
        new = measurement(self.target)
        # Simulate a concurrent report committing ``stored`` after the pre-check.
        with patch.object(reports, "_stored_measurements", return_value={}):
            result = self.ingest([stored, new])
        outcomes = self.results(result)
        self.assertEqual(outcomes[stored["measurement_id"]]["result"], "duplicate")
        self.assertEqual(outcomes[new["measurement_id"]]["result"], "created")
        self.assertEqual(NetworkMeasurement.objects.count(), 2)

    def test_unexplained_integrity_error_is_retryable_and_not_created(self):
        item = measurement(self.target)
        with patch.object(
            NetworkMeasurement.objects, "bulk_create", side_effect=IntegrityError("x")
        ), patch.object(NetworkMeasurement, "save", side_effect=IntegrityError("x")):
            result = self.ingest([item])
        self.assertEqual(result.created, 0)
        rejection = result.rejections[0]
        self.assertEqual(rejection.reason, "measurement could not be stored")
        self.assertTrue(rejection.retryable)
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_database_outage_propagates_instead_of_acknowledging(self):
        items = [measurement(self.target) for _ in range(3)]
        report = validate_network_payload({"version": 1, "measurements": items}, agent=self.agent)
        with patch.object(
            NetworkMeasurement.objects, "bulk_create", side_effect=OperationalError("down")
        ):
            with self.assertRaises(OperationalError):
                apply_network_report(self.agent, report)
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_heartbeat_returns_error_without_results_on_database_outage(self):
        client = Client(raise_request_exception=False)
        body = {"network": {"version": 1, "measurements": [measurement(self.target)]}}
        with patch.object(
            NetworkMeasurement.objects, "bulk_create", side_effect=OperationalError("down")
        ), self.assertLogs("django.request", level="ERROR"):
            response = client.post(
                reverse("agent-heartbeat"),
                data=json.dumps(body),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {self.token}",
            )
        # The agent treats non-2xx as a batch failure and keeps every row queued.
        self.assertEqual(response.status_code, 500)
        self.assertFalse(NetworkMeasurement.objects.exists())


@override_settings(
    SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS=8,
    SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS=30,
)
class TimestampWindowTests(IngestTestCase):
    def _at(self, delta):
        return measurement(self.target, measured_at=(timezone.now() + delta).isoformat())

    def test_delayed_measurement_inside_window_is_accepted(self):
        result = self.ingest([self._at(-timedelta(days=7, hours=12))])
        self.assertEqual(result.created, 1)

    def test_measurement_older_than_window_is_rejected_permanently(self):
        item = self._at(-timedelta(days=8, minutes=1))
        result = self.ingest([item])
        self.assertEqual(result.created, 0)
        self.assertEqual(
            result.rejections[0].reason,
            "measured_at is older than the accepted history window",
        )
        self.assertFalse(result.rejections[0].retryable)

    @override_settings(SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS=3)
    def test_window_never_exceeds_retention(self):
        result = self.ingest([self._at(-timedelta(days=4)), self._at(-timedelta(days=2))])
        self.assertEqual(result.created, 1)
        self.assertEqual(result.rejected, 1)

    @override_settings(SENTINEL_NETWORK_MEASUREMENT_MAX_AGE_DAYS=1)
    def test_window_is_configurable(self):
        result = self.ingest([self._at(-timedelta(hours=25)), self._at(-timedelta(hours=23))])
        self.assertEqual(result.created, 1)
        self.assertEqual(result.rejected, 1)

    def test_small_clock_skew_is_accepted(self):
        result = self.ingest([self._at(timedelta(minutes=4))])
        self.assertEqual(result.created, 1)

    def test_future_timestamp_is_rejected(self):
        result = self.ingest([self._at(timedelta(minutes=6))])
        self.assertEqual(result.created, 0)
        self.assertEqual(result.rejections[0].reason, "measured_at is too far in the future")
        self.assertFalse(result.rejections[0].retryable)


class AgentDeletionTests(IngestTestCase):
    def test_deleting_agent_keeps_targets_and_measurements(self):
        items = [measurement(self.target) for _ in range(5)]
        self.ingest(items)
        self.agent.delete()
        self.target.refresh_from_db()
        self.assertIsNone(self.target.assigned_agent)
        self.assertEqual(NetworkMeasurement.objects.count(), 5)
        self.assertEqual(
            set(NetworkMeasurement.objects.values_list("target_id", "agent_id")),
            {(self.target.pk, None)},
        )

    def test_deleting_server_keeps_history(self):
        self.ingest([measurement(self.target)])
        self.server.delete()
        self.assertFalse(Agent.objects.exists())
        self.assertTrue(NetworkTarget.objects.filter(pk=self.target.pk).exists())
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_deleting_target_still_deletes_its_history(self):
        self.ingest([measurement(self.target)])
        self.target.delete()
        self.assertFalse(NetworkMeasurement.objects.exists())

    def test_unassigned_target_rejects_reports(self):
        self.agent.delete()
        server = Server.objects.create(name="new", hostname="new.local")
        new_agent, _ = create_agent(server=server, name="new-agent")
        result = self.ingest([measurement(self.target)], agent=new_agent)
        self.assertEqual(result.rejections[0].reason, "target is not assigned to the reporting agent")

    def test_recreated_agent_resending_its_queue_gets_duplicates(self):
        items = [measurement(self.target) for _ in range(3)]
        self.ingest(items)
        self.server.delete()
        server = Server.objects.create(name="ingest", hostname="ingest.local")
        new_agent, _ = create_agent(server=server, name="ingest-agent")
        NetworkTarget.objects.filter(pk=self.target.pk).update(assigned_agent=new_agent)
        result = self.ingest(items, agent=new_agent)
        self.assertEqual(result.duplicates, 3)
        self.assertEqual(result.rejected, 0)
        # Historical attribution is not rewritten to the new agent.
        self.assertFalse(NetworkMeasurement.objects.filter(agent=new_agent).exists())


class ConcurrentNetworkReportTests(TransactionTestCase):
    def test_same_measurements_reported_concurrently_are_stored_once(self):
        server = Server.objects.create(name="race", hostname="race.local")
        agent, token = create_agent(server=server, name="race-agent")
        target = NetworkTarget.objects.create(
            name="t", hostname_or_ip="192.0.2.1", protocol="tcp", port=443,
            assigned_agent=agent,
        )
        items = [measurement(target) for _ in range(50)]
        body = json.dumps({"network": {"version": 1, "measurements": items}})
        barrier = threading.Barrier(3)
        responses, errors = [], []

        def worker():
            try:
                barrier.wait(timeout=5)
                response = Client().post(
                    reverse("agent-heartbeat"), data=body,
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {token}",
                )
                responses.append(response.json())
            except Exception as exc:  # noqa: BLE001 - surfaced via assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(errors, [])
        self.assertEqual(NetworkMeasurement.objects.count(), 50)
        created = sum(r["network_created"] for r in responses)
        duplicates = sum(r["network_duplicates"] for r in responses)
        self.assertEqual(created, 50)
        self.assertEqual(duplicates, 100)
        for response in responses:
            self.assertEqual(response["network"], "accepted")
            self.assertEqual(len(response["network_results"]), 50)

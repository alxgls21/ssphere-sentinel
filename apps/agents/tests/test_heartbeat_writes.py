import json
import threading
from datetime import timedelta

from django.db import connection
from django.test import Client, TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import Server, ServerTelemetry


def table_statements(captured, table):
    return [
        q["sql"].split(None, 1)[0]
        for q in captured
        if f'"{table}"' in q["sql"]
    ]


class HeartbeatWriteTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="hb", hostname="hb.local")
        self.agent, self.token = create_agent(server=self.server, name="hb-agent")
        self.url = reverse("agent-heartbeat")

    def _post(self, body=None):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {self.token}"}
        with CaptureQueriesContext(connection) as ctx:
            if body is None:
                response = self.client.post(self.url, **headers)
            else:
                response = self.client.post(
                    self.url, data=json.dumps(body), content_type="application/json",
                    **headers,
                )
        self.assertEqual(response.status_code, 200)
        return ctx.captured_queries

    def test_every_heartbeat_refreshes_liveness(self):
        stale = timezone.now() - timedelta(hours=1)
        Agent.objects.filter(pk=self.agent.pk).update(last_seen_at=stale)
        Server.objects.filter(pk=self.server.pk).update(
            last_seen_at=stale, status=Server.Status.OFFLINE
        )
        for _ in range(2):
            before = timezone.now()
            self._post()
            self.agent.refresh_from_db()
            self.server.refresh_from_db()
            self.assertGreaterEqual(self.agent.last_seen_at, before)
            self.assertEqual(self.server.last_seen_at, self.agent.last_seen_at)
            self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_liveness_costs_one_update_per_row(self):
        captured = self._post()
        self.assertEqual(table_statements(captured, "agents_agent").count("UPDATE"), 1)
        self.assertEqual(
            table_statements(captured, "infrastructure_server").count("UPDATE"), 1
        )

    def test_steady_state_telemetry_is_a_single_update(self):
        self._post({"telemetry": valid_telemetry(cpu_percent=10.0)})
        captured = self._post({"telemetry": valid_telemetry(cpu_percent=20.0)})
        self.assertEqual(
            table_statements(captured, "infrastructure_servertelemetry"), ["UPDATE"]
        )
        self.assertEqual(ServerTelemetry.objects.get().cpu_percent, 20.0)

    def test_first_telemetry_creates_the_snapshot(self):
        captured = self._post({"telemetry": valid_telemetry()})
        self.assertEqual(
            table_statements(captured, "infrastructure_servertelemetry"),
            ["UPDATE", "INSERT"],
        )
        self.assertEqual(ServerTelemetry.objects.count(), 1)


class ConcurrentFirstTelemetryTests(TransactionTestCase):
    def test_concurrent_first_reports_create_one_snapshot(self):
        server = Server.objects.create(name="race", hostname="race.local")
        _agent, token = create_agent(server=server, name="race-agent")
        barrier = threading.Barrier(4)
        statuses, errors = [], []

        def worker(cpu):
            try:
                barrier.wait(timeout=5)
                response = Client().post(
                    reverse("agent-heartbeat"),
                    data=json.dumps({"telemetry": valid_telemetry(cpu_percent=cpu)}),
                    content_type="application/json",
                    HTTP_AUTHORIZATION=f"Bearer {token}",
                )
                statuses.append(response.json().get("telemetry"))
            except Exception as exc:  # noqa: BLE001 - surfaced via assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=(cpu,)) for cpu in (1, 2, 3, 4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertEqual(statuses, ["accepted"] * 4)
        self.assertEqual(ServerTelemetry.objects.count(), 1)
        self.assertIn(ServerTelemetry.objects.get().cpu_percent, {1.0, 2.0, 3.0, 4.0})

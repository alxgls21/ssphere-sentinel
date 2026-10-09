import threading
from datetime import timedelta

from django.db import connection
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.agents.services import create_agent
from apps.infrastructure.docker_reports import apply_docker_report, validate_docker_payload
from apps.infrastructure.models import DockerContainer, DockerHostState, Server

CONTAINER_TABLE = '"infrastructure_dockercontainer"'
CREATED = (timezone.now() - timedelta(days=2)).isoformat()


def container(index, **overrides):
    payload = {
        "container_id": f"{index:064x}",
        "name": f"c{index}",
        "image": "nginx:latest",
        "state": "running",
        "health": "none",
        "created_at": CREATED,
        "started_at": CREATED,
    }
    payload.update(overrides)
    return payload


def report(containers=(), *, status="available"):
    available = status == "available"
    return validate_docker_payload(
        {
            "version": 1,
            "available": available,
            "status": status,
            "collected_at": timezone.now().isoformat(),
            "containers": list(containers) if available else [],
        }
    )


def container_writes(captured):
    return [
        query["sql"]
        for query in captured
        if CONTAINER_TABLE in query["sql"]
        and query["sql"].split(None, 1)[0] in {"INSERT", "UPDATE", "DELETE"}
    ]


class DockerSyncTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(name="sync-host", hostname="sync.local")
        self.t0 = timezone.now() - timedelta(hours=1)

    def _apply(self, docker_report, minutes):
        received = self.t0 + timedelta(minutes=minutes)
        apply_docker_report(self.server, docker_report, received_at=received)
        return received

    def _containers(self):
        return {row.container_id: row for row in DockerContainer.objects.all()}

    def test_new_containers_are_bulk_created(self):
        with CaptureQueriesContext(connection) as ctx:
            self._apply(report([container(i) for i in range(10)]), 0)
        writes = container_writes(ctx.captured_queries)
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0].startswith("INSERT"))
        self.assertEqual(DockerContainer.objects.filter(present=True).count(), 10)

    def test_unchanged_containers_are_not_written(self):
        items = [container(i) for i in range(50)]
        first = self._apply(report(items), 0)
        with CaptureQueriesContext(connection) as ctx:
            second = self._apply(report(items), 1)
        self.assertEqual(container_writes(ctx.captured_queries), [])
        for row in DockerContainer.objects.all():
            self.assertEqual(row.received_at, first)
            self.assertTrue(row.present)
        host = DockerHostState.objects.get(server=self.server)
        self.assertEqual(host.last_discovered_at, second)
        self.assertEqual(host.received_at, second)

    def test_query_count_does_not_scale_with_container_count(self):
        small, large = Server.objects.create(name="s", hostname="s"), self.server
        apply_docker_report(small, report([container(i) for i in range(5)]))
        apply_docker_report(large, report([container(i) for i in range(200)]))
        with CaptureQueriesContext(connection) as small_ctx:
            apply_docker_report(small, report([container(i, state="exited") for i in range(5)]))
        with CaptureQueriesContext(connection) as large_ctx:
            apply_docker_report(large, report([container(i, state="exited") for i in range(200)]))
        self.assertEqual(len(small_ctx.captured_queries), len(large_ctx.captured_queries))

    def test_only_changed_containers_are_updated(self):
        items = [container(i) for i in range(10)]
        self._apply(report(items), 0)
        items[3] = container(3, state="exited", health="unhealthy")
        items[7] = container(7, image="nginx:1.27")
        with CaptureQueriesContext(connection) as ctx:
            second = self._apply(report(items), 1)
        writes = container_writes(ctx.captured_queries)
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0].startswith("UPDATE"))
        rows = self._containers()
        changed = {f"{3:064x}", f"{7:064x}"}
        for cid, row in rows.items():
            expected = second if cid in changed else self.t0
            self.assertEqual(row.received_at, expected, cid)
        self.assertEqual(rows[f"{3:064x}"].state, "exited")
        self.assertEqual(rows[f"{3:064x}"].health, "unhealthy")
        self.assertEqual(rows[f"{7:064x}"].image, "nginx:1.27")
        self.assertEqual(rows[f"{7:064x}"].last_seen_at, second)

    def test_health_and_state_transitions_are_recorded(self):
        cid = f"{1:064x}"
        transitions = [
            ("running", "starting"),
            ("running", "healthy"),
            ("running", "unhealthy"),
            ("restarting", "unhealthy"),
            ("exited", "none"),
        ]
        for minute, (state, health) in enumerate(transitions):
            self._apply(report([container(1, state=state, health=health)]), minute)
            row = DockerContainer.objects.get(container_id=cid)
            self.assertEqual((row.state, row.health), (state, health))

    def test_missing_containers_become_absent_with_last_discovery_time(self):
        self._apply(report([container(1), container(2)]), 0)
        previous = self._apply(report([container(1), container(2)]), 1)
        third = self._apply(report([container(1)]), 2)
        rows = self._containers()
        gone = rows[f"{2:064x}"]
        self.assertFalse(gone.present)
        # Last seen in the previous successful discovery, not when it vanished.
        self.assertEqual(gone.last_seen_at, previous)
        self.assertEqual(gone.received_at, third)
        self.assertEqual(gone.effective_last_seen_at, previous)
        kept = rows[f"{1:064x}"]
        self.assertTrue(kept.present)
        self.assertEqual(kept.effective_last_seen_at, third)

    def test_empty_successful_discovery_marks_all_absent(self):
        self._apply(report([container(i) for i in range(3)]), 0)
        self._apply(report([]), 1)
        self.assertFalse(DockerContainer.objects.filter(present=True).exists())
        self.assertEqual(DockerContainer.objects.count(), 3)

    def test_failed_discovery_preserves_containers(self):
        self._apply(report([container(1), container(2)]), 0)
        discovered = DockerHostState.objects.get().last_discovered_at
        before = list(DockerContainer.objects.values().order_by("container_id"))
        for minute, status in enumerate(("unavailable", "permission_denied", "error"), 1):
            with CaptureQueriesContext(connection) as ctx:
                self._apply(report(status=status), minute)
            self.assertEqual(container_writes(ctx.captured_queries), [], status)
            host = DockerHostState.objects.get()
            self.assertEqual(host.status, status)
            self.assertFalse(host.available)
            self.assertEqual(host.last_discovered_at, discovered)
        self.assertEqual(
            list(DockerContainer.objects.values().order_by("container_id")), before
        )

    def test_absence_after_outage_uses_last_successful_discovery(self):
        self._apply(report([container(1), container(2)]), 0)
        self._apply(report(status="unavailable"), 30)
        self._apply(report([container(1)]), 60)
        gone = DockerContainer.objects.get(container_id=f"{2:064x}")
        self.assertFalse(gone.present)
        self.assertEqual(gone.last_seen_at, self.t0)

    def test_reappearing_container_is_present_again(self):
        self._apply(report([container(1)]), 0)
        self._apply(report([]), 1)
        back = self._apply(report([container(1)]), 2)
        row = DockerContainer.objects.get()
        self.assertTrue(row.present)
        self.assertEqual(row.last_seen_at, back)
        self.assertEqual(DockerContainer.objects.count(), 1)

    def test_repeated_identical_reports_are_idempotent(self):
        items = [container(i) for i in range(5)]
        for minute in range(5):
            self._apply(report(items), minute)
        self.assertEqual(DockerContainer.objects.count(), 5)
        self.assertEqual(DockerHostState.objects.count(), 1)
        self.assertEqual(
            set(DockerContainer.objects.values_list("received_at", flat=True)), {self.t0}
        )

    def test_rows_from_before_last_discovered_at_keep_their_last_seen(self):
        # Containers stored before this field existed (host value is NULL).
        self._apply(report([container(1)]), 0)
        DockerHostState.objects.update(last_discovered_at=None)
        DockerContainer.objects.update(last_seen_at=self.t0 + timedelta(minutes=5))
        self._apply(report([]), 10)
        row = DockerContainer.objects.get()
        self.assertFalse(row.present)
        self.assertEqual(row.last_seen_at, self.t0 + timedelta(minutes=5))

    def test_containers_are_scoped_per_server(self):
        other = Server.objects.create(name="other", hostname="other.local")
        apply_docker_report(other, report([container(1)]))
        self._apply(report([container(1)]), 0)
        self._apply(report([]), 1)
        self.assertTrue(DockerContainer.objects.get(server=other).present)
        self.assertFalse(DockerContainer.objects.get(server=self.server).present)


class ConcurrentDockerReportTests(TransactionTestCase):
    def setUp(self):
        self.server = Server.objects.create(name="race-host", hostname="race.local")
        create_agent(server=self.server, name="race-agent")

    def _run_concurrently(self, reports):
        barrier = threading.Barrier(len(reports))
        errors = []

        def worker(docker_report):
            try:
                barrier.wait(timeout=5)
                apply_docker_report(Server.objects.get(pk=self.server.pk), docker_report)
            except Exception as exc:  # noqa: BLE001 - surfaced via assertion
                errors.append(exc)
            finally:
                connection.close()

        threads = [threading.Thread(target=worker, args=(r,)) for r in reports]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])

    def test_concurrent_first_reports_do_not_conflict(self):
        items = [container(i) for i in range(20)]
        self._run_concurrently([report(items) for _ in range(4)])
        self.assertEqual(DockerHostState.objects.count(), 1)
        self.assertEqual(DockerContainer.objects.filter(present=True).count(), 20)

    def test_concurrent_differing_reports_leave_a_consistent_state(self):
        apply_docker_report(self.server, report([container(i) for i in range(10)]))
        self._run_concurrently(
            [
                report([container(i) for i in range(5)]),
                report([container(i) for i in range(5, 15)]),
            ]
        )
        rows = {row.container_id: row.present for row in DockerContainer.objects.all()}
        present = {cid for cid, is_present in rows.items() if is_present}
        # Reports are serialized: the final state equals one complete report.
        self.assertIn(
            present,
            [
                {f"{i:064x}" for i in range(5)},
                {f"{i:064x}" for i in range(5, 15)},
            ],
        )
        self.assertEqual(len(rows), 15)

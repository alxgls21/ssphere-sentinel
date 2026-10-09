import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.infrastructure.docker_reports import apply_docker_report
from apps.infrastructure.models import DockerContainer, Server
from apps.infrastructure.tests.test_docker_sync import container, report
from apps.network.models import NetworkMeasurement, NetworkTarget

MAX_CHANGELIST_QUERIES = 10


class AdminQueryCountTests(TestCase):
    """Admin pages must not issue per-row queries (N+1)."""

    def setUp(self):
        user = get_user_model().objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(user)
        self.hosts = 0

    def _add_hosts(self, count, *, docker=True):
        for _ in range(count):
            self.hosts += 1
            server = Server.objects.create(name=f"host-{self.hosts}", hostname="h.local")
            agent, _ = create_agent(server=server, name=f"agent-{self.hosts}")
            if docker:
                apply_docker_report(server, report([container(i) for i in range(3)]))
            target = NetworkTarget.objects.create(
                name=f"t-{self.hosts}", hostname_or_ip="192.0.2.1", protocol="tcp",
                port=443, assigned_agent=agent,
            )
            now = timezone.now()
            NetworkMeasurement.objects.bulk_create(
                NetworkMeasurement(
                    id=uuid.uuid4(), target=target, agent=agent,
                    measured_at=now - timedelta(minutes=n), received_at=now,
                    success=True, latency_ms=1.0, packet_loss_percentage=0.0,
                    probe_count=4, successful_probes=4,
                )
                for n in range(4)
            )

    def _queries(self, url):
        with CaptureQueriesContext(connection) as ctx:
            response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        return len(ctx.captured_queries)

    def _assert_constant(self, url):
        self._add_hosts(2)
        small = self._queries(url)
        self._add_hosts(8, docker=False)
        self._add_hosts(5)
        large = self._queries(url)
        self.assertEqual(small, large, url)
        self.assertLessEqual(large, MAX_CHANGELIST_QUERIES, url)

    def test_server_changelist(self):
        self._assert_constant(reverse("admin:infrastructure_server_changelist"))

    def test_docker_container_changelist(self):
        self._assert_constant(reverse("admin:infrastructure_dockercontainer_changelist"))

    def test_network_target_changelist(self):
        self._assert_constant(reverse("admin:network_networktarget_changelist"))

    def test_network_measurement_changelist(self):
        self._assert_constant(reverse("admin:network_networkmeasurement_changelist"))

    def test_measurement_changelist_with_detached_history(self):
        self._add_hosts(3)
        Server.objects.first().delete()
        self._queries(reverse("admin:network_networkmeasurement_changelist"))

    def test_server_change_page_with_many_containers(self):
        server = Server.objects.create(name="big", hostname="big.local")
        apply_docker_report(server, report([container(i) for i in range(3)]))
        url = reverse("admin:infrastructure_server_change", args=[server.pk])
        self._queries(url)  # warm Django's content-type cache
        small = self._queries(url)
        apply_docker_report(server, report([container(i) for i in range(30)]))
        self.assertEqual(self._queries(url), small)

    def test_container_last_seen_column_shows_last_discovery(self):
        server = Server.objects.create(name="seen", hostname="seen.local")
        first = timezone.now() - timedelta(hours=2)
        latest = timezone.now() - timedelta(minutes=1)
        apply_docker_report(server, report([container(1)]), received_at=first)
        apply_docker_report(server, report([container(1)]), received_at=latest)
        row = DockerContainer.objects.select_related("server__docker_host").get()
        self.assertEqual(row.last_seen_at, first)
        self.assertEqual(row.effective_last_seen_at, latest)

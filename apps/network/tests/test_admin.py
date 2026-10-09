import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.network.models import NetworkMeasurement, NetworkTarget


def make_measurements(target, count, *, start=None):
    start = start or timezone.now() - timedelta(days=1)
    return NetworkMeasurement.objects.bulk_create(
        NetworkMeasurement(
            id=uuid.uuid4(),
            target=target,
            agent=target.assigned_agent,
            measured_at=start + timedelta(minutes=index),
            received_at=start + timedelta(minutes=index),
            success=True,
            latency_ms=float(index),
            packet_loss_percentage=0.0,
            probe_count=4,
            successful_probes=4,
        )
        for index in range(count)
    )


class NetworkTargetAdminTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser(
            username="admin", email="admin@example.com", password="unused"
        )
        self.client.force_login(self.user)
        self.server = Server.objects.create(name="admin-host", hostname="admin.local")
        self.agent, _token = create_agent(server=self.server, name="admin-agent")
        self.add_url = reverse("admin:network_networktarget_add")

    def _form_data(self, **overrides):
        data = {
            "name": "edge-router",
            "hostname_or_ip": "192.0.2.10",
            "protocol": NetworkTarget.Protocol.TCP,
            "port": "443",
            "enabled": "on",
            "assigned_agent": str(self.agent.pk),
            "monitoring_interval_seconds": "60",
            "timeout_seconds": "2",
            "expected_sla_percentage": "99.90",
            "customer_name": "",
            "circuit_identifier": "",
        }
        data.update(overrides)
        return data

    def _create_target(self, **overrides):
        values = {
            "name": "existing",
            "hostname_or_ip": "1.1.1.1",
            "protocol": NetworkTarget.Protocol.TCP,
            "port": 443,
            "assigned_agent": self.agent,
        }
        values.update(overrides)
        return NetworkTarget.objects.create(**values)

    def test_add_page_renders(self):
        response = self.client.get(self.add_url)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('name="id"', response.content.decode())

    def test_successful_creation_generates_and_reports_uuid(self):
        response = self.client.post(self.add_url, self._form_data(), follow=True)
        self.assertEqual(response.status_code, 200)
        target = NetworkTarget.objects.get(name="edge-router")
        self.assertIsInstance(target.pk, uuid.UUID)
        self.assertEqual(target.assigned_agent, self.agent)
        messages = [str(message) for message in response.context["messages"]]
        self.assertTrue(any(str(target.pk) in message for message in messages))

    def test_creation_keeps_model_validation(self):
        response = self.client.post(self.add_url, self._form_data(port=""))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "TCP targets require a port.")
        self.assertFalse(NetworkTarget.objects.exists())

        response = self.client.post(
            self.add_url,
            self._form_data(protocol=NetworkTarget.Protocol.ICMP, port="7"),
        )
        self.assertContains(response, "ICMP targets must not set a port.")
        self.assertFalse(NetworkTarget.objects.exists())

    def test_change_page_shows_stable_uuid(self):
        target = self._create_target()
        url = reverse("admin:network_networktarget_change", args=[target.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, str(target.pk))
        self.assertNotIn('name="id"', response.content.decode())

        response = self.client.post(url, self._form_data(name="renamed"))
        self.assertEqual(response.status_code, 302)
        target.refresh_from_db()
        self.assertEqual(target.name, "renamed")
        self.assertEqual(NetworkTarget.objects.get().pk, target.pk)

    def test_change_page_without_measurements(self):
        target = self._create_target()
        response = self.client.get(
            reverse("admin:network_networktarget_change", args=[target.pk])
        )
        self.assertContains(response, "No measurements yet")

    def test_change_page_shows_latest_summary_and_history_link(self):
        target = self._create_target()
        rows = make_measurements(target, 3)
        response = self.client.get(
            reverse("admin:network_networktarget_change", args=[target.pk])
        )
        self.assertContains(response, rows[-1].measured_at.isoformat())
        self.assertContains(response, "latency: 2.0 ms")
        changelist = reverse("admin:network_networkmeasurement_changelist")
        self.assertContains(response, f"{changelist}?target__id__exact={target.pk}")

    def test_large_history_does_not_load_measurement_rows(self):
        target = self._create_target()
        url = reverse("admin:network_networktarget_change", args=[target.pk])
        make_measurements(target, 1)
        with CaptureQueriesContext(connection) as small:
            self.client.get(url)

        make_measurements(target, 2000, start=timezone.now() - timedelta(days=3))
        with CaptureQueriesContext(connection) as large:
            response = self.client.get(url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(large.captured_queries), len(small.captured_queries))
        self.assertNotContains(response, "networkmeasurement_set")
        self.assertNotContains(response, "measurements-TOTAL_FORMS")

    def test_history_link_filters_measurement_changelist(self):
        target = self._create_target()
        other = self._create_target(name="other", hostname_or_ip="1.1.1.2")
        make_measurements(target, 5)
        make_measurements(other, 3)
        changelist = reverse("admin:network_networkmeasurement_changelist")
        response = self.client.get(f"{changelist}?target__id__exact={target.pk}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["cl"].result_count, 5)

    def test_changelist_renders(self):
        target = self._create_target()
        make_measurements(target, 2)
        response = self.client.get(reverse("admin:network_networktarget_changelist"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, target.name)

import uuid
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.core.retention import delete_in_batches
from apps.infrastructure.models import Server
from apps.network.models import NetworkMeasurement, NetworkTarget

FROZEN_NOW = timezone.now()


def add_measurements(target, ages):
    NetworkMeasurement.objects.bulk_create(
        NetworkMeasurement(
            id=uuid.uuid4(),
            target=target,
            agent=target.assigned_agent,
            measured_at=FROZEN_NOW - age,
            received_at=FROZEN_NOW - age,
            success=True,
            latency_ms=1.0,
            packet_loss_percentage=0.0,
            probe_count=1,
            successful_probes=1,
        )
        for age in ages
    )


@override_settings(SENTINEL_NETWORK_MEASUREMENT_RETENTION_DAYS=7)
@patch("django.utils.timezone.now", return_value=FROZEN_NOW)
class BatchedMeasurementRetentionTests(TestCase):
    def setUp(self):
        server = Server.objects.create(name="retain", hostname="retain.local")
        self.agent, self.token = create_agent(server=server, name="retain-agent")
        self.target = NetworkTarget.objects.create(
            name="t", hostname_or_ip="192.0.2.1", protocol="tcp", port=443,
            assigned_agent=self.agent,
        )

    def _purge(self, **options):
        out = StringIO()
        call_command("purge_network_measurements", stdout=out, stderr=out, **options)
        return out.getvalue()

    def test_retention_boundary_is_exclusive(self, _now):
        boundary = timedelta(days=7)
        add_measurements(
            self.target,
            [boundary + timedelta(microseconds=1), boundary, boundary - timedelta(seconds=1)],
        )
        self._purge()
        remaining = sorted(
            FROZEN_NOW - m for m in NetworkMeasurement.objects.values_list("measured_at", flat=True)
        )
        self.assertEqual(remaining, [boundary - timedelta(seconds=1), boundary])

    def test_deletes_in_bounded_batches(self, _now):
        add_measurements(self.target, [timedelta(days=10, minutes=i) for i in range(25)])
        add_measurements(self.target, [timedelta(days=1)] * 3)
        output = self._purge(batch_size=10)
        self.assertIn("Deleted 25 measurement row(s)", output)
        self.assertIn("in 3 batch(es)", output)
        self.assertEqual(NetworkMeasurement.objects.count(), 3)

    def test_each_batch_issues_bounded_deletes(self, _now):
        add_measurements(self.target, [timedelta(days=10, minutes=i) for i in range(12)])
        with self.assertNumQueries(6):
            # (select ids + delete) for batches of 5, 5 and 2.
            deleted, batches = delete_in_batches(
                NetworkMeasurement.objects.filter(measured_at__lt=FROZEN_NOW - timedelta(days=7)),
                batch_size=5,
            )
        self.assertEqual((deleted, batches), (12, 3))

    def test_nothing_to_delete(self, _now):
        add_measurements(self.target, [timedelta(days=1)])
        output = self._purge()
        self.assertIn("Deleted 0 measurement row(s)", output)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_days_override_and_dry_run(self, _now):
        add_measurements(self.target, [timedelta(days=3), timedelta(days=1)])
        output = self._purge(days=2, dry_run=True)
        self.assertIn("Would delete 1 measurement(s)", output)
        self.assertEqual(NetworkMeasurement.objects.count(), 2)
        self._purge(days=2)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_invalid_batch_size_is_refused(self, _now):
        add_measurements(self.target, [timedelta(days=10)])
        for size in (0, -1, 100_001):
            self.assertIn("--batch-size must be between", self._purge(batch_size=size))
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

    def test_heartbeats_never_trigger_retention(self, _now):
        add_measurements(self.target, [timedelta(days=60)])
        response = Client().post(
            reverse("agent-heartbeat"), HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(NetworkMeasurement.objects.count(), 1)

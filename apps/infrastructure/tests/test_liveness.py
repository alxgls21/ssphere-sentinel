from datetime import timedelta

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.infrastructure.liveness import evaluate_effective_status
from apps.infrastructure.models import Server


class ServerLivenessTests(TestCase):
    def setUp(self):
        self.now = timezone.now()

    def test_never_seen_server_is_unknown(self):
        server = Server.objects.create(name="new-host", hostname="new.local")
        self.assertIsNone(server.last_seen_at)
        self.assertEqual(server.effective_status, Server.Status.UNKNOWN)
        self.assertEqual(
            evaluate_effective_status(server, now=self.now),
            Server.Status.UNKNOWN,
        )

    def test_fresh_heartbeat_is_online(self):
        server = Server.objects.create(
            name="fresh-host",
            hostname="fresh.local",
            status=Server.Status.ONLINE,
            last_seen_at=self.now - timedelta(seconds=30),
        )
        self.assertEqual(
            evaluate_effective_status(
                server,
                now=self.now,
                threshold_seconds=90,
            ),
            Server.Status.ONLINE,
        )
        self.assertEqual(server.effective_status, Server.Status.ONLINE)

    def test_stale_heartbeat_is_offline(self):
        server = Server.objects.create(
            name="stale-host",
            hostname="stale.local",
            status=Server.Status.ONLINE,
            last_seen_at=self.now - timedelta(seconds=91),
        )
        self.assertEqual(
            evaluate_effective_status(
                server,
                now=self.now,
                threshold_seconds=90,
            ),
            Server.Status.OFFLINE,
        )

    @override_settings(SENTINEL_OFFLINE_THRESHOLD=60)
    def test_threshold_configuration(self):
        server = Server.objects.create(
            name="threshold-host",
            hostname="threshold.local",
            last_seen_at=self.now - timedelta(seconds=61),
        )
        self.assertEqual(server.effective_status, Server.Status.OFFLINE)

        server.last_seen_at = self.now - timedelta(seconds=59)
        server.save(update_fields=["last_seen_at", "updated_at"])
        self.assertEqual(server.effective_status, Server.Status.ONLINE)

    def test_boundary_exactly_at_threshold_is_online(self):
        server = Server.objects.create(
            name="edge-host",
            hostname="edge.local",
            last_seen_at=self.now - timedelta(seconds=90),
        )
        self.assertEqual(
            evaluate_effective_status(
                server,
                now=self.now,
                threshold_seconds=90,
            ),
            Server.Status.ONLINE,
        )

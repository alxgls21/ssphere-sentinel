import uuid
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.db import IntegrityError
from django.test import TestCase
from django.utils import timezone

from apps.infrastructure.models import Server


class ServerModelTests(TestCase):
    def test_create_server_with_required_fields(self):
        server = Server.objects.create(name="edge-1", hostname="edge-1.local")

        self.assertIsInstance(server.id, uuid.UUID)
        self.assertEqual(server.name, "edge-1")
        self.assertEqual(server.hostname, "edge-1.local")
        self.assertEqual(server.description, "")
        self.assertEqual(server.operating_system, "")
        self.assertIsNone(server.ip_address)
        self.assertEqual(server.status, Server.Status.UNKNOWN)
        self.assertIsNone(server.last_seen_at)
        self.assertIsNotNone(server.created_at)
        self.assertIsNotNone(server.updated_at)

    def test_str_returns_name(self):
        server = Server.objects.create(name="db-primary", hostname="db-1.internal")

        self.assertEqual(str(server), "db-primary")

    def test_status_choices(self):
        self.assertEqual(
            set(Server.Status.values),
            {"unknown", "online", "offline", "warning"},
        )

    def test_status_can_be_updated(self):
        server = Server.objects.create(name="web-1", hostname="web-1.local")
        seen_at = timezone.now()

        server.status = Server.Status.ONLINE
        server.last_seen_at = seen_at
        server.save(update_fields=["status", "last_seen_at", "updated_at"])
        server.refresh_from_db()

        self.assertEqual(server.status, Server.Status.ONLINE)
        self.assertEqual(server.last_seen_at, seen_at)

    def test_optional_fields_accept_values(self):
        server = Server.objects.create(
            name="monitor-host",
            hostname="monitor.example.com",
            description="Primary monitoring host",
            operating_system="Ubuntu 24.04",
            ip_address="203.0.113.10",
            status=Server.Status.WARNING,
            last_seen_at=timezone.now() - timedelta(minutes=5),
        )

        server.full_clean()
        self.assertEqual(server.operating_system, "Ubuntu 24.04")
        self.assertEqual(server.ip_address, "203.0.113.10")
        self.assertEqual(server.status, Server.Status.WARNING)

    def test_ipv6_address_is_accepted(self):
        server = Server(
            name="ipv6-host",
            hostname="ipv6.example.com",
            ip_address="2001:db8::1",
        )

        server.full_clean()
        server.save()
        self.assertEqual(server.ip_address, "2001:db8::1")

    def test_invalid_ip_address_raises_validation_error(self):
        server = Server(
            name="bad-ip",
            hostname="bad.example.com",
            ip_address="not-an-ip",
        )

        with self.assertRaises(ValidationError):
            server.full_clean()

    def test_name_must_be_unique(self):
        Server.objects.create(name="unique-server", hostname="a.local")

        with self.assertRaises(IntegrityError):
            Server.objects.create(name="unique-server", hostname="b.local")

    def test_default_ordering_is_by_name(self):
        Server.objects.create(name="zeta", hostname="zeta.local")
        Server.objects.create(name="alpha", hostname="alpha.local")
        Server.objects.create(name="beta", hostname="beta.local")

        names = list(Server.objects.values_list("name", flat=True))
        self.assertEqual(names, ["alpha", "beta", "zeta"])

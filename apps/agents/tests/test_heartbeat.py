from datetime import timedelta

from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.agents.tokens import hash_token
from apps.infrastructure.models import Server


class AgentHeartbeatAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(
            name="edge-1",
            hostname="edge-1.local",
            status=Server.Status.UNKNOWN,
        )
        self.agent, self.raw_token = create_agent(
            server=self.server,
            name="server-agent",
        )

    def _auth_headers(self, token: str) -> dict[str, str]:
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_valid_heartbeat(self):
        response = self.client.post(self.url, **self._auth_headers(self.raw_token))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

        self.agent.refresh_from_db()
        self.server.refresh_from_db()
        self.assertIsNotNone(self.agent.last_seen_at)
        self.assertIsNotNone(self.server.last_seen_at)
        self.assertEqual(self.agent.last_seen_at, self.server.last_seen_at)
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_heartbeat_updates_timestamps(self):
        earlier = timezone.now() - timedelta(hours=1)
        Agent.objects.filter(pk=self.agent.pk).update(last_seen_at=earlier)
        Server.objects.filter(pk=self.server.pk).update(
            last_seen_at=earlier,
            status=Server.Status.OFFLINE,
        )

        response = self.client.post(self.url, **self._auth_headers(self.raw_token))
        self.assertEqual(response.status_code, 200)

        self.agent.refresh_from_db()
        self.server.refresh_from_db()
        self.assertGreater(self.agent.last_seen_at, earlier)
        self.assertGreater(self.server.last_seen_at, earlier)
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_invalid_token(self):
        response = self.client.post(
            self.url,
            **self._auth_headers("not-a-valid-token"),
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json(),
            {"detail": "Invalid authentication credentials."},
        )
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.UNKNOWN)

    def test_missing_token(self):
        response = self.client.post(self.url)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json(),
            {"detail": "Authentication credentials were not provided."},
        )

    def test_malformed_authorization_header(self):
        response = self.client.post(
            self.url,
            HTTP_AUTHORIZATION="Token not-bearer",
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json(),
            {"detail": "Invalid authentication credentials."},
        )

    def test_disabled_agent(self):
        self.agent.enabled = False
        self.agent.save(update_fields=["enabled", "updated_at"])

        response = self.client.post(self.url, **self._auth_headers(self.raw_token))

        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json(),
            {"detail": "Invalid authentication credentials."},
        )
        self.server.refresh_from_db()
        self.assertEqual(self.server.status, Server.Status.UNKNOWN)

    def test_raw_token_is_not_stored(self):
        self.assertNotEqual(self.agent.token_hash, self.raw_token)
        self.assertEqual(self.agent.token_hash, hash_token(self.raw_token))
        self.assertFalse(
            Agent.objects.filter(token_hash=self.raw_token).exists()
        )

    def test_get_not_allowed(self):
        response = self.client.get(self.url, **self._auth_headers(self.raw_token))
        self.assertEqual(response.status_code, 405)

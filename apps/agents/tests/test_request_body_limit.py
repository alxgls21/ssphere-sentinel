"""The size of a heartbeat the server reads, which the agent has to stay under.

Django refuses a request whose ``Content-Length`` is above
``DATA_UPLOAD_MAX_MEMORY_SIZE`` when the view reads the body, with HTTP 400.
The view reads it before it records the liveness of the agent, so a heartbeat
over the limit records nothing at all: not the liveness, not the telemetry, not
the Docker inventory that was in the same request.
"""

from django.conf import settings
from django.test import Client, TestCase
from django.urls import reverse

from agent.http_client import MAX_REQUEST_BYTES
from apps.agents.services import create_agent
from apps.infrastructure.models import Server

# 2.5 MiB, Django's default. The agent's request budget is measured against this value.
LIMIT = 2_621_440
EMPTY_PADDING = '{"padding":""}'


class RequestBodyLimitTests(TestCase):
    def setUp(self):
        self.client = Client(raise_request_exception=False)
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="edge-1", hostname="edge-1.local")
        self.agent, self.token = create_agent(server=self.server, name="edge-agent")

    def post(self, size):
        """A JSON body of exactly ``size`` bytes (the server ignores the unknown key)."""
        body = EMPTY_PADDING.replace('""', '"' + "x" * (size - len(EMPTY_PADDING)) + '"')
        self.assertEqual(len(body), size)
        return self.client.post(
            self.url, data=body, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )

    def test_the_limit_is_djangos_default_and_the_settings_do_not_change_it(self):
        self.assertEqual(settings.DATA_UPLOAD_MAX_MEMORY_SIZE, LIMIT)

    def test_the_agents_request_budget_is_below_the_limit_and_a_request_of_that_size_is_accepted(self):
        self.assertLess(MAX_REQUEST_BYTES, settings.DATA_UPLOAD_MAX_MEMORY_SIZE)
        self.assertEqual(self.post(MAX_REQUEST_BYTES).status_code, 200)

    def test_a_body_of_exactly_the_limit_is_accepted(self):
        response = self.post(LIMIT)
        self.assertEqual((response.status_code, response.json()), (200, {"status": "ok"}))
        self.agent.refresh_from_db()
        self.assertIsNotNone(self.agent.last_seen_at)

    def test_a_body_one_byte_over_is_refused_and_records_nothing(self):
        with self.assertLogs("django.security.RequestDataTooBig", level="ERROR"):
            response = self.post(LIMIT + 1)
        self.assertEqual(response.status_code, 400)
        self.agent.refresh_from_db()
        self.server.refresh_from_db()
        self.assertIsNone(self.agent.last_seen_at)
        self.assertIsNone(self.server.last_seen_at)

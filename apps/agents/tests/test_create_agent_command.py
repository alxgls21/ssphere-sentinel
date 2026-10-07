from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from apps.agents.models import Agent
from apps.agents.tokens import hash_token
from apps.infrastructure.models import Server


class CreateAgentCommandTests(TestCase):
    def setUp(self):
        self.server = Server.objects.create(
            name="cmd-server",
            hostname="cmd.local",
        )

    def test_create_agent_prints_token_once_and_stores_hash(self):
        stdout = StringIO()
        call_command(
            "create_agent",
            server=str(self.server.id),
            name="server-agent",
            stdout=stdout,
        )
        output = stdout.getvalue()

        agent = Agent.objects.get(server=self.server)
        self.assertEqual(agent.name, "server-agent")

        # Final non-empty line is the raw token.
        lines = [line for line in output.splitlines() if line.strip()]
        raw_token = lines[-1]
        self.assertEqual(agent.token_hash, hash_token(raw_token))
        self.assertNotIn(raw_token, agent.token_hash)
        self.assertNotEqual(agent.token_hash, raw_token)

    def test_create_agent_rejects_duplicate(self):
        call_command(
            "create_agent",
            server=str(self.server.id),
            name="server-agent",
            stdout=StringIO(),
        )

        with self.assertRaises(CommandError):
            call_command(
                "create_agent",
                server=str(self.server.id),
                name="another-agent",
                stdout=StringIO(),
            )

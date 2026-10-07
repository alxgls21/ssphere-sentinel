from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from apps.agents.services import AgentAlreadyExistsError, create_agent
from apps.infrastructure.models import Server


class Command(BaseCommand):
    help = (
        "Create an agent for a server and print the raw authentication token "
        "once. The token is not stored in plaintext."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--server",
            required=True,
            help="UUID of the Server this agent belongs to.",
        )
        parser.add_argument(
            "--name",
            required=True,
            help="Human-readable agent name (for example: server-agent).",
        )

    def handle(self, *args, **options):
        server_id = options["server"]
        name = options["name"]

        try:
            server = Server.objects.get(pk=server_id)
        except ValidationError as exc:
            raise CommandError(f"Invalid server id: {server_id}") from exc
        except Server.DoesNotExist as exc:
            raise CommandError(f"Server not found: {server_id}") from exc

        try:
            agent, raw_token = create_agent(server=server, name=name)
        except AgentAlreadyExistsError as exc:
            raise CommandError(str(exc)) from exc

        self.stdout.write(self.style.SUCCESS(f"Created agent '{agent.name}' ({agent.id})"))
        self.stdout.write(f"Server: {server.name} ({server.id})")
        self.stdout.write("")
        self.stdout.write(
            self.style.WARNING(
                "Raw authentication token (copy now; it will not be shown again):"
            )
        )
        # Print token alone on its own line for easy scripting/copy.
        self.stdout.write(raw_token)

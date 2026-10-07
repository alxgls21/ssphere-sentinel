"""Domain operations for agent lifecycle and heartbeats."""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.tokens import generate_token, hash_token
from apps.infrastructure.models import Server


class AgentAlreadyExistsError(Exception):
    """Raised when the target server already has an agent."""


def create_agent(*, server: Server, name: str) -> tuple[Agent, str]:
    """Create an agent for a server and return (agent, raw_token).

    The raw token is returned exactly once to the caller and is never persisted.
    """
    if Agent.objects.filter(server=server).exists():
        raise AgentAlreadyExistsError(
            f"Server '{server.name}' already has an agent."
        )

    raw_token = generate_token()
    agent = Agent.objects.create(
        server=server,
        name=name,
        token_hash=hash_token(raw_token),
        enabled=True,
    )
    return agent, raw_token


@transaction.atomic
def record_heartbeat(agent: Agent) -> None:
    """Mark agent and its server as seen/online from a successful heartbeat."""
    now = timezone.now()
    Agent.objects.filter(pk=agent.pk).update(last_seen_at=now, updated_at=now)
    Server.objects.filter(pk=agent.server_id).update(
        last_seen_at=now,
        status=Server.Status.ONLINE,
        updated_at=now,
    )
    agent.last_seen_at = now
    agent.server.last_seen_at = now
    agent.server.status = Server.Status.ONLINE

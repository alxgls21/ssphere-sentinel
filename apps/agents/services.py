"""Domain operations for agent lifecycle and heartbeats."""

from __future__ import annotations

from django.db import IntegrityError, transaction
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

    agent = Agent(server=server, name=name, enabled=True)
    raw_token = assign_new_token(agent)
    try:
        with transaction.atomic():
            agent.save(force_insert=True)
    except IntegrityError as exc:
        # A concurrent create_agent for the same server won the race.
        raise AgentAlreadyExistsError(
            f"Server '{server.name}' already has an agent."
        ) from exc
    return agent, raw_token


def assign_new_token(agent: Agent) -> str:
    """Give ``agent`` a new token hash (unsaved) and return the raw token.

    The raw token is returned exactly once and is never stored or logged.
    """
    raw_token = generate_token()
    agent.token_hash = hash_token(raw_token)
    return raw_token


def rotate_token(agent: Agent) -> str:
    """Replace the agent's token; the previous token stops working at once."""
    raw_token = assign_new_token(agent)
    agent.save(update_fields=["token_hash", "updated_at"])
    return raw_token


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

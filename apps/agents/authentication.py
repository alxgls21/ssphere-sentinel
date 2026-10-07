"""Bearer-token authentication for agent API requests."""

from __future__ import annotations

from dataclasses import dataclass

from django.http import HttpRequest

from apps.agents.models import Agent
from apps.agents.tokens import hash_token

AUTH_HEADER = "HTTP_AUTHORIZATION"
BEARER_PREFIX = "Bearer "


@dataclass(frozen=True)
class AuthenticationResult:
    agent: Agent | None
    error: str | None


def extract_bearer_token(request: HttpRequest) -> str | None:
    """Extract the Bearer token from the Authorization header, if present."""
    header = request.META.get(AUTH_HEADER)
    if not header:
        return None
    if not header.startswith(BEARER_PREFIX):
        return None
    token = header[len(BEARER_PREFIX) :].strip()
    return token or None


def authenticate_agent(request: HttpRequest) -> AuthenticationResult:
    """Authenticate an agent from a Bearer token.

    Disabled agents and unknown tokens both yield the same generic error so
    callers cannot distinguish them.
    """
    raw_token = extract_bearer_token(request)
    if raw_token is None:
        if not request.META.get(AUTH_HEADER):
            return AuthenticationResult(
                agent=None,
                error="Authentication credentials were not provided.",
            )
        return AuthenticationResult(
            agent=None,
            error="Invalid authentication credentials.",
        )

    token_digest = hash_token(raw_token)
    try:
        agent = Agent.objects.select_related("server").get(token_hash=token_digest)
    except Agent.DoesNotExist:
        return AuthenticationResult(
            agent=None,
            error="Invalid authentication credentials.",
        )

    if not agent.enabled:
        return AuthenticationResult(
            agent=None,
            error="Invalid authentication credentials.",
        )

    return AuthenticationResult(agent=agent, error=None)

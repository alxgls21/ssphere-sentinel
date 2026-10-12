"""Agent-specific exceptions and safe error-message helpers."""


class AgentError(Exception):
    """Base class for agent failures."""


class ConfigError(AgentError):
    """Raised when required configuration is missing or invalid."""


class HeartbeatError(AgentError):
    """Raised when a heartbeat request fails."""


def redact(text: str, secret: str) -> str:
    """Replace every occurrence of ``secret`` in ``text`` (for printed errors)."""
    if secret and secret in text:
        return text.replace(secret, "***")
    return text

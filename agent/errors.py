"""Agent-specific exceptions."""


class AgentError(Exception):
    """Base class for agent failures."""


class ConfigError(AgentError):
    """Raised when required configuration is missing or invalid."""


class HeartbeatError(AgentError):
    """Raised when a heartbeat request fails."""

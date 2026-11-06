"""Agent-specific exceptions and safe error-message helpers."""


class AgentError(Exception):
    """Base class for agent failures."""


class ConfigError(AgentError):
    """Raised when required configuration is missing or invalid."""


class HeartbeatError(AgentError):
    """Raised when a heartbeat request fails."""


class RequestTooLargeError(HeartbeatError):
    """Raised, before anything is sent, for a request body over the size limit."""


def redact(text: str, secret: str) -> str:
    """Replace every occurrence of ``secret`` in ``text`` (for printed errors)."""
    if secret and secret in text:
        return text.replace(secret, "***")
    return text


MAX_SAFE_TEXT_LENGTH = 200


def safe_text(value: object, limit: int = MAX_SAFE_TEXT_LENGTH) -> str:
    """``value`` as one printable line of at most ``limit`` characters (``...`` marks a cut); ``-`` for None.

    For text from outside the agent (the server, or whatever answers in its place) on its way to a log
    line or an error message: every character that is not printable (line breaks, NUL, ESC, the other
    C0 and C1 controls) becomes a space, so it cannot start a journal entry of its own, give one a
    priority or move a terminal's cursor.
    """
    if value is None:
        return "-"
    text = "".join(char if char.isprintable() else " " for char in str(value))
    if len(text) > limit:
        text = text[:limit] + "..."
    return text

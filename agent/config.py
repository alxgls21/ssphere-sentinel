"""Load agent configuration from environment variables."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from urllib.parse import urlparse

from agent.errors import ConfigError

ENV_SENTINEL_URL = "SENTINEL_URL"
ENV_AGENT_TOKEN = "SENTINEL_AGENT_TOKEN"
ENV_HEARTBEAT_INTERVAL = "SENTINEL_HEARTBEAT_INTERVAL"
DEFAULT_HEARTBEAT_INTERVAL = 30
MAX_HEARTBEAT_INTERVAL = int(threading.TIMEOUT_MAX)


@dataclass(frozen=True)
class Config:
    sentinel_url: str
    agent_token: str = field(repr=False)  # a printed or logged Config never shows it
    heartbeat_interval: int = DEFAULT_HEARTBEAT_INTERVAL

    @property
    def heartbeat_url(self) -> str:
        return f"{self.sentinel_url}/api/v1/agent/heartbeat/"


def _parse_heartbeat_interval(raw: str) -> int:
    try:
        interval = int(raw.strip())
    except (TypeError, ValueError) as exc:
        raise ConfigError(
            f"{ENV_HEARTBEAT_INTERVAL} must be a positive integer"
        ) from exc
    if interval <= 0:
        raise ConfigError(
            f"{ENV_HEARTBEAT_INTERVAL} must be a positive integer"
        )
    if interval > MAX_HEARTBEAT_INTERVAL:
        # threading.Event.wait raises OverflowError above this.
        raise ConfigError(
            f"{ENV_HEARTBEAT_INTERVAL} must not exceed {MAX_HEARTBEAT_INTERVAL}"
        )
    return interval


def load_config(
    environ: dict[str, str] | None = None,
) -> Config:
    """Load and validate agent settings from the environment."""
    env = environ if environ is not None else os.environ
    raw_url = (env.get(ENV_SENTINEL_URL) or "").strip()
    token = (env.get(ENV_AGENT_TOKEN) or "").strip()

    if not raw_url:
        raise ConfigError(f"{ENV_SENTINEL_URL} is not set")
    if not token:
        raise ConfigError(f"{ENV_AGENT_TOKEN} is not set")
    if any(char.isspace() or not char.isprintable() for char in token):
        # Sentinel's tokens are URL-safe, so such a token cannot be one (a token pasted over two lines,
        # say), and http.client would refuse it with a message that repeats it. Never repeat it here.
        raise ConfigError(
            f"{ENV_AGENT_TOKEN} must not contain spaces, line breaks or control characters"
        )

    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError(
            f"{ENV_SENTINEL_URL} must be an absolute http(s) URL"
        )
    if "@" in parsed.netloc:
        # Credentials belong in SENTINEL_AGENT_TOKEN, never in a URL (it is
        # logged at startup).
        raise ConfigError(f"{ENV_SENTINEL_URL} must not contain credentials")
    if parsed.query or parsed.fragment or "?" in raw_url or "#" in raw_url:
        # The heartbeat path is appended to the URL, so a query or fragment
        # would end up in the middle of it.
        raise ConfigError(
            f"{ENV_SENTINEL_URL} must not contain a query string or fragment"
        )
    try:
        parsed.port
    except ValueError as exc:
        raise ConfigError(f"{ENV_SENTINEL_URL} has an invalid port") from exc

    interval_raw = env.get(ENV_HEARTBEAT_INTERVAL)
    if interval_raw is None or not str(interval_raw).strip():
        heartbeat_interval = DEFAULT_HEARTBEAT_INTERVAL
    else:
        heartbeat_interval = _parse_heartbeat_interval(str(interval_raw))

    return Config(
        sentinel_url=raw_url.rstrip("/"),
        agent_token=token,
        heartbeat_interval=heartbeat_interval,
    )


def uses_insecure_http(config: Config) -> bool:
    return urlparse(config.sentinel_url).scheme == "http"

"""Load agent configuration from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

from agent.errors import ConfigError

ENV_SENTINEL_URL = "SENTINEL_URL"
ENV_AGENT_TOKEN = "SENTINEL_AGENT_TOKEN"


@dataclass(frozen=True)
class Config:
    sentinel_url: str
    agent_token: str

    @property
    def heartbeat_url(self) -> str:
        return f"{self.sentinel_url}/api/v1/agent/heartbeat/"


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

    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError(
            f"{ENV_SENTINEL_URL} must be an absolute http(s) URL"
        )

    return Config(
        sentinel_url=raw_url.rstrip("/"),
        agent_token=token,
    )


def uses_insecure_http(config: Config) -> bool:
    return urlparse(config.sentinel_url).scheme == "http"

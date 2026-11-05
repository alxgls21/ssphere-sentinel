"""Deployment checks reported by ``manage.py check --deploy``."""

import ipaddress

from django.conf import settings
from django.core.checks import Tags, Warning, register


@register(Tags.security, deploy=True)
def check_deployment_configuration(app_configs, **kwargs):
    warnings = []
    if settings.AGENT_TOKEN_PEPPER.startswith(settings.PLACEHOLDER_SECRET_PREFIX):
        warnings.append(
            Warning(
                "AGENT_TOKEN_PEPPER still has the .env.example placeholder value.",
                hint=(
                    "Set a random pepper before creating agents. Changing it later "
                    "invalidates every agent token; regenerate them afterwards."
                ),
                id="sentinel.W001",
            )
        )
    if "*" in settings.ALLOWED_HOSTS:
        warnings.append(
            Warning(
                "DJANGO_ALLOWED_HOSTS contains '*', so any Host header is accepted.",
                hint="List the public hostname(s) of this server explicitly.",
                id="sentinel.W002",
            )
        )
    if settings.SENTINEL_URL.startswith("http://"):
        warnings.append(
            Warning(
                f"SENTINEL_URL is {settings.SENTINEL_URL}: passwords and session cookies cross the network "
                "unencrypted, and the cookies are not Secure.",
                hint="Use an https:// address with a TLS front end (docs/server-deployment.md), except on a "
                "trusted local network.",
                id="sentinel.W003",
            )
        )
    if settings.SENTINEL_CONSOLE_URL_IGNORED:
        warnings.append(
            Warning(
                "SENTINEL_CONSOLE_URL is set, but it is no longer read"
                + ("." if settings.SENTINEL_URL else ": the incident emails have no links to the console."),
                hint="Set SENTINEL_URL to the console's address (it also gives the emails their links), and "
                "remove SENTINEL_CONSOLE_URL from .env.",
                id="sentinel.W004",
            )
        )
    if settings.SENTINEL_URL.startswith("https://") and not _loopback(settings.SENTINEL_HTTP_BIND):
        warnings.append(
            Warning(
                f"SENTINEL_URL is https://, but the proxy service is published on "
                f"{settings.SENTINEL_HTTP_BIND or '0.0.0.0 (the default)'}: its plain-HTTP port can be reached "
                "without the TLS front end, around everything that front end enforces.",
                hint="With the TLS front end (Cloudflare Tunnel or a reverse proxy) on this host, set "
                "SENTINEL_HTTP_BIND=127.0.0.1 in .env and run docker compose up -d. With the front end on "
                "another host, make sure a firewall lets only that host reach the port.",
                id="sentinel.W005",
            )
        )
    return warnings


def _loopback(address: str) -> bool:
    """Whether ``address`` (as Compose takes it: an IP, IPv6 in brackets or not) is a loopback address."""
    try:
        return ipaddress.ip_address(address.strip().removeprefix("[").removesuffix("]")).is_loopback
    except ValueError:
        return False

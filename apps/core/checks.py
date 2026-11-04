"""Deployment checks reported by ``manage.py check --deploy``."""

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
    return warnings

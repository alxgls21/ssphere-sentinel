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
    return warnings

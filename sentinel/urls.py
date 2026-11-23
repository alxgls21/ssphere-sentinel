"""URL configuration for SSphere Sentinel."""

from django.urls import include, path

urlpatterns = [
    path("", include("apps.core.urls")),
    # Agents authenticate with bearer tokens, the console with sessions: two
    # separate APIs that share no authentication code.
    path("api/v1/agent/", include("apps.agents.urls")),
    path("api/v1/console/", include("apps.console.urls")),
]

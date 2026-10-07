"""URL configuration for SSphere Sentinel."""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("apps.core.urls")),
    path("api/v1/agent/", include("apps.agents.urls")),
]

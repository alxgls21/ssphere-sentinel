from django.urls import path

from apps.core.views import health, readiness

# Normally answered by apps.core.middleware.HealthCheckMiddleware first; the
# routes keep the URLs reversible and working without the middleware.
urlpatterns = [
    path("health/", health, name="health"),
    path("health/ready/", readiness, name="health-ready"),
]

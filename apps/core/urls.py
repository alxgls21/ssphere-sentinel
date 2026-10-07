from django.urls import path

from apps.core.views import health

urlpatterns = [
    path("health/", health, name="health"),
]

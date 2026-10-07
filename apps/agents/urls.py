from django.urls import path

from apps.agents.views import agent_heartbeat

urlpatterns = [
    path("heartbeat/", agent_heartbeat, name="agent-heartbeat"),
]

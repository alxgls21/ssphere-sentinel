import uuid

from django.db import models

from apps.infrastructure.models import Server


class Agent(models.Model):
    """Registered agent identity for a monitored server.

    One agent per server for now (OneToOne). If multiple agents per server are
    needed later, this can become a ForeignKey without changing Agent's own
    identity/token fields.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    server = models.OneToOneField(
        Server,
        on_delete=models.CASCADE,
        related_name="agent",
    )
    name = models.CharField(max_length=255)
    token_hash = models.CharField(max_length=64, unique=True)
    enabled = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    agent_version = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "agent"
        verbose_name_plural = "agents"

    def __str__(self) -> str:
        return f"{self.name} ({self.server.name})"

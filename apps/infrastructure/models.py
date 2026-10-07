import uuid

from django.db import models


class Server(models.Model):
    """A monitored host in the infrastructure inventory.

    This model is intentionally limited to server identity and reachability
    state. Agents, containers, metrics, services, and backups will relate to
    Server in later apps/models without requiring redesign of these core fields.
    """

    class Status(models.TextChoices):
        UNKNOWN = "unknown", "Unknown"
        ONLINE = "online", "Online"
        OFFLINE = "offline", "Offline"
        WARNING = "warning", "Warning"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, unique=True)
    hostname = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    operating_system = models.CharField(max_length=255, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.UNKNOWN,
        db_index=True,
    )
    last_seen_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "server"
        verbose_name_plural = "servers"
        indexes = [
            models.Index(fields=["hostname"]),
        ]

    def __str__(self) -> str:
        return self.name

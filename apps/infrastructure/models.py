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

    @property
    def effective_status(self) -> str:
        """Current liveness derived from ``last_seen_at`` and the offline threshold.

        Prefer this over the stored ``status`` field when deciding whether a
        server is presently reachable. See ``apps.infrastructure.liveness``.
        """
        from apps.infrastructure.liveness import evaluate_effective_status

        return evaluate_effective_status(self)


class ServerTelemetry(models.Model):
    """Latest host telemetry snapshot for a server (not a full time-series).

    Historical metrics are intentionally out of scope for this model. Each
    successful telemetry report upserts this one-to-one row.
    """

    server = models.OneToOneField(
        Server,
        on_delete=models.CASCADE,
        related_name="telemetry",
    )
    cpu_percent = models.FloatField()
    memory_total_bytes = models.BigIntegerField()
    memory_used_bytes = models.BigIntegerField()
    memory_percent = models.FloatField()
    disk_total_bytes = models.BigIntegerField()
    disk_used_bytes = models.BigIntegerField()
    disk_percent = models.FloatField()
    uptime_seconds = models.BigIntegerField()
    collected_at = models.DateTimeField()
    received_at = models.DateTimeField()

    class Meta:
        verbose_name = "server telemetry"
        verbose_name_plural = "server telemetry"

    def __str__(self) -> str:
        return f"Telemetry for {self.server.name}"


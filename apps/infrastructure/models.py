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


class DockerHostState(models.Model):
    """Latest Docker availability/status for a server (not historical)."""

    class Status(models.TextChoices):
        AVAILABLE = "available", "Available"
        UNAVAILABLE = "unavailable", "Unavailable"
        PERMISSION_DENIED = "permission_denied", "Permission denied"
        ERROR = "error", "Error"

    server = models.OneToOneField(
        Server,
        on_delete=models.CASCADE,
        related_name="docker_host",
    )
    available = models.BooleanField(default=False)
    status = models.CharField(max_length=32, choices=Status.choices)
    collected_at = models.DateTimeField()
    received_at = models.DateTimeField()
    # Every present container was seen at this time; see DockerContainer.
    last_discovered_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the last successful (authoritative) discovery was received.",
    )

    class Meta:
        verbose_name = "Docker host state"
        verbose_name_plural = "Docker host states"

    def __str__(self) -> str:
        return f"Docker on {self.server.name}: {self.status}"


class DockerContainer(models.Model):
    """Latest-known Docker container for a server (identified by container ID).

    Rows are only written when a container appears, changes, or disappears.
    ``last_seen_at`` is therefore exact for absent containers, while a present
    container was also seen at the server's ``DockerHostState.last_discovered_at``
    (see ``effective_last_seen_at``).
    """

    class State(models.TextChoices):
        RUNNING = "running", "Running"
        EXITED = "exited", "Exited"
        PAUSED = "paused", "Paused"
        RESTARTING = "restarting", "Restarting"
        CREATED = "created", "Created"
        DEAD = "dead", "Dead"
        UNKNOWN = "unknown", "Unknown"

    class Health(models.TextChoices):
        HEALTHY = "healthy", "Healthy"
        UNHEALTHY = "unhealthy", "Unhealthy"
        STARTING = "starting", "Starting"
        NONE = "none", "None"
        UNKNOWN = "unknown", "Unknown"

    server = models.ForeignKey(
        Server,
        on_delete=models.CASCADE,
        related_name="docker_containers",
        # Covered by the (server, container_id) unique index.
        db_index=False,
    )
    container_id = models.CharField(max_length=64)
    name = models.CharField(max_length=255)
    image = models.CharField(max_length=512)
    state = models.CharField(max_length=32, choices=State.choices)
    health = models.CharField(max_length=32, choices=Health.choices)
    container_created_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    present = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField()
    received_at = models.DateTimeField()

    class Meta:
        verbose_name = "Docker container"
        verbose_name_plural = "Docker containers"
        ordering = ["name", "container_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["server", "container_id"],
                name="uniq_server_docker_container_id",
            ),
        ]
        indexes = [
            models.Index(fields=["server", "present"]),
            models.Index(fields=["state"]),
        ]

    def __str__(self) -> str:
        marker = "" if self.present else " (absent)"
        return f"{self.name} [{self.container_id[:12]}]{marker}"

    @property
    def effective_last_seen_at(self):
        """Latest time Docker discovery reported this container."""
        if not self.present:
            return self.last_seen_at
        try:
            discovered = self.server.docker_host.last_discovered_at
        except DockerHostState.DoesNotExist:
            discovered = None
        if discovered is None or discovered < self.last_seen_at:
            return self.last_seen_at
        return discovered


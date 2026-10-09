import uuid
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.agents.models import Agent


class NetworkTarget(models.Model):
    """A configured network probe destination monitored by an assigned agent."""

    class Protocol(models.TextChoices):
        ICMP = "icmp", "ICMP"
        TCP = "tcp", "TCP"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    hostname_or_ip = models.CharField(max_length=255)
    protocol = models.CharField(max_length=8, choices=Protocol.choices)
    port = models.PositiveIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(1), MaxValueValidator(65535)],
    )
    enabled = models.BooleanField(default=True)
    monitoring_interval_seconds = models.PositiveIntegerField(
        default=60,
        validators=[MinValueValidator(10), MaxValueValidator(86400)],
    )
    timeout_seconds = models.PositiveIntegerField(
        default=2,
        validators=[MinValueValidator(1), MaxValueValidator(30)],
    )
    expected_sla_percentage = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=Decimal("99.90"),
        validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text="Informational SLA expectation for future reporting (not calculated yet).",
    )
    customer_name = models.CharField(max_length=255, blank=True)
    circuit_identifier = models.CharField(max_length=255, blank=True)
    # SET_NULL keeps the target (and its measurement history) when the agent
    # is deleted; reassign it to a new agent to resume monitoring.
    assigned_agent = models.ForeignKey(
        Agent,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="network_targets",
        # Covered by the (assigned_agent, enabled) index.
        db_index=False,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "network target"
        verbose_name_plural = "network targets"
        indexes = [
            models.Index(fields=["assigned_agent", "enabled"]),
        ]

    def __str__(self) -> str:
        return self.name

    def clean(self) -> None:
        if self.protocol == self.Protocol.TCP and self.port is None:
            raise ValidationError({"port": "TCP targets require a port."})
        if self.protocol == self.Protocol.ICMP and self.port is not None:
            raise ValidationError({"port": "ICMP targets must not set a port."})

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class NetworkMeasurement(models.Model):
    """Historical network probe measurement reported by an agent."""

    class FailureReason(models.TextChoices):
        NONE = "", "None"
        TIMEOUT = "timeout", "Timeout"
        CONNECTION_REFUSED = "connection_refused", "Connection refused"
        HOST_UNREACHABLE = "host_unreachable", "Host unreachable"
        DNS_FAILURE = "dns_failure", "DNS failure"
        PERMISSION_DENIED = "permission_denied", "Permission denied"
        UNSUPPORTED = "unsupported", "Unsupported"
        NETWORK_ERROR = "network_error", "Network error"
        UNKNOWN = "unknown", "Unknown"

    id = models.UUIDField(primary_key=True, editable=False)
    target = models.ForeignKey(
        NetworkTarget,
        on_delete=models.CASCADE,
        related_name="measurements",
        # Covered by the (target, -measured_at) index.
        db_index=False,
    )
    # Reporting agent; NULL once that agent has been deleted (history is kept).
    agent = models.ForeignKey(
        Agent,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="network_measurements",
        # Covered by the (agent, -measured_at) index.
        db_index=False,
    )
    measured_at = models.DateTimeField()
    received_at = models.DateTimeField()
    success = models.BooleanField()
    latency_ms = models.FloatField(null=True, blank=True)
    packet_loss_percentage = models.FloatField(
        validators=[MinValueValidator(0), MaxValueValidator(100)],
    )
    probe_count = models.PositiveIntegerField(
        validators=[MinValueValidator(1), MaxValueValidator(20)],
    )
    successful_probes = models.PositiveIntegerField(
        validators=[MinValueValidator(0), MaxValueValidator(20)],
    )
    failure_reason = models.CharField(
        max_length=32,
        choices=FailureReason.choices,
        blank=True,
        default="",
    )

    class Meta:
        ordering = ["-measured_at"]
        verbose_name = "network measurement"
        verbose_name_plural = "network measurements"
        indexes = [
            models.Index(fields=["target", "-measured_at"]),
            models.Index(fields=["agent", "-measured_at"]),
            models.Index(fields=["measured_at"]),
        ]

    def __str__(self) -> str:
        status = "ok" if self.success else "fail"
        return f"{self.target.name} @ {self.measured_at.isoformat()} ({status})"

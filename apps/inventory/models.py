"""Customers, sites and network devices.

This app is the organizational backbone for the monitoring features: devices
are polled by agents (SNMP, in a later phase) and will be referenced by
circuits, services, SLA reports and the network topology. Everything is
identified by UUID so other apps can reference it, and nothing here is
deleted implicitly: a customer with sites and a site with devices are
protected from deletion, and deleting an agent only unassigns its devices.
"""

import uuid

from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from apps.agents.models import Agent
from apps.inventory.validators import MAX_ADDRESS_LENGTH, validate_management_address


class ValidatedNameMixin(models.Model):
    """Validates on every save and keeps ``name`` free of surrounding whitespace.

    Like ``NetworkTarget``, instances are validated on every ``save()``, so
    programmatic writes cannot bypass the admin's checks. Values are normalized
    before validation (Django validates fields before ``clean()``, so a name
    of only spaces would otherwise pass the "not blank" check).
    """

    class Meta:
        abstract = True

    def normalize(self) -> None:
        if isinstance(self.name, str):
            self.name = self.name.strip()

    def clean_fields(self, exclude=None) -> None:
        self.normalize()
        super().clean_fields(exclude=exclude)

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class Customer(ValidatedNameMixin):
    """An organization whose networks and services are monitored."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "customer"
        verbose_name_plural = "customers"
        constraints = [
            models.UniqueConstraint(
                Lower("name"),
                name="uniq_customer_name_ci",
                violation_error_message="A customer with this name already exists.",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class Site(ValidatedNameMixin):
    """A location of a customer, such as an office, data center or branch."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # PROTECT: a customer with sites cannot be deleted by accident.
    customer = models.ForeignKey(
        Customer,
        on_delete=models.PROTECT,
        related_name="sites",
        # Covered by the (customer, lower(name)) unique index.
        db_index=False,
    )
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["customer__name", "name"]
        verbose_name = "site"
        verbose_name_plural = "sites"
        constraints = [
            models.UniqueConstraint(
                "customer",
                Lower("name"),
                name="uniq_site_name_per_customer_ci",
                violation_error_message="This customer already has a site with this name.",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.customer.name} / {self.name}"


class Device(ValidatedNameMixin):
    """A network device (router, switch, firewall) in a customer's network."""

    class DeviceType(models.TextChoices):
        ROUTER = "router", "Router"
        SWITCH = "switch", "Switch"
        FIREWALL = "firewall", "Firewall"
        OTHER = "other", "Other"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    device_type = models.CharField(
        max_length=16,
        choices=DeviceType.choices,
        default=DeviceType.OTHER,
    )
    # Hostname or IP address used to reach the device. Not unique: customers
    # commonly use overlapping private address ranges.
    management_address = models.CharField(
        max_length=MAX_ADDRESS_LENGTH,
        validators=[validate_management_address],
    )
    # Devices without a site (not yet assigned to a customer) are allowed.
    site = models.ForeignKey(
        Site,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="devices",
        # Covered by the (site, lower(name)) unique index.
        db_index=False,
    )
    enabled = models.BooleanField(default=True)
    # The agent that can reach the device. SET_NULL keeps the device (and, in
    # later phases, its history) when the agent is deleted; assign a new agent
    # to resume monitoring.
    assigned_agent = models.ForeignKey(
        Agent,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="devices",
        # Covered by the (assigned_agent, enabled) index.
        db_index=False,
    )
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        verbose_name = "device"
        verbose_name_plural = "devices"
        constraints = [
            models.UniqueConstraint(
                "site",
                Lower("name"),
                name="uniq_device_name_per_site_ci",
                violation_error_message="This site already has a device with this name.",
            ),
            # NULLs are distinct in unique indexes, so devices without a site
            # need their own constraint.
            models.UniqueConstraint(
                Lower("name"),
                condition=Q(site__isnull=True),
                name="uniq_unassigned_device_name_ci",
                violation_error_message="An unassigned device with this name already exists.",
            ),
        ]
        indexes = [
            models.Index(fields=["assigned_agent", "enabled"]),
        ]

    def __str__(self) -> str:
        return self.name

    def normalize(self) -> None:
        super().normalize()
        if isinstance(self.management_address, str):
            self.management_address = self.management_address.strip()

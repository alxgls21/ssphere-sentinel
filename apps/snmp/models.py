"""SNMP monitoring data for network devices.

Devices (``apps.inventory.Device``) are polled by agents; this app stores the
per-device settings, the latest state, the interfaces, and the history.

Credentials never live here. ``SnmpConfig.credential_profile`` is only the
*name* of a profile in the agent's local credentials file, and nothing in this
app has a field that could hold a community string or a v3 key.

History tables are protected from implicit deletion (``PROTECT``): Django's
admin loads every related row into memory to build its delete confirmation,
which would take the server down for a device with millions of samples. History
is removed by the retention command (``purge_snmp_data``) only.

Counter columns are ``bigint`` and therefore limited to 2**63 - 1. A 64-bit
counter would need about 23 years at 100 Gbit/s to get there.
"""

from django.contrib.postgres.indexes import BrinIndex
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models
from django.db.models import Q

from apps.inventory.models import Device

# Counters reported by the agent, in the order they are stored.
COUNTER_FIELDS = (
    "in_octets",
    "out_octets",
    "in_errors",
    "out_errors",
    "in_discards",
    "out_discards",
)
MAX_BIGINT = 2**63 - 1

CREDENTIAL_PROFILE_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]*$"


class AdminStatus(models.IntegerChoices):
    """IF-MIB ifAdminStatus."""

    UP = 1, "up"
    DOWN = 2, "down"
    TESTING = 3, "testing"


class OperStatus(models.IntegerChoices):
    """IF-MIB ifOperStatus."""

    UP = 1, "up"
    DOWN = 2, "down"
    TESTING = 3, "testing"
    UNKNOWN = 4, "unknown"
    DORMANT = 5, "dormant"
    NOT_PRESENT = 6, "notPresent"
    LOWER_LAYER_DOWN = 7, "lowerLayerDown"


class PollError(models.TextChoices):
    NONE = "", "None"
    TIMEOUT = "timeout", "Timeout"
    UNREACHABLE = "unreachable", "Unreachable"
    AUTH_FAILURE = "auth_failure", "Authentication failure"
    DNS_FAILURE = "dns_failure", "DNS failure"
    PROTOCOL_ERROR = "protocol_error", "Protocol error"
    UNSUPPORTED = "unsupported", "Unsupported (no IF-MIB)"
    UNKNOWN = "unknown", "Unknown"


class DeltaState(models.TextChoices):
    """Whether a sample's deltas can be trusted.

    Deltas are calculated by the agent from consecutive raw counters; the raw
    counters are always stored too, so deltas can be recomputed.
    """

    OK = "ok", "Deltas valid"
    SPEED_CHANGED = "speed_changed", "Deltas valid, interface speed changed"
    FIRST = "first", "First sample (no previous counters)"
    REBOOT = "reboot", "Device restarted"
    RESET = "reset", "Counter reset"
    GAP = "gap", "Previous sample too old"


# States in which the delta columns carry values; in all others they are NULL.
DELTA_STATES_WITH_VALUES = (DeltaState.OK.value, DeltaState.SPEED_CHANGED.value)


class OctetsBits(models.IntegerChoices):
    """Width of the octet counters used: 64-bit (ifHC*) preferred, else 32-bit."""

    BITS_32 = 32, "32-bit"
    BITS_64 = 64, "64-bit (HC)"


class SnmpConfig(models.Model):
    """How a device is polled. One row per SNMP-monitored device.

    A device is accepted for SNMP reports only if it has this row. The agent
    reads its own settings and credentials from its local files (see the
    docs); the values here are the server-side record of the intended setup,
    and are what a future server-managed configuration will distribute.
    """

    class Version(models.TextChoices):
        V2C = "2c", "SNMPv2c"
        V3 = "3", "SNMPv3"

    device = models.OneToOneField(
        Device,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="snmp_config",
    )
    version = models.CharField(max_length=2, choices=Version.choices, default=Version.V3)
    port = models.PositiveIntegerField(
        default=161,
        validators=[MinValueValidator(1), MaxValueValidator(65535)],
    )
    credential_profile = models.CharField(
        max_length=64,
        validators=[RegexValidator(CREDENTIAL_PROFILE_RE, "Use letters, digits, '.', '_' and '-'.")],
        help_text=(
            "Name of a profile in the agent's local credentials file. The "
            "credentials themselves are never stored in Sentinel."
        ),
    )
    poll_interval_seconds = models.PositiveIntegerField(
        default=300,
        validators=[MinValueValidator(30), MaxValueValidator(86400)],
    )
    timeout_seconds = models.PositiveIntegerField(
        default=5,
        validators=[MinValueValidator(1), MaxValueValidator(60)],
        help_text="Per-request timeout.",
    )
    retries = models.PositiveIntegerField(
        default=1,
        validators=[MaxValueValidator(5)],
        help_text="Retries per request after a timeout.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "SNMP configuration"
        verbose_name_plural = "SNMP configurations"

    def __str__(self) -> str:
        return f"SNMP {self.get_version_display()} for {self.device_id}"

    def clean(self) -> None:
        super().clean()
        if (
            self.timeout_seconds is not None
            and self.retries is not None
            and self.poll_interval_seconds is not None
            and self.timeout_seconds * (self.retries + 1) >= self.poll_interval_seconds
        ):
            raise ValidationError(
                "timeout × (retries + 1) must be shorter than the poll interval."
            )

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class DeviceSnmpState(models.Model):
    """Latest known state of a device, from the newest poll received.

    Only a poll newer than ``last_poll_at`` updates it, so late or repeated
    deliveries never move the state backwards.
    """

    device = models.OneToOneField(
        Device,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="snmp_state",
    )
    last_poll_at = models.DateTimeField(null=True, blank=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    last_discovery_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Newest poll that listed every interface of the device.",
    )
    received_at = models.DateTimeField(null=True, blank=True)
    reachable = models.BooleanField(default=False)
    error = models.CharField(max_length=32, choices=PollError.choices, blank=True, default="")
    response_ms = models.FloatField(null=True, blank=True)
    sys_uptime_ticks = models.PositiveBigIntegerField(
        null=True, blank=True, help_text="sysUpTime in hundredths of a second."
    )
    sys_name = models.CharField(max_length=255, blank=True)
    sys_descr = models.CharField(max_length=1024, blank=True)
    sys_object_id = models.CharField(max_length=255, blank=True)

    class Meta:
        verbose_name = "device SNMP state"
        verbose_name_plural = "device SNMP states"

    def __str__(self) -> str:
        return f"SNMP state of {self.device_id}"


class Interface(models.Model):
    """A network interface of a device, identified by (device, ifIndex).

    ifIndex is not guaranteed to survive a device reboot on every vendor; if
    a device renumbers its interfaces, the old rows become absent and new rows
    appear under the new indexes.
    """

    device = models.ForeignKey(
        Device,
        on_delete=models.CASCADE,
        related_name="interfaces",
        # Covered by the (device, if_index) unique index.
        db_index=False,
    )
    if_index = models.PositiveIntegerField(validators=[MinValueValidator(1)])
    name = models.CharField(max_length=255)
    descr = models.CharField(max_length=255, blank=True)
    alias = models.CharField(max_length=255, blank=True)
    if_type = models.PositiveIntegerField(default=0, help_text="IANAifType number.")
    speed_bps = models.PositiveBigIntegerField(null=True, blank=True)
    admin_status = models.PositiveSmallIntegerField(choices=AdminStatus.choices)
    oper_status = models.PositiveSmallIntegerField(choices=OperStatus.choices)
    oper_status_changed_at = models.DateTimeField(null=True, blank=True)
    present = models.BooleanField(
        default=True,
        help_text="False once a poll that lists every interface no longer includes it.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["device_id", "if_index"]
        verbose_name = "interface"
        verbose_name_plural = "interfaces"
        constraints = [
            models.UniqueConstraint(fields=["device", "if_index"], name="uniq_interface_per_device"),
        ]

    def __str__(self) -> str:
        return f"{self.device.name} {self.name}"


class DevicePoll(models.Model):
    """One poll of a device (reachability history). ``id`` is chosen by the agent.

    Reports are idempotent on ``id``; a device is polled at most once per
    ``measured_at``.
    """

    id = models.UUIDField(primary_key=True, editable=False)
    device = models.ForeignKey(
        Device,
        on_delete=models.PROTECT,
        related_name="polls",
        # Covered by the (device, measured_at) unique index.
        db_index=False,
    )
    # The reporting agent is deliberately not recorded: it is always the one
    # the device was assigned to, and a foreign key to it would make deleting
    # an agent rewrite every one of its (millions of) history rows.
    measured_at = models.DateTimeField()
    received_at = models.DateTimeField()
    reachable = models.BooleanField()
    response_ms = models.FloatField(null=True, blank=True)
    error = models.CharField(max_length=32, choices=PollError.choices, blank=True, default="")
    sys_uptime_ticks = models.PositiveBigIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-measured_at"]
        verbose_name = "device poll"
        verbose_name_plural = "device polls"
        constraints = [
            models.UniqueConstraint(fields=["device", "measured_at"], name="uniq_poll_per_device_time"),
            models.CheckConstraint(
                condition=Q(reachable=False) | Q(error=""),
                name="poll_error_only_when_unreachable",
            ),
        ]
        indexes = [
            # Tiny index for retention: history is appended in time order, so a
            # BRIN index finds old rows at a fraction of a btree's size.
            BrinIndex(fields=["measured_at"], name="snmp_poll_measured_brin"),
        ]

    def __str__(self) -> str:
        return f"{self.device_id} @ {self.measured_at.isoformat()}"


class InterfaceSample(models.Model):
    """Interface counters at one poll: raw values and the calculated deltas."""

    interface = models.ForeignKey(
        Interface,
        on_delete=models.PROTECT,
        related_name="samples",
        # Covered by the (interface, measured_at) unique index.
        db_index=False,
    )
    measured_at = models.DateTimeField()
    interval_seconds = models.FloatField(
        null=True,
        blank=True,
        help_text="Seconds since the previous sample the deltas were calculated from.",
    )
    admin_status = models.PositiveSmallIntegerField(choices=AdminStatus.choices)
    oper_status = models.PositiveSmallIntegerField(choices=OperStatus.choices)
    speed_bps = models.PositiveBigIntegerField(null=True, blank=True)
    octets_bits = models.PositiveSmallIntegerField(choices=OctetsBits.choices)
    delta_state = models.CharField(max_length=16, choices=DeltaState.choices)

    # Raw counters as read from the device (NULL when the device lacks one).
    in_octets = models.PositiveBigIntegerField(null=True, blank=True)
    out_octets = models.PositiveBigIntegerField(null=True, blank=True)
    in_errors = models.PositiveBigIntegerField(null=True, blank=True)
    out_errors = models.PositiveBigIntegerField(null=True, blank=True)
    in_discards = models.PositiveBigIntegerField(null=True, blank=True)
    out_discards = models.PositiveBigIntegerField(null=True, blank=True)

    # Increase since the previous sample, wraps handled (NULL unless
    # ``delta_state`` says the deltas are valid).
    in_octets_delta = models.PositiveBigIntegerField(null=True, blank=True)
    out_octets_delta = models.PositiveBigIntegerField(null=True, blank=True)
    in_errors_delta = models.PositiveBigIntegerField(null=True, blank=True)
    out_errors_delta = models.PositiveBigIntegerField(null=True, blank=True)
    in_discards_delta = models.PositiveBigIntegerField(null=True, blank=True)
    out_discards_delta = models.PositiveBigIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["-id"]
        verbose_name = "interface sample"
        verbose_name_plural = "interface samples"
        constraints = [
            models.UniqueConstraint(
                fields=["interface", "measured_at"], name="uniq_sample_per_interface_time"
            ),
            models.CheckConstraint(
                condition=Q(admin_status__gte=1, admin_status__lte=3, oper_status__gte=1, oper_status__lte=7),
                name="sample_status_in_range",
            ),
            models.CheckConstraint(
                condition=Q(octets_bits__in=[32, 64]),
                name="sample_octets_bits_32_or_64",
            ),
            models.CheckConstraint(
                # NOT NULL is explicit: a CHECK that evaluates to NULL passes.
                condition=Q(
                    delta_state__in=DELTA_STATES_WITH_VALUES,
                    interval_seconds__isnull=False,
                    interval_seconds__gt=0,
                )
                | (
                    ~Q(delta_state__in=DELTA_STATES_WITH_VALUES)
                    & Q(in_octets_delta__isnull=True)
                    & Q(out_octets_delta__isnull=True)
                    & Q(in_errors_delta__isnull=True)
                    & Q(out_errors_delta__isnull=True)
                    & Q(in_discards_delta__isnull=True)
                    & Q(out_discards_delta__isnull=True)
                ),
                name="sample_deltas_only_when_valid",
            ),
        ]
        indexes = [
            BrinIndex(fields=["measured_at"], name="snmp_sample_measured_brin"),
        ]

    def __str__(self) -> str:
        return f"{self.interface_id} @ {self.measured_at.isoformat()}"

from django.contrib import admin, messages
from django.db.models import OuterRef, Subquery
from django.urls import reverse
from django.utils.html import format_html

from apps.network.models import NetworkMeasurement, NetworkTarget

_TARGET_FIELDS = (
    "name",
    "hostname_or_ip",
    "protocol",
    "port",
    "enabled",
    "assigned_agent",
)
_SHARED_FIELDSETS = (
    (
        "Probe settings",
        {
            "fields": (
                "monitoring_interval_seconds",
                "timeout_seconds",
                "expected_sla_percentage",
            )
        },
    ),
    (
        "Optional metadata",
        {
            "fields": ("customer_name", "circuit_identifier"),
        },
    ),
    (
        "Timestamps",
        {
            "fields": ("created_at", "updated_at"),
        },
    ),
)


@admin.register(NetworkTarget)
class NetworkTargetAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "hostname_or_ip",
        "protocol",
        "port",
        "enabled",
        "assigned_agent",
        "customer_name",
        "latest_latency_ms",
        "latest_packet_loss",
        "latest_availability",
        "last_measured_at",
    )
    list_filter = ("enabled", "protocol", "assigned_agent")
    search_fields = (
        "name",
        "hostname_or_ip",
        "customer_name",
        "circuit_identifier",
    )
    raw_id_fields = ("assigned_agent",)
    # The UUID is generated on create (it is not an editable model field) and
    # shown read-only afterwards for use in the agent-local targets file.
    add_fieldsets = ((None, {"fields": _TARGET_FIELDS}),) + _SHARED_FIELDSETS
    fieldsets = (
        (None, {"fields": ("id",) + _TARGET_FIELDS}),
        (
            "Latest measurement",
            {"fields": ("latest_measurement_summary", "measurements_link")},
        ),
    ) + _SHARED_FIELDSETS

    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return self.add_fieldsets
        return super().get_fieldsets(request, obj)

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        latest = NetworkMeasurement.objects.filter(target_id=OuterRef("pk")).order_by(
            "-measured_at"
        )
        return qs.annotate(
            _latest_latency=Subquery(latest.values("latency_ms")[:1]),
            _latest_loss=Subquery(latest.values("packet_loss_percentage")[:1]),
            _latest_success=Subquery(latest.values("success")[:1]),
            _latest_measured_at=Subquery(latest.values("measured_at")[:1]),
        )

    def get_readonly_fields(self, request, obj=None):
        if obj:
            return (
                "id",
                "latest_measurement_summary",
                "measurements_link",
                "created_at",
                "updated_at",
            )
        return ("created_at", "updated_at")

    def response_add(self, request, obj, post_url_continue=None):
        self.message_user(
            request,
            f"Target UUID for the agent-local targets file: {obj.pk}",
            level=messages.INFO,
        )
        return super().response_add(request, obj, post_url_continue)

    @admin.display(description="Latest measurement")
    def latest_measurement_summary(self, obj: NetworkTarget):
        measured_at = getattr(obj, "_latest_measured_at", None)
        if measured_at is None:
            return "No measurements yet"
        latency = getattr(obj, "_latest_latency", None)
        return format_html(
            "{} at {} — latency: {} — packet loss: {}%",
            "up" if getattr(obj, "_latest_success", False) else "down",
            measured_at.isoformat(),
            f"{latency} ms" if latency is not None else "—",
            getattr(obj, "_latest_loss", None),
        )

    @admin.display(description="Measurement history")
    def measurements_link(self, obj: NetworkTarget):
        url = reverse("admin:network_networkmeasurement_changelist")
        return format_html(
            '<a href="{}?target__id__exact={}">View all measurements for this target</a>',
            url,
            obj.pk,
        )

    @admin.display(description="Latest latency (ms)")
    def latest_latency_ms(self, obj: NetworkTarget):
        value = getattr(obj, "_latest_latency", None)
        return value if value is not None else "—"

    @admin.display(description="Latest packet loss %")
    def latest_packet_loss(self, obj: NetworkTarget):
        value = getattr(obj, "_latest_loss", None)
        return value if value is not None else "—"

    @admin.display(description="Latest availability")
    def latest_availability(self, obj: NetworkTarget):
        value = getattr(obj, "_latest_success", None)
        if value is None:
            return "—"
        return "up" if value else "down"

    @admin.display(description="Last measured at")
    def last_measured_at(self, obj: NetworkTarget):
        value = getattr(obj, "_latest_measured_at", None)
        return value if value is not None else "—"


@admin.register(NetworkMeasurement)
class NetworkMeasurementAdmin(admin.ModelAdmin):
    list_display = (
        "target",
        "agent",
        "measured_at",
        "success",
        "latency_ms",
        "packet_loss_percentage",
        "probe_count",
        "successful_probes",
        "failure_reason",
        "received_at",
    )
    list_filter = ("success", "failure_reason", "target", "agent")
    search_fields = ("target__name", "target__hostname_or_ip", "id")
    readonly_fields = (
        "id",
        "target",
        "agent",
        "measured_at",
        "received_at",
        "success",
        "latency_ms",
        "packet_loss_percentage",
        "probe_count",
        "successful_probes",
        "failure_reason",
    )
    date_hierarchy = "measured_at"

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False

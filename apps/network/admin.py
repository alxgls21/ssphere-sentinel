from django.contrib import admin
from django.db.models import OuterRef, Subquery
from django.utils import timezone

from apps.network.models import NetworkMeasurement, NetworkTarget


class LatestMeasurementInline(admin.TabularInline):
    model = NetworkMeasurement
    extra = 0
    can_delete = False
    max_num = 5
    ordering = ("-measured_at",)
    fields = (
        "measured_at",
        "success",
        "latency_ms",
        "packet_loss_percentage",
        "probe_count",
        "successful_probes",
        "failure_reason",
    )
    readonly_fields = fields

    def has_add_permission(self, request, obj=None) -> bool:
        return False


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
    inlines = (LatestMeasurementInline,)
    fieldsets = (
        (
            None,
            {
                "fields": (
                    "id",
                    "name",
                    "hostname_or_ip",
                    "protocol",
                    "port",
                    "enabled",
                    "assigned_agent",
                )
            },
        ),
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
        # Allow setting id on create so agent-local config UUIDs can match.
        if obj:
            return ("id", "created_at", "updated_at")
        return ("created_at", "updated_at")

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

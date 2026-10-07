from django.contrib import admin

from apps.infrastructure.models import Server, ServerTelemetry


class ServerTelemetryInline(admin.StackedInline):
    model = ServerTelemetry
    can_delete = False
    extra = 0
    max_num = 1
    readonly_fields = (
        "cpu_percent",
        "memory_total_bytes",
        "memory_used_bytes",
        "memory_percent",
        "disk_total_bytes",
        "disk_used_bytes",
        "disk_percent",
        "uptime_seconds",
        "collected_at",
        "received_at",
    )

    def has_add_permission(self, request, obj=None) -> bool:
        return False


@admin.register(Server)
class ServerAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "hostname",
        "ip_address",
        "operating_system",
        "status",
        "effective_status",
        "last_seen_at",
        "updated_at",
    )
    list_filter = ("status", "operating_system")
    search_fields = ("name", "hostname", "ip_address", "description")
    readonly_fields = ("id", "effective_status", "created_at", "updated_at")
    ordering = ("name",)
    inlines = (ServerTelemetryInline,)
    fieldsets = (
        (
            None,
            {
                "fields": (
                    "id",
                    "name",
                    "hostname",
                    "description",
                    "operating_system",
                    "ip_address",
                )
            },
        ),
        (
            "Status",
            {
                "fields": ("status", "effective_status", "last_seen_at"),
                "description": (
                    "Stored status is updated by heartbeats and future checks. "
                    "Effective status is derived from last_seen_at using "
                    "SENTINEL_OFFLINE_THRESHOLD (no background job required)."
                ),
            },
        ),
        (
            "Timestamps",
            {
                "fields": ("created_at", "updated_at"),
            },
        ),
    )

    @admin.display(description="Effective status")
    def effective_status(self, obj: Server) -> str:
        return obj.effective_status


@admin.register(ServerTelemetry)
class ServerTelemetryAdmin(admin.ModelAdmin):
    list_display = (
        "server",
        "cpu_percent",
        "memory_percent",
        "disk_percent",
        "uptime_seconds",
        "collected_at",
        "received_at",
    )
    search_fields = ("server__name", "server__hostname")
    readonly_fields = (
        "server",
        "cpu_percent",
        "memory_total_bytes",
        "memory_used_bytes",
        "memory_percent",
        "disk_total_bytes",
        "disk_used_bytes",
        "disk_percent",
        "uptime_seconds",
        "collected_at",
        "received_at",
    )

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False

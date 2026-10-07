from django.contrib import admin

from apps.infrastructure.models import Server


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

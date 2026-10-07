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
        "last_seen_at",
        "updated_at",
    )
    list_filter = ("status", "operating_system")
    search_fields = ("name", "hostname", "ip_address", "description")
    readonly_fields = ("id", "created_at", "updated_at")
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
                "fields": ("status", "last_seen_at"),
            },
        ),
        (
            "Timestamps",
            {
                "fields": ("created_at", "updated_at"),
            },
        ),
    )

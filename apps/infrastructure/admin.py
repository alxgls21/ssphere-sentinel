from django.contrib import admin

from apps.infrastructure.models import (
    DockerContainer,
    DockerHostState,
    Server,
    ServerTelemetry,
)


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


class DockerHostStateInline(admin.StackedInline):
    model = DockerHostState
    can_delete = False
    extra = 0
    max_num = 1
    readonly_fields = (
        "available",
        "status",
        "collected_at",
        "received_at",
    )

    def has_add_permission(self, request, obj=None) -> bool:
        return False


class DockerContainerInline(admin.TabularInline):
    model = DockerContainer
    can_delete = False
    extra = 0
    show_change_link = True
    fields = (
        "name",
        "container_id",
        "image",
        "state",
        "health",
        "present",
        "last_seen_at",
    )
    readonly_fields = fields

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
        "docker_status",
        "last_seen_at",
        "updated_at",
    )
    list_filter = ("status", "operating_system")
    search_fields = ("name", "hostname", "ip_address", "description")
    readonly_fields = ("id", "effective_status", "created_at", "updated_at")
    ordering = ("name",)
    inlines = (ServerTelemetryInline, DockerHostStateInline, DockerContainerInline)
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

    @admin.display(description="Docker")
    def docker_status(self, obj: Server) -> str:
        try:
            return obj.docker_host.status
        except DockerHostState.DoesNotExist:
            return "—"


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


@admin.register(DockerHostState)
class DockerHostStateAdmin(admin.ModelAdmin):
    list_display = (
        "server",
        "available",
        "status",
        "collected_at",
        "received_at",
    )
    list_filter = ("available", "status")
    search_fields = ("server__name", "server__hostname")
    readonly_fields = (
        "server",
        "available",
        "status",
        "collected_at",
        "received_at",
    )

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False


@admin.register(DockerContainer)
class DockerContainerAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "server",
        "short_id",
        "image",
        "state",
        "health",
        "present",
        "last_seen_at",
    )
    list_filter = ("present", "state", "health", "server")
    search_fields = ("name", "container_id", "image", "server__name")
    readonly_fields = (
        "server",
        "container_id",
        "name",
        "image",
        "state",
        "health",
        "container_created_at",
        "started_at",
        "present",
        "last_seen_at",
        "received_at",
    )

    @admin.display(description="ID")
    def short_id(self, obj: DockerContainer) -> str:
        return obj.container_id[:12]

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False

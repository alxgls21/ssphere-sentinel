"""Read-only: domains are added and verified in the console, where their names are normalized
and their tokens made, and every change is recorded in the configuration trail."""

from django.contrib import admin

from apps.web.models import DomainVerification, DomainVerifierHeartbeat, MonitoredDomain


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(MonitoredDomain)
class MonitoredDomainAdmin(ReadOnlyAdmin):
    list_display = ("display_name", "name", "customer", "status", "last_outcome", "last_checked_at")
    # The token is the console's to show, in the domain's record.
    fields = readonly_fields = (
        "name", "display_name", "customer", "status", "verified_at", "last_verified_at", "last_checked_at",
        "last_outcome", "next_check_at", "degraded_since", "grace_until", "token_created_at", "version",
        "created_by", "created_by_name", "created_at", "updated_at",
    )
    list_filter = ("status", "last_outcome")
    list_select_related = ("customer",)
    search_fields = ("name", "display_name", "customer__name")
    ordering = ("name", "id")


@admin.register(DomainVerification)
class DomainVerificationAdmin(ReadOnlyAdmin):
    list_display = ("domain", "status", "outcome", "detail", "requested_by_name", "created_at", "finished_at")
    fields = readonly_fields = (
        "domain", "trigger", "status", "outcome", "detail", "evidence", "requested_by", "requested_by_name",
        "created_at", "expires_at", "started_at", "finished_at", "lease_expires_at",
    )
    list_filter = ("status", "outcome", "trigger")
    list_select_related = ("domain",)
    search_fields = ("domain__name", "requested_by_name")
    ordering = ("-created_at", "-id")


@admin.register(DomainVerifierHeartbeat)
class DomainVerifierHeartbeatAdmin(ReadOnlyAdmin):
    list_display = ("started_at", "beat_at", "last_cycle_ms", "last_error_at", "last_error_category")

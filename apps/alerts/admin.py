from django.contrib import admin

from apps.alerts.models import (
    AlertEngineHeartbeat,
    AlertEvaluationState,
    AlertRule,
    Incident,
    IncidentEvent,
    Notification,
    NotificationSubscription,
)


class ReadOnlyAdmin(admin.ModelAdmin):
    """Written by the alert engine only: shown, never edited, added or deleted here."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(AlertRule)
class AlertRuleAdmin(admin.ModelAdmin):
    list_display = ("name", "entity_kind", "health", "reason", "severity", "enabled", "scope", "activation_seconds", "recovery_seconds")
    list_filter = ("enabled", "entity_kind", "severity", "health")
    list_select_related = ("customer", "site__customer")
    ordering = ("name", "pk")
    search_fields = ("name", "description")
    autocomplete_fields = ("customer", "site")
    readonly_fields = ("id", "key", "created_at", "updated_at")
    fieldsets = (
        (None, {"fields": ("id", "key", "name", "description", "enabled")}),
        ("Condition", {"fields": ("entity_kind", "health", "reason", "severity")}),
        ("Timing", {"fields": ("activation_seconds", "recovery_seconds")}),
        ("Scope", {"fields": ("customer", "site"), "description": "Neither: every object, including those on no site."}),
        (None, {"fields": ("created_at", "updated_at")}),
    )

    def get_readonly_fields(self, request, obj=None):
        # Its incidents and evaluation states are about objects of this kind.
        fields = super().get_readonly_fields(request, obj)
        return (*fields, "entity_kind") if obj is not None else fields

    @admin.display(description="Scope")
    def scope(self, obj: AlertRule) -> str:
        if obj.site_id:
            return str(obj.site)
        if obj.customer_id:
            return obj.customer.name
        return "Everything"


class IncidentEventInline(admin.TabularInline):
    model = IncidentEvent
    extra = 0
    fields = ("at", "kind", "health", "reason", "actor_name")
    readonly_fields = fields
    can_delete = False
    ordering = ("at", "id")

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Incident)
class IncidentAdmin(ReadOnlyAdmin):
    list_display = ("entity_label", "entity_kind", "rule", "severity", "status", "site", "opened_at", "closed_at")
    list_filter = ("status", "severity", "entity_kind", "rule")
    list_select_related = ("rule", "site__customer")
    search_fields = ("entity_label", "entity_ref", "rule__name")
    date_hierarchy = "opened_at"
    ordering = ("-opened_at", "pk")
    inlines = (IncidentEventInline,)


@admin.register(AlertEvaluationState)
class AlertEvaluationStateAdmin(ReadOnlyAdmin):
    list_display = ("rule", "entity_kind", "entity_ref", "phase", "condition_since", "last_health", "last_reason", "updated_at")
    list_filter = ("phase", "entity_kind", "rule")
    list_select_related = ("rule",)
    search_fields = ("entity_ref", "rule__name")
    ordering = ("rule__name", "entity_kind", "entity_ref")


@admin.register(AlertEngineHeartbeat)
class AlertEngineHeartbeatAdmin(ReadOnlyAdmin):
    list_display = ("started_at", "beat_at", "interval_seconds", "last_cycle_ms", "monitoring_since", "last_error_at", "last_error_category", "last_error_type")


@admin.register(NotificationSubscription)
class NotificationSubscriptionAdmin(admin.ModelAdmin):
    """Who is emailed. Each email is checked again before it is sent: access, address, this subscription."""

    list_display = ("user", "email", "enabled", "min_severity", "send_recovery", "updated_at")
    list_filter = ("enabled", "min_severity", "send_recovery")
    list_select_related = ("user",)
    ordering = ("user__username", "pk")
    search_fields = ("user__username", "user__email")
    autocomplete_fields = ("user",)
    readonly_fields = ("created_at", "updated_at")

    @admin.display(description="Email address", ordering="user__email")
    def email(self, obj: NotificationSubscription) -> str:
        return obj.user.email or "(none: nothing is sent)"


@admin.register(Notification)
class NotificationAdmin(ReadOnlyAdmin):
    """Every incident email: sent, waiting for a retry, failed (and why) or not sent (and why)."""

    list_display = (
        "created_at", "kind", "status", "failure", "attempts", "next_attempt_at", "sent_at", "recipient_name", "incident"
    )
    list_filter = ("status", "failure", "kind")
    list_select_related = ("incident__rule",)
    search_fields = ("recipient_name", "incident__entity_label")
    date_hierarchy = "created_at"
    ordering = ("-created_at", "-pk")

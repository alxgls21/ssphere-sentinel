from django.contrib import admin
from django.db import router, transaction
from django.http import Http404

from apps.alerts import audit
from apps.alerts.models import (
    AlertEngineHeartbeat,
    AlertEvaluationState,
    AlertRule,
    ConfigurationEvent,
    ConfigurationSource,
    Incident,
    IncidentEvent,
    Notification,
    NotificationSubscription,
    NotifierHeartbeat,
    TestEmailRequest,
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

    # Changes made here are in the configuration trail too, in the admin's transaction.
    def save_model(self, request, obj, form, change):
        # The row as it is, held: the record says what this save changed, whatever was saved
        # meanwhile (the admin form has no version: its save is the last word).
        before = {}
        if change:
            stored = AlertRule.objects.select_for_update().filter(pk=obj.pk).first()
            if stored is None:
                raise Http404("This alert rule was deleted meanwhile.")
            before = audit.rule_values(stored)
        super().save_model(request, obj, form, change)
        audit.rule_saved(request.user, obj, before, created=not change, source=ConfigurationSource.ADMIN)

    def delete_model(self, request, obj):
        audit.rule_deleted(request.user, obj, source=ConfigurationSource.ADMIN)
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        # The changelist's bulk delete runs in no transaction of its own: the records and the
        # deletion together, of the same rows, read once and held.
        with transaction.atomic(using=router.db_for_write(self.model)):
            rules = list(queryset.select_for_update(of=("self",)))
            for rule in rules:
                audit.rule_deleted(request.user, rule, source=ConfigurationSource.ADMIN)
            super().delete_queryset(request, AlertRule.objects.filter(pk__in=[rule.pk for rule in rules]))

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

    def get_form(self, request, obj=None, change=False, **kwargs):
        form = super().get_form(request, obj, change=change, **kwargs)
        if obj is not None and "user" in form.base_fields:
            # A subscription stays with its user (another user gets a subscription of their own).
            # Disabled rather than read-only: what the model says about the user still shows on it.
            form.base_fields["user"].disabled = True
        return form

    def save_model(self, request, obj, form, change):
        # The row as it is, held: a change made meanwhile is either before or after this one.
        stored = NotificationSubscription.objects.select_for_update().filter(pk=obj.pk).first() if change else None
        if change and stored is None:
            raise Http404("This subscription was deleted meanwhile.")
        before = audit.subscription_values(stored)
        super().save_model(request, obj, form, change)
        audit.subscription_saved(request.user, obj, before, source=ConfigurationSource.ADMIN)

    def delete_model(self, request, obj):
        audit.subscription_deleted(request.user, obj, source=ConfigurationSource.ADMIN)
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        with transaction.atomic(using=router.db_for_write(self.model)):
            subscriptions = list(queryset.select_related("user").select_for_update(of=("self",)))
            for subscription in subscriptions:
                audit.subscription_deleted(request.user, subscription, source=ConfigurationSource.ADMIN)
            super().delete_queryset(
                request, NotificationSubscription.objects.filter(pk__in=[subscription.pk for subscription in subscriptions])
            )


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


@admin.register(TestEmailRequest)
class TestEmailRequestAdmin(ReadOnlyAdmin):
    """Test emails console users asked for, and what became of each (sent by the notifier)."""

    list_display = ("created_at", "requested_by_name", "status", "failure", "finished_at")
    list_filter = ("status", "failure")
    search_fields = ("requested_by_name",)
    date_hierarchy = "created_at"
    ordering = ("-created_at", "-pk")


@admin.register(NotifierHeartbeat)
class NotifierHeartbeatAdmin(ReadOnlyAdmin):
    list_display = (
        "started_at", "beat_at", "interval_seconds", "last_cycle_ms", "last_error_at", "last_error_category",
        "server_configured", "authentication_configured",
    )


@admin.register(ConfigurationEvent)
class ConfigurationEventAdmin(ReadOnlyAdmin):
    """Who changed which alert rule or email subscription, from where, and what changed: append-only."""

    list_display = ("at", "actor_name", "source", "action", "target_name")
    list_filter = ("action", "source", "target_type")
    search_fields = ("actor_name", "target_name", "target_id")
    date_hierarchy = "at"
    ordering = ("-at", "-pk")

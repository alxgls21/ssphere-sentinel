from django.contrib import admin

from apps.console.models import CustomerAccess, LoginThrottle, SiteAccess


@admin.register(CustomerAccess)
class CustomerAccessAdmin(admin.ModelAdmin):
    list_display = ("user", "customer", "created_at")
    list_filter = ("customer",)
    list_select_related = ("user", "customer")
    search_fields = ("user__username", "customer__name")
    autocomplete_fields = ("user", "customer")
    readonly_fields = ("created_at",)


@admin.register(SiteAccess)
class SiteAccessAdmin(admin.ModelAdmin):
    list_display = ("user", "site", "created_at")
    list_filter = ("site__customer",)
    list_select_related = ("user", "site__customer")
    search_fields = ("user__username", "site__name", "site__customer__name")
    autocomplete_fields = ("user", "site")
    readonly_fields = ("created_at",)


@admin.register(LoginThrottle)
class LoginThrottleAdmin(admin.ModelAdmin):
    """Failed console sign-ins. Delete a row to unlock that account right away."""

    list_display = ("account", "attempts", "locked_until", "updated_at")
    list_select_related = ("user",)
    ordering = ("-updated_at",)
    search_fields = ("user__username",)
    readonly_fields = ("key", "user", "attempts", "window_started_at", "locked_until", "updated_at")

    @admin.display(description="Account", ordering="user__username")
    def account(self, obj):
        # Names that do not exist share buckets; they have no account to show.
        return obj.user.get_username() if obj.user_id else f"(unknown names, {obj.key})"

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        # Rows cascade with their account, and Django's delete confirmation
        # demands delete permission on every cascaded model: whoever may delete
        # users must not be blocked by their sign-in counters.
        return super().has_delete_permission(request, obj) or request.user.has_perm("auth.delete_user")

    def has_change_permission(self, request, obj=None):
        return False

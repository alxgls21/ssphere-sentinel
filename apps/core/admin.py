from django.contrib import admin


class ReadOnlyAdmin(admin.ModelAdmin):
    """Data another part of Sentinel writes: shown, never added, changed or deleted here."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

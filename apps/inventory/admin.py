from django.contrib import admin
from django.db.models import Count

from apps.agents.admin_filters import AgentListFilter
from apps.inventory.models import Customer, Device, Site


class SiteInline(admin.TabularInline):
    model = Site
    extra = 0
    fields = ("name", "description")
    show_change_link = True


@admin.register(Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ("name", "site_count", "created_at")
    # A total order: the autocomplete (used by console access) pages through it.
    ordering = ("name", "pk")
    search_fields = ("name", "notes")
    readonly_fields = ("id", "created_at", "updated_at")
    fields = ("id", "name", "notes", "created_at", "updated_at")
    inlines = (SiteInline,)

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_site_count=Count("sites"))

    @admin.display(description="Sites", ordering="_site_count")
    def site_count(self, obj: Customer) -> int:
        return obj._site_count


@admin.register(Site)
class SiteAdmin(admin.ModelAdmin):
    list_display = ("name", "customer", "device_count", "created_at")
    ordering = ("customer__name", "name", "pk")
    list_filter = ("customer",)
    list_select_related = ("customer",)
    # Required for the device form's site autocomplete.
    search_fields = ("name", "description", "customer__name")
    autocomplete_fields = ("customer",)
    readonly_fields = ("id", "created_at", "updated_at")
    fields = ("id", "customer", "name", "description", "created_at", "updated_at")

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .select_related("customer")
            .annotate(_device_count=Count("devices"))
        )

    @admin.display(description="Devices", ordering="_device_count")
    def device_count(self, obj: Site) -> int:
        return obj._device_count


@admin.register(Device)
class DeviceAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "device_type",
        "management_address",
        "customer",
        "site",
        "assigned_agent",
        "enabled",
    )
    list_filter = (
        "enabled",
        "device_type",
        "site__customer",
        ("assigned_agent", AgentListFilter),
    )
    list_select_related = ("site__customer", "assigned_agent__server")
    search_fields = ("name", "management_address", "description", "site__name", "site__customer__name")
    autocomplete_fields = ("site",)
    raw_id_fields = ("assigned_agent",)
    # The UUID is generated on create and shown read-only afterwards: it is
    # how other components refer to the device.
    readonly_fields = ("id", "created_at", "updated_at")
    fieldsets = (
        (
            None,
            {
                "fields": (
                    "id",
                    "name",
                    "device_type",
                    "management_address",
                    "site",
                    "assigned_agent",
                    "enabled",
                    "description",
                ),
            },
        ),
        ("Timestamps", {"fields": ("created_at", "updated_at")}),
    )

    @admin.display(description="Customer", ordering="site__customer__name")
    def customer(self, obj: Device):
        return obj.site.customer if obj.site is not None else "—"

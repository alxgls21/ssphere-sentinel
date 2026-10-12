from django.contrib import admin
from django.core.paginator import Paginator
from django.db import connection
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.html import format_html

from apps.inventory.admin import DeviceAdmin
from apps.inventory.models import Device
from apps.snmp.models import (
    DevicePoll,
    DeviceSnmpState,
    Interface,
    InterfaceSample,
    SnmpConfig,
)


def format_uptime(ticks: int | None) -> str:
    """sysUpTime (hundredths of a second) as ``3d 4h 12m``."""
    if ticks is None:
        return "—"
    seconds = ticks // 100
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    return f"{days}d {hours}h {rest // 60}m"


def format_speed(bps: int | None) -> str:
    if bps is None:
        return "—"
    for unit, size in (("Gbit/s", 10**9), ("Mbit/s", 10**6), ("kbit/s", 10**3)):
        if bps >= size:
            return f"{bps / size:g} {unit}"
    return f"{bps} bit/s"


class EstimatedCountPaginator(Paginator):
    """Page counts from PostgreSQL's row estimate for big, unfiltered lists.

    ``COUNT(*)`` over tens of millions of history rows takes seconds on every
    page view. The estimate (refreshed by autovacuum) is plenty to page
    through read-only history; filtered and small lists are counted exactly.
    """

    threshold = 100_000

    @cached_property
    def count(self) -> int:
        queryset = self.object_list
        query = getattr(queryset, "query", None)
        if query is not None and not query.where:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT reltuples::bigint FROM pg_class WHERE oid = to_regclass(%s)",
                    [queryset.model._meta.db_table],
                )
                row = cursor.fetchone()
            if row and row[0] > self.threshold:
                return int(row[0])
        return super().count


class ReadOnlyAdmin(admin.ModelAdmin):
    """Data written by agents: visible, never edited or deleted by hand.

    History is removed by ``manage.py purge_snmp_data`` only.
    """

    show_full_result_count = False
    paginator = EstimatedCountPaginator

    def has_add_permission(self, request) -> bool:
        return False

    def has_change_permission(self, request, obj=None) -> bool:
        return False

    def has_delete_permission(self, request, obj=None) -> bool:
        return False


# --- devices: SNMP configuration inline -------------------------------------


class SnmpConfigInline(admin.StackedInline):
    model = SnmpConfig
    extra = 0
    max_num = 1
    fields = (
        "version",
        "port",
        "credential_profile",
        "poll_interval_seconds",
        "timeout_seconds",
        "retries",
    )


# The inventory admin is registered by apps.inventory; extend it here so that
# the inventory app does not depend on SNMP.
admin.site.unregister(Device)


@admin.register(Device)
class SnmpDeviceAdmin(DeviceAdmin):
    inlines = (SnmpConfigInline,)

    def get_deleted_objects(self, objs, request):
        # Django's delete confirmation loads every related row into memory: do
        # not even try for a device with polling history. Disable the device
        # and let retention remove the history instead.
        if DevicePoll.objects.filter(device__in=objs).exists():
            return (
                [],
                {},
                set(),
                [
                    "SNMP history exists for this device. Disable the device, and "
                    "delete it after the history has been purged "
                    "(manage.py purge_snmp_data)."
                ],
            )
        return super().get_deleted_objects(objs, request)


# --- read-only monitoring data -----------------------------------------------


@admin.register(DeviceSnmpState)
class DeviceSnmpStateAdmin(ReadOnlyAdmin):
    list_display = (
        "device",
        "reachable",
        "error",
        "last_poll_at",
        "response_ms",
        "uptime",
        "sys_name",
    )
    list_filter = ("reachable", "error")
    list_select_related = ("device",)
    search_fields = ("device__name", "sys_name", "sys_descr")
    ordering = ("device__name",)

    @admin.display(description="Uptime", ordering="sys_uptime_ticks")
    def uptime(self, obj: DeviceSnmpState) -> str:
        return format_uptime(obj.sys_uptime_ticks)


@admin.register(Interface)
class InterfaceAdmin(ReadOnlyAdmin):
    list_display = (
        "device",
        "name",
        "if_index",
        "admin_status",
        "oper_status",
        "speed",
        "present",
        "oper_status_changed_at",
    )
    list_filter = ("present", "oper_status", "admin_status")
    list_select_related = ("device",)
    search_fields = ("name", "descr", "alias", "device__name")
    ordering = ("device__name", "if_index")
    readonly_fields = ("samples_link",)

    @admin.display(description="Speed", ordering="speed_bps")
    def speed(self, obj: Interface) -> str:
        return format_speed(obj.speed_bps)

    @admin.display(description="Samples")
    def samples_link(self, obj: Interface):
        url = reverse("admin:snmp_interfacesample_changelist")
        return format_html('<a href="{}?interface__id__exact={}">View samples of this interface</a>', url, obj.pk)


@admin.register(DevicePoll)
class DevicePollAdmin(ReadOnlyAdmin):
    list_display = ("device", "measured_at", "reachable", "error", "response_ms", "uptime")
    list_filter = ("reachable", "error")
    list_select_related = ("device",)
    search_fields = ("device__name",)

    @admin.display(description="Uptime", ordering="sys_uptime_ticks")
    def uptime(self, obj: DevicePoll) -> str:
        return format_uptime(obj.sys_uptime_ticks)


@admin.register(InterfaceSample)
class InterfaceSampleAdmin(ReadOnlyAdmin):
    list_display = (
        "interface",
        "measured_at",
        "oper_status",
        "delta_state",
        "interval_seconds",
        "in_octets_delta",
        "out_octets_delta",
        "in_errors_delta",
        "out_errors_delta",
        "in_discards_delta",
        "out_discards_delta",
    )
    list_filter = ("delta_state", "oper_status")
    list_select_related = ("interface__device",)
    list_per_page = 50

    def lookup_allowed(self, lookup, value, request=None):
        # Used by the "View samples" link on the interface page.
        return lookup == "interface__id__exact" or super().lookup_allowed(lookup, value, request)

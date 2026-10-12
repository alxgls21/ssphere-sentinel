import re
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from apps.inventory.models import Customer, Device, Site
from apps.snmp.admin import format_speed, format_uptime
from apps.snmp.models import DevicePoll, Interface, InterfaceSample, SnmpConfig
from apps.snmp.tests.helpers import ingest, interface, make_agent, make_device, poll

MAX_CHANGELIST_QUERIES = 12


class SnmpAdminTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser("admin", "admin@example.com", "unused")
        self.client.force_login(self.user)
        self.agent, _token = make_agent()
        self.device = make_device(self.agent)
        ingest(self.agent, [poll(self.device, [interface(1, "Gi0/1"), interface(2, "Gi0/2")])])


class FormattingTests(TestCase):
    def test_uptime(self):
        self.assertEqual(format_uptime(None), "—")
        self.assertEqual(format_uptime(0), "0d 0h 0m")
        self.assertEqual(format_uptime(8_123_456), "0d 22h 33m")  # 81234 s
        self.assertEqual(format_uptime(2**32 - 1), "497d 2h 27m")

    def test_speed(self):
        self.assertEqual(format_speed(None), "—")
        self.assertEqual(format_speed(500), "500 bit/s")
        self.assertEqual(format_speed(100_000_000), "100 Mbit/s")
        self.assertEqual(format_speed(1_000_000_000), "1 Gbit/s")
        self.assertEqual(format_speed(2_500_000_000), "2.5 Gbit/s")
        self.assertEqual(format_speed(100_000_000_000), "100 Gbit/s")


class DeviceAdminSnmpTests(SnmpAdminTestCase):
    def form(self, **overrides):
        data = {
            "name": "new-sw",
            "device_type": "switch",
            "management_address": "192.0.2.40",
            "site": "",
            "assigned_agent": str(self.agent.pk),
            "enabled": "on",
            "description": "",
            "snmp_config-TOTAL_FORMS": "1",
            "snmp_config-INITIAL_FORMS": "0",
            "snmp_config-MIN_NUM_FORMS": "0",
            "snmp_config-MAX_NUM_FORMS": "1",
            "snmp_config-0-version": "3",
            "snmp_config-0-port": "161",
            "snmp_config-0-credential_profile": "core-switches",
            "snmp_config-0-poll_interval_seconds": "300",
            "snmp_config-0-timeout_seconds": "5",
            "snmp_config-0-retries": "1",
        }
        data.update(overrides)
        return data

    def test_snmp_configuration_is_edited_on_the_device_page(self):
        response = self.client.post(reverse("admin:inventory_device_add"), self.form())
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context["errors"])
        config = SnmpConfig.objects.get(device__name="new-sw")
        self.assertEqual((config.version, config.credential_profile, config.poll_interval_seconds), ("3", "core-switches", 300))

    def test_the_credential_form_has_no_secret_fields(self):
        response = self.client.get(reverse("admin:inventory_device_change", args=[self.device.pk]))
        field_names = re.findall(r'<(?:input|select|textarea)[^>]*\bname="([^"]+)"', response.content.decode())
        snmp_fields = {name for name in field_names if name.startswith("snmp_config-")}
        self.assertIn("snmp_config-0-credential_profile", snmp_fields)
        for name in field_names:
            for word in ("community", "password", "passphrase", "secret", "auth_key", "priv_key"):
                self.assertNotIn(word, name.lower())
        self.assertContains(response, "never stored in Sentinel")

    def test_invalid_snmp_settings_are_form_errors(self):
        for overrides in (
            {"snmp_config-0-version": "1"},
            {"snmp_config-0-credential_profile": "has space"},
            {"snmp_config-0-poll_interval_seconds": "5"},
            {"snmp_config-0-timeout_seconds": "200"},
        ):
            with self.subTest(**overrides):
                response = self.client.post(reverse("admin:inventory_device_add"), self.form(**overrides))
                self.assertEqual(response.status_code, 200)
                self.assertFalse(Device.objects.filter(name="new-sw").exists())

    def test_a_device_with_history_cannot_be_deleted_from_the_admin(self):
        url = reverse("admin:inventory_device_delete", args=[self.device.pk])
        page = self.client.get(url)
        self.assertContains(page, "Cannot delete device")
        self.assertContains(page, "SNMP history exists for this device")
        self.client.post(url, {"post": "yes"})
        self.assertTrue(Device.objects.filter(pk=self.device.pk).exists())
        self.assertEqual(DevicePoll.objects.count(), 1)

    def test_bulk_delete_of_devices_with_history_is_refused_too(self):
        spare = make_device(self.agent, "spare", management_address="192.0.2.99")
        response = self.client.post(
            reverse("admin:inventory_device_changelist"),
            {"action": "delete_selected", "_selected_action": [str(self.device.pk), str(spare.pk)], "post": "yes"},
        )
        self.assertContains(response, "Cannot delete")
        self.assertTrue(Device.objects.filter(pk__in=[self.device.pk, spare.pk]).count() == 2)

    def test_a_device_without_history_can_still_be_deleted(self):
        spare = make_device(self.agent, "spare", management_address="192.0.2.99")
        response = self.client.post(reverse("admin:inventory_device_delete", args=[spare.pk]), {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Device.objects.filter(pk=spare.pk).exists())


class ReadOnlyDataTests(SnmpAdminTestCase):
    MODELS = ("devicesnmpstate", "interface", "devicepoll", "interfacesample")

    def test_lists_render_with_the_data(self):
        for name in self.MODELS:
            with self.subTest(model=name):
                response = self.client.get(reverse(f"admin:snmp_{name}_changelist"))
                self.assertEqual(response.status_code, 200)
        self.assertContains(self.client.get(reverse("admin:snmp_interface_changelist")), "Gi0/1")
        state_page = self.client.get(reverse("admin:snmp_devicesnmpstate_changelist"))
        self.assertContains(state_page, "core-sw-1")
        self.assertContains(state_page, "0d 22h 33m")

    def test_nothing_can_be_added_changed_or_deleted_by_hand(self):
        pk = {
            "devicesnmpstate": self.device.pk,
            "interface": Interface.objects.first().pk,
            "devicepoll": DevicePoll.objects.first().pk,
            "interfacesample": InterfaceSample.objects.first().pk,
        }
        for name in self.MODELS:
            with self.subTest(model=name), self.assertLogs("django.request", level="WARNING"):
                self.assertEqual(self.client.get(reverse(f"admin:snmp_{name}_add")).status_code, 403)
                self.assertEqual(self.client.post(reverse(f"admin:snmp_{name}_change", args=[pk[name]]), {}).status_code, 403)
                self.assertEqual(self.client.get(reverse(f"admin:snmp_{name}_delete", args=[pk[name]])).status_code, 403)
        self.assertEqual(Interface.objects.count(), 2)

    def test_detail_pages_are_viewable(self):
        pk = {
            "devicesnmpstate": self.device.pk,
            "interface": Interface.objects.first().pk,
            "devicepoll": DevicePoll.objects.first().pk,
            "interfacesample": InterfaceSample.objects.first().pk,
        }
        for name in self.MODELS:
            with self.subTest(model=name):
                self.assertEqual(self.client.get(reverse(f"admin:snmp_{name}_change", args=[pk[name]])).status_code, 200)

    def test_samples_of_one_interface_can_be_listed_from_the_interface_page(self):
        first = Interface.objects.get(if_index=1)
        page = self.client.get(reverse("admin:snmp_interface_change", args=[first.pk]))
        link = f'{reverse("admin:snmp_interfacesample_changelist")}?interface__id__exact={first.pk}'
        self.assertContains(page, link)
        response = self.client.get(link)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([s.interface_id for s in response.context["cl"].result_list], [first.pk])

    def test_filters_and_search_on_interfaces(self):
        Interface.objects.filter(if_index=2).update(oper_status=2)
        url = reverse("admin:snmp_interface_changelist")

        def names(**params):
            return {i.name for i in self.client.get(url, params).context["cl"].result_list}

        self.assertEqual(names(), {"Gi0/1", "Gi0/2"})
        self.assertEqual(names(oper_status__exact="2"), {"Gi0/2"})
        self.assertEqual(names(q="core-sw"), {"Gi0/1", "Gi0/2"})
        self.assertEqual(names(q="Gi0/1"), {"Gi0/1"})

    def test_view_only_staff_can_read_but_not_change(self):
        viewer = get_user_model().objects.create_user("viewer", password="x", is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(codename="view_interface"))
        self.client.force_login(viewer)
        self.assertEqual(self.client.get(reverse("admin:snmp_interface_changelist")).status_code, 200)
        with self.assertLogs("django.request", level="WARNING"):
            self.assertEqual(self.client.get(reverse("admin:snmp_devicepoll_changelist")).status_code, 403)


class SnmpAdminQueryCountTests(SnmpAdminTestCase):
    """Changelists must not issue per-row queries (N+1)."""

    def _grow(self, count):
        for index in range(count):
            customer = Customer.objects.create(name=f"c-{self.round}-{index}")
            site = Site.objects.create(customer=customer, name="hq")
            agent, _token = make_agent(f"agent-{self.round}-{index}")
            device = make_device(agent, f"dev-{self.round}-{index}", site=site)
            ingest(agent, [poll(device, [interface(i) for i in range(1, 4)], minutes=m) for m in (2, 1)])
        self.round += 1

    def _queries(self, name):
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(reverse(f"admin:snmp_{name}_changelist"))
        self.assertEqual(response.status_code, 200)
        return len(captured)

    def test_query_count_does_not_grow_with_rows(self):
        self.round = 0
        names = ("devicesnmpstate", "interface", "devicepoll", "interfacesample")
        self._grow(2)
        small = {name: self._queries(name) for name in names}
        self._grow(10)
        large = {name: self._queries(name) for name in names}
        for name in names:
            with self.subTest(model=name):
                self.assertEqual(large[name], small[name])
                self.assertLessEqual(large[name], MAX_CHANGELIST_QUERIES)

    def test_device_list_with_snmp_inline_is_flat_too(self):
        self.round = 0
        self._grow(2)
        with CaptureQueriesContext(connection) as small:
            self.client.get(reverse("admin:inventory_device_changelist"))
        self._grow(10)
        with CaptureQueriesContext(connection) as large:
            self.client.get(reverse("admin:inventory_device_changelist"))
        self.assertEqual(len(large), len(small))


class EstimatedCountPaginatorTests(SnmpAdminTestCase):
    """Big, unfiltered history lists use the planner's row estimate, not COUNT(*)."""

    def paginator(self, queryset, threshold):
        from apps.snmp.admin import EstimatedCountPaginator

        class Paginator(EstimatedCountPaginator):
            pass

        Paginator.threshold = threshold
        return Paginator(queryset, 10)

    def analyze(self):
        with connection.cursor() as cursor:
            cursor.execute('ANALYZE "snmp_interfacesample"')

    def test_small_or_unanalyzed_tables_are_counted_exactly(self):
        # Never analyzed: reltuples is -1 (or 0), far below any threshold.
        self.assertEqual(self.paginator(InterfaceSample.objects.all(), threshold=100_000).count, InterfaceSample.objects.count())

    def test_big_unfiltered_lists_use_the_estimate(self):
        self.analyze()
        estimated = InterfaceSample.objects.count()
        # More rows arrive: the estimate is stale until autovacuum, but cheap.
        ingest(self.agent, [poll(self.device, [interface(1), interface(2)], minutes=m) for m in (5, 4, 3)])
        exact = InterfaceSample.objects.count()
        self.assertGreater(exact, estimated)
        self.assertEqual(self.paginator(InterfaceSample.objects.all(), threshold=1).count, estimated)

    def test_filtered_lists_are_always_counted_exactly(self):
        self.analyze()
        filtered = InterfaceSample.objects.filter(oper_status=1)
        self.assertEqual(self.paginator(filtered, threshold=0).count, filtered.count())

    def test_lists_below_the_threshold_are_counted_exactly(self):
        self.analyze()
        self.assertEqual(self.paginator(InterfaceSample.objects.all(), threshold=10**9).count, InterfaceSample.objects.count())

    def test_the_admin_pages_still_work_with_the_estimate(self):
        self.analyze()
        from apps.snmp import admin as snmp_admin

        with patch.object(snmp_admin.EstimatedCountPaginator, "threshold", 0):
            response = self.client.get(reverse("admin:snmp_interfacesample_changelist"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["cl"].result_list), InterfaceSample.objects.count())

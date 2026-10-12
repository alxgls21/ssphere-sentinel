from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Device, Site

MAX_CHANGELIST_QUERIES = 12


class InventoryAdminTestCase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser(
            username="admin", email="admin@example.com", password="unused"
        )
        self.client.force_login(self.user)
        self.customer = Customer.objects.create(name="Acme")
        self.site = Site.objects.create(customer=self.customer, name="HQ")
        server = Server.objects.create(name="poller", hostname="poller.local")
        self.agent, _token = create_agent(server=server, name="poller-agent")


class CustomerAdminTests(InventoryAdminTestCase):
    def test_add_customer(self):
        response = self.client.post(
            reverse("admin:inventory_customer_add"),
            {"name": "  Globex  ", "notes": "", "sites-TOTAL_FORMS": "0", "sites-INITIAL_FORMS": "0"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Customer.objects.filter(name="Globex").exists())

    def test_duplicate_name_is_a_form_error_not_a_crash(self):
        response = self.client.post(
            reverse("admin:inventory_customer_add"),
            {"name": "ACME", "notes": "", "sites-TOTAL_FORMS": "0", "sites-INITIAL_FORMS": "0"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "A customer with this name already exists.")
        self.assertEqual(Customer.objects.count(), 1)

    def test_change_page_shows_the_id_and_sites_inline(self):
        response = self.client.get(reverse("admin:inventory_customer_change", args=[self.customer.pk]))
        self.assertContains(response, str(self.customer.pk))
        self.assertContains(response, "HQ")

    def test_site_can_be_added_through_the_customer_inline(self):
        url = reverse("admin:inventory_customer_change", args=[self.customer.pk])
        response = self.client.post(
            url,
            {
                "name": "Acme",
                "notes": "",
                "sites-TOTAL_FORMS": "2",
                "sites-INITIAL_FORMS": "1",
                "sites-0-id": str(self.site.pk),
                "sites-0-customer": str(self.customer.pk),
                "sites-0-name": "HQ",
                "sites-0-description": "",
                "sites-1-id": "",
                "sites-1-customer": str(self.customer.pk),
                "sites-1-name": "Patras Branch",
                "sites-1-description": "",
            },
        )
        self.assertEqual(response.status_code, 302, getattr(response, "context", None) and response.context["errors"])
        self.assertEqual(
            sorted(self.customer.sites.values_list("name", flat=True)), ["HQ", "Patras Branch"]
        )

    def test_customer_with_sites_cannot_be_deleted(self):
        url = reverse("admin:inventory_customer_delete", args=[self.customer.pk])
        page = self.client.get(url)
        self.assertContains(page, "Cannot delete customer")
        response = self.client.post(url, {"post": "yes"})
        self.assertEqual(response.status_code, 200)  # refused, not deleted
        self.assertTrue(Customer.objects.filter(pk=self.customer.pk).exists())

    def test_list_shows_site_counts_and_search_works(self):
        Customer.objects.create(name="Globex")
        response = self.client.get(reverse("admin:inventory_customer_changelist"))
        self.assertContains(response, "Acme")
        self.assertContains(response, "Globex")
        response = self.client.get(reverse("admin:inventory_customer_changelist"), {"q": "glob"})
        self.assertContains(response, "Globex")
        self.assertNotContains(response, "Acme")


class SiteAdminTests(InventoryAdminTestCase):
    def test_add_site(self):
        response = self.client.post(
            reverse("admin:inventory_site_add"),
            {"customer": str(self.customer.pk), "name": "Branch", "description": "North"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(Site.objects.filter(customer=self.customer, name="Branch").exists())

    def test_duplicate_site_name_for_a_customer_is_a_form_error(self):
        response = self.client.post(
            reverse("admin:inventory_site_add"),
            {"customer": str(self.customer.pk), "name": "hq", "description": ""},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "This customer already has a site with this name.")

    def test_site_list_filters_by_customer(self):
        other = Customer.objects.create(name="Globex")
        Site.objects.create(customer=other, name="Other site")
        response = self.client.get(
            reverse("admin:inventory_site_changelist"), {"customer__id__exact": str(other.pk)}
        )
        self.assertContains(response, "Other site")
        self.assertNotContains(response, ">HQ<")

    def test_autocomplete_labels_include_the_customer(self):
        response = self.client.get(
            reverse("admin:autocomplete"),
            {
                "term": "hq",
                "app_label": "inventory",
                "model_name": "device",
                "field_name": "site",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["text"] for item in response.json()["results"]], ["Acme / HQ"])


class DeviceAdminTests(InventoryAdminTestCase):
    def form_data(self, **overrides):
        data = {
            "name": "core-sw-1",
            "device_type": "switch",
            "management_address": "192.0.2.10",
            "site": str(self.site.pk),
            "assigned_agent": str(self.agent.pk),
            "enabled": "on",
            "description": "",
        }
        data.update(overrides)
        return data

    def test_add_device(self):
        response = self.client.post(reverse("admin:inventory_device_add"), self.form_data())
        self.assertEqual(response.status_code, 302)
        device = Device.objects.get()
        self.assertEqual(
            (device.name, device.device_type, device.site, device.assigned_agent),
            ("core-sw-1", "switch", self.site, self.agent),
        )

    def test_add_device_without_site_or_agent(self):
        response = self.client.post(
            reverse("admin:inventory_device_add"),
            self.form_data(site="", assigned_agent="", name="spare"),
        )
        self.assertEqual(response.status_code, 302)
        self.assertIsNone(Device.objects.get().site)

    def test_invalid_address_is_a_form_error(self):
        for address in ("not valid!", "0.0.0.0", "a;b", "256.1.1.1"):
            with self.subTest(address=address):
                response = self.client.post(
                    reverse("admin:inventory_device_add"), self.form_data(management_address=address)
                )
                self.assertEqual(response.status_code, 200)
                self.assertContains(response, "errorlist")
        self.assertFalse(Device.objects.exists())

    def test_duplicate_name_in_a_site_is_a_form_error(self):
        Device.objects.create(name="core-sw-1", management_address="192.0.2.1", site=self.site)
        response = self.client.post(reverse("admin:inventory_device_add"), self.form_data(name="CORE-SW-1"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "This site already has a device with this name.")
        self.assertEqual(Device.objects.count(), 1)

    def test_change_page_shows_the_uuid_read_only(self):
        device = Device.objects.create(name="r1", management_address="192.0.2.1")
        url = reverse("admin:inventory_device_change", args=[device.pk])
        response = self.client.get(url)
        self.assertContains(response, str(device.pk))
        response = self.client.post(url, {**self.form_data(name="r1-renamed"), "id": "x"})
        self.assertEqual(response.status_code, 302)
        device.refresh_from_db()
        self.assertEqual(device.name, "r1-renamed")  # id is not editable

    def test_list_filters_and_search(self):
        other = Customer.objects.create(name="Globex")
        other_site = Site.objects.create(customer=other, name="Plant")
        Device.objects.create(name="acme-fw", management_address="192.0.2.1", site=self.site, device_type="firewall")
        Device.objects.create(name="globex-rtr", management_address="198.51.100.1", site=other_site, device_type="router")
        Device.objects.create(name="loose", management_address="203.0.113.5")
        url = reverse("admin:inventory_device_changelist")

        def names(**params):
            response = self.client.get(url, params)
            return {device.name for device in response.context["cl"].result_list}

        self.assertEqual(names(), {"acme-fw", "globex-rtr", "loose"})
        self.assertEqual(names(site__customer__id__exact=str(other.pk)), {"globex-rtr"})
        self.assertEqual(names(device_type__exact="firewall"), {"acme-fw"})
        self.assertEqual(names(q="198.51"), {"globex-rtr"})
        self.assertEqual(names(q="globex"), {"globex-rtr"})  # by customer name
        self.assertEqual(names(q="Plant"), {"globex-rtr"})  # by site name

    def test_list_shows_customer_and_handles_devices_without_a_site(self):
        Device.objects.create(name="acme-fw", management_address="192.0.2.1", site=self.site)
        Device.objects.create(name="loose", management_address="203.0.113.5")
        response = self.client.get(reverse("admin:inventory_device_changelist"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Acme / HQ")
        self.assertContains(response, "—")

    def test_deleting_a_site_with_devices_is_refused(self):
        Device.objects.create(name="acme-fw", management_address="192.0.2.1", site=self.site)
        url = reverse("admin:inventory_site_delete", args=[self.site.pk])
        self.assertContains(self.client.get(url), "Cannot delete site")
        self.client.post(url, {"post": "yes"})
        self.assertTrue(Site.objects.filter(pk=self.site.pk).exists())

    def test_staff_without_permissions_cannot_see_inventory(self):
        staff = get_user_model().objects.create_user("staff", password="x", is_staff=True)
        self.client.force_login(staff)
        for name in ("customer", "site", "device"):
            with self.subTest(model=name), self.assertLogs("django.request", level="WARNING"):
                response = self.client.get(reverse(f"admin:inventory_{name}_changelist"))
            self.assertEqual(response.status_code, 403)

    def test_view_only_staff_cannot_change_devices(self):
        device = Device.objects.create(name="r1", management_address="192.0.2.1")
        viewer = get_user_model().objects.create_user("viewer", password="x", is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(codename="view_device"))
        self.client.force_login(viewer)
        url = reverse("admin:inventory_device_change", args=[device.pk])
        self.assertEqual(self.client.get(url).status_code, 200)
        with self.assertLogs("django.request", level="WARNING"):
            response = self.client.post(url, self.form_data(name="hacked"))
        self.assertEqual(response.status_code, 403)
        device.refresh_from_db()
        self.assertEqual(device.name, "r1")


class InventoryAdminQueryCountTests(InventoryAdminTestCase):
    """Changelists must not issue per-row queries (N+1)."""

    def _add_inventory(self, count):
        for index in range(count):
            customer = Customer.objects.create(name=f"customer-{self.created}-{index}")
            for site_index in range(2):
                site = Site.objects.create(customer=customer, name=f"site-{site_index}")
                server = Server.objects.create(name=f"srv-{self.created}-{index}-{site_index}", hostname="h")
                agent, _token = create_agent(server=server, name=f"agent-{self.created}-{index}-{site_index}")
                Device.objects.create(
                    name=f"dev-{self.created}-{index}-{site_index}",
                    management_address="192.0.2.1",
                    site=site,
                    assigned_agent=agent,
                )
        self.created += 1

    def _queries(self, name):
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(reverse(f"admin:inventory_{name}_changelist"))
        self.assertEqual(response.status_code, 200)
        return len(captured)

    def test_changelist_query_count_does_not_grow_with_rows(self):
        self.created = 0
        self._add_inventory(2)
        small = {name: self._queries(name) for name in ("customer", "site", "device")}
        self._add_inventory(12)
        large = {name: self._queries(name) for name in ("customer", "site", "device")}
        for name in small:
            with self.subTest(model=name):
                self.assertEqual(large[name], small[name])
                self.assertLessEqual(large[name], MAX_CHANGELIST_QUERIES)

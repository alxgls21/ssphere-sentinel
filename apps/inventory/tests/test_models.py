import uuid

from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.models import ProtectedError
from django.test import TestCase

from apps.agents.services import create_agent
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Device, Site


def make_device(name="core-sw", **overrides):
    values = {"name": name, "management_address": "192.0.2.10"}
    values.update(overrides)
    return Device.objects.create(**values)


class CustomerTests(TestCase):
    def test_defaults_and_string_form(self):
        customer = Customer.objects.create(name="Acme Corp")
        self.assertIsInstance(customer.pk, uuid.UUID)
        self.assertEqual(str(customer), "Acme Corp")
        self.assertIsNotNone(customer.created_at)
        self.assertIsNotNone(customer.updated_at)

    def test_name_is_stripped_and_must_not_be_blank(self):
        self.assertEqual(Customer.objects.create(name="  Acme  ").name, "Acme")
        for blank in ("", "   ", "\t\n"):
            with self.subTest(name=repr(blank)):
                with self.assertRaises(ValidationError):
                    Customer.objects.create(name=blank)
        self.assertEqual(Customer.objects.count(), 1)

    def test_name_is_unique_ignoring_case_and_surrounding_whitespace(self):
        Customer.objects.create(name="Acme")
        for duplicate in ("acme", "ACME", " Acme ", "aCmE"):
            with self.subTest(name=duplicate):
                with self.assertRaisesMessage(ValidationError, "already exists"):
                    Customer.objects.create(name=duplicate)

    def test_database_enforces_name_uniqueness_when_validation_is_bypassed(self):
        Customer.objects.create(name="Acme")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Customer.objects.bulk_create([Customer(name="ACME")])

    def test_name_longer_than_255_characters_is_rejected(self):
        with self.assertRaises(ValidationError):
            Customer.objects.create(name="x" * 256)

    def test_customers_are_ordered_by_name(self):
        for name in ("Zeta", "Alpha", "Mid"):
            Customer.objects.create(name=name)
        self.assertEqual(
            list(Customer.objects.values_list("name", flat=True)), ["Alpha", "Mid", "Zeta"]
        )


class SiteTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")

    def test_string_form_includes_the_customer(self):
        site = Site.objects.create(customer=self.acme, name="Athens DC")
        self.assertEqual(str(site), "Acme / Athens DC")

    def test_name_is_unique_per_customer_ignoring_case(self):
        Site.objects.create(customer=self.acme, name="HQ")
        with self.assertRaisesMessage(ValidationError, "already has a site"):
            Site.objects.create(customer=self.acme, name=" hq ")

    def test_same_name_is_allowed_for_different_customers(self):
        Site.objects.create(customer=self.acme, name="HQ")
        Site.objects.create(customer=self.globex, name="HQ")
        self.assertEqual(Site.objects.filter(name="HQ").count(), 2)

    def test_blank_name_is_rejected(self):
        with self.assertRaises(ValidationError):
            Site.objects.create(customer=self.acme, name="  ")

    def test_customer_is_required(self):
        with self.assertRaises(ValidationError):
            Site.objects.create(name="Orphan")

    def test_customer_with_sites_cannot_be_deleted(self):
        Site.objects.create(customer=self.acme, name="HQ")
        with self.assertRaises(ProtectedError):
            self.acme.delete()
        self.assertTrue(Customer.objects.filter(pk=self.acme.pk).exists())
        self.globex.delete()  # without sites it can be deleted
        self.assertFalse(Customer.objects.filter(pk=self.globex.pk).exists())

    def test_sites_are_ordered_by_customer_then_name(self):
        Site.objects.create(customer=self.globex, name="A")
        Site.objects.create(customer=self.acme, name="Z")
        Site.objects.create(customer=self.acme, name="B")
        self.assertEqual(
            [str(site) for site in Site.objects.select_related("customer")],
            ["Acme / B", "Acme / Z", "Globex / A"],
        )


class DeviceTests(TestCase):
    def setUp(self):
        self.customer = Customer.objects.create(name="Acme")
        self.site = Site.objects.create(customer=self.customer, name="HQ")
        self.other_site = Site.objects.create(customer=self.customer, name="Branch")

    def test_defaults(self):
        device = make_device()
        self.assertIsInstance(device.pk, uuid.UUID)
        self.assertEqual(device.device_type, Device.DeviceType.OTHER)
        self.assertTrue(device.enabled)
        self.assertIsNone(device.site)
        self.assertIsNone(device.assigned_agent)
        self.assertEqual(device.description, "")
        self.assertEqual(str(device), "core-sw")

    def test_device_types(self):
        self.assertEqual(
            {value for value, _label in Device.DeviceType.choices},
            {"router", "switch", "firewall", "other"},
        )
        with self.assertRaises(ValidationError):
            make_device(device_type="toaster")

    def test_name_and_address_are_normalized_before_validation(self):
        device = make_device(name="  edge-1  ", management_address="  192.0.2.7  ")
        self.assertEqual((device.name, device.management_address), ("edge-1", "192.0.2.7"))
        for blank in ("", "   "):
            with self.subTest(name=repr(blank)):
                with self.assertRaises(ValidationError):
                    make_device(name=blank)

    def test_management_address_is_validated(self):
        for address in ("", "not valid", "0.0.0.0", "224.0.0.1", "a;b", "256.1.1.1"):
            with self.subTest(address=address):
                with self.assertRaises(ValidationError) as caught:
                    make_device(name=f"d-{abs(hash(address))}", management_address=address)
                self.assertIn("management_address", caught.exception.message_dict)
        for address in ("192.0.2.1", "2001:db8::1", "router.example.com"):
            with self.subTest(address=address):
                make_device(name=f"ok-{address}", management_address=address)

    def test_address_does_not_have_to_be_unique(self):
        # Customers commonly use overlapping private address ranges.
        first = make_device("a", site=self.site, management_address="10.0.0.1")
        second = make_device("b", site=self.other_site, management_address="10.0.0.1")
        self.assertEqual(first.management_address, second.management_address)

    def test_name_is_unique_within_a_site_ignoring_case(self):
        make_device("core", site=self.site)
        with self.assertRaisesMessage(ValidationError, "already has a device"):
            make_device("CORE", site=self.site)
        make_device("core", site=self.other_site)  # another site: fine

    def test_unassigned_device_names_are_unique_among_unassigned_devices(self):
        make_device("spare")
        with self.assertRaisesMessage(ValidationError, "unassigned device"):
            make_device("Spare")
        make_device("spare", site=self.site)  # assigned to a site: fine

    def test_database_enforces_name_uniqueness_when_validation_is_bypassed(self):
        for kwargs in ({"site": self.site}, {}):
            with self.subTest(site=bool(kwargs)):
                make_device("dup", **kwargs)
                with self.assertRaises(IntegrityError), transaction.atomic():
                    Device.objects.bulk_create(
                        [Device(name="DUP", management_address="192.0.2.99", **kwargs)]
                    )

    def test_updating_a_device_does_not_trip_its_own_uniqueness_check(self):
        device = make_device("core", site=self.site)
        device.description = "changed"
        device.save()
        device.refresh_from_db()
        self.assertEqual(device.description, "changed")

    def test_site_with_devices_cannot_be_deleted(self):
        make_device(site=self.site)
        with self.assertRaises(ProtectedError):
            self.site.delete()
        self.other_site.delete()  # no devices: fine

    def test_deleting_the_agent_keeps_the_device_unassigned(self):
        server = Server.objects.create(name="poller", hostname="poller.local")
        agent, _token = create_agent(server=server, name="poller-agent")
        device = make_device(assigned_agent=agent)
        self.assertEqual(list(agent.devices.all()), [device])
        agent.delete()
        device.refresh_from_db()
        self.assertIsNone(device.assigned_agent)

    def test_several_devices_can_share_an_agent(self):
        server = Server.objects.create(name="poller", hostname="poller.local")
        agent, _token = create_agent(server=server, name="poller-agent")
        make_device("a", assigned_agent=agent)
        make_device("b", assigned_agent=agent)
        self.assertEqual(agent.devices.count(), 2)

    def test_device_without_site_is_allowed_and_can_be_assigned_later(self):
        device = make_device()
        device.site = self.site
        device.save()
        self.assertEqual(list(self.site.devices.all()), [device])


class SchemaTests(TestCase):
    def test_uniqueness_is_backed_by_the_expected_indexes(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE tablename LIKE 'inventory_%' AND indexdef LIKE 'CREATE UNIQUE%'"
            )
            definitions = dict(cursor.fetchall())
        self.assertIn("lower", definitions["uniq_customer_name_ci"].lower())
        self.assertIn("customer_id", definitions["uniq_site_name_per_customer_ci"])
        self.assertIn("site_id", definitions["uniq_device_name_per_site_ci"])
        self.assertIn("WHERE (site_id IS NULL)", definitions["uniq_unassigned_device_name_ci"])

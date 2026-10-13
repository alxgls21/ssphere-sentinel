"""Customer/site isolation: what a user may see is decided in the query."""

import random
import uuid

from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from apps.console.access import NotVisible, Scope, Visibility
from apps.console.tests.helpers import Org, make_user
from apps.inventory.models import Customer, Device, Site
from apps.snmp.models import Interface


def names(queryset):
    return sorted(queryset.values_list("name", flat=True))


class VisibilityRulesTests(TestCase):
    def setUp(self):
        self.org = Org()

    def visible_devices(self, user, **kwargs):
        return names(Visibility.for_user(user).filter(Device.objects.all(), **kwargs))

    def test_a_user_without_the_permission_sees_nothing_even_with_grants(self):
        user = make_user("no-perm", console=False, customers=[self.org.acme])
        self.assertEqual(self.visible_devices(user), [])
        self.assertEqual(list(Visibility.for_user(user).sites()), [])
        self.assertEqual(list(Visibility.for_user(user).customers()), [])

    def test_a_console_user_without_grants_sees_nothing(self):
        self.assertEqual(self.visible_devices(make_user()), [])

    def test_inactive_and_anonymous_users_see_nothing(self):
        from django.contrib.auth.models import AnonymousUser

        user = make_user("inactive", all_customers=True, active=False)
        self.assertEqual(self.visible_devices(user), [])
        self.assertEqual(Visibility.for_user(AnonymousUser()).sites().count(), 0)
        self.assertEqual(Visibility.for_user(None).customers().count(), 0)

    def test_a_customer_grant_shows_all_its_sites_including_future_ones(self):
        user = make_user(customers=[self.org.acme])
        self.assertEqual(self.visible_devices(user), ["acme-dc-sw", "acme-hq-sw"])
        new_site = Site.objects.create(customer=self.org.acme, name="Branch")
        self.org.device("acme-branch-sw", new_site)
        self.assertEqual(self.visible_devices(user), ["acme-branch-sw", "acme-dc-sw", "acme-hq-sw"])

    def test_a_site_grant_shows_that_site_only_not_its_siblings(self):
        user = make_user(sites=[self.org.acme_hq])
        self.assertEqual(self.visible_devices(user), ["acme-hq-sw"])
        visibility = Visibility.for_user(user)
        self.assertEqual(names(visibility.sites()), ["HQ"])
        # The customer's name is needed to label the site, nothing else of it.
        self.assertEqual(names(visibility.customers()), ["Acme"])

    def test_grants_combine(self):
        user = make_user(customers=[self.org.acme], sites=[self.org.globex_plant])
        self.assertEqual(self.visible_devices(user), ["acme-dc-sw", "acme-hq-sw", "globex-plant-sw"])

    def test_objects_without_a_site_are_never_visible_to_restricted_users(self):
        user = make_user(customers=[self.org.acme, self.org.globex, self.org.empty])
        self.assertNotIn("unassigned-sw", self.visible_devices(user))

    def test_view_all_customers_sees_everything_including_unassigned(self):
        user = make_user("ops", all_customers=True)
        self.assertEqual(len(self.visible_devices(user)), 4)
        self.assertEqual(Visibility.for_user(user).sites().count(), 3)
        self.assertEqual(Visibility.for_user(user).customers().count(), 3)

    def test_a_superuser_sees_everything(self):
        self.assertEqual(len(self.visible_devices(make_user("root", superuser=True, console=False))), 4)

    def test_a_customer_without_sites_is_visible_when_granted(self):
        user = make_user(customers=[self.org.empty])
        self.assertEqual(names(Visibility.for_user(user).customers()), ["Empty Corp"])
        self.assertEqual(self.visible_devices(user), [])

    def test_revoking_a_grant_takes_effect_on_the_next_query(self):
        user = make_user(customers=[self.org.acme])
        self.assertTrue(self.visible_devices(user))
        user.console_customer_access.all().delete()
        self.assertEqual(self.visible_devices(user), [])

    def test_deleting_a_site_or_customer_removes_the_grants_that_point_to_it(self):
        user = make_user(customers=[self.org.empty], sites=[self.org.acme_hq])
        self.org.dev_hq.delete()
        self.org.acme_hq.delete()
        self.org.empty.delete()
        self.assertEqual(user.console_site_access.count(), 0)
        self.assertEqual(user.console_customer_access.count(), 0)


class ScopeTests(TestCase):
    def setUp(self):
        self.org = Org()

    def test_a_scope_narrows_within_what_is_visible(self):
        user = make_user(customers=[self.org.acme, self.org.globex])
        visibility = Visibility.for_user(user)
        scope = visibility.resolve_scope(self.org.acme.pk, None)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=scope)), ["acme-dc-sw", "acme-hq-sw"])
        scope = visibility.resolve_scope(None, self.org.globex_plant.pk)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=scope)), ["globex-plant-sw"])

    def test_a_scope_can_never_widen_the_grants(self):
        user = make_user(sites=[self.org.acme_hq])
        visibility = Visibility.for_user(user)
        # Customer scope on a site-only grant: still only the granted site.
        scope = visibility.resolve_scope(self.org.acme.pk, None)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=scope)), ["acme-hq-sw"])

    def test_invisible_unknown_or_mismatched_scopes_are_not_found(self):
        user = make_user(customers=[self.org.acme])
        visibility = Visibility.for_user(user)
        for customer, site in (
            (self.org.globex.pk, None),
            (None, self.org.globex_plant.pk),
            (uuid.uuid4(), None),
            (None, uuid.uuid4()),
            (self.org.acme.pk, self.org.globex_plant.pk),  # a visible customer and an invisible site
        ):
            with self.subTest(customer=customer, site=site), self.assertRaises(NotVisible):
                visibility.resolve_scope(customer, site)

    def test_a_site_that_is_not_the_customers_is_not_found_even_for_all_access(self):
        visibility = Visibility.for_user(make_user("ops", all_customers=True))
        with self.assertRaises(NotVisible):
            visibility.resolve_scope(self.org.globex.pk, self.org.acme_hq.pk)

    def test_all_access_can_scope_and_the_scope_excludes_unassigned_objects(self):
        visibility = Visibility.for_user(make_user("ops", all_customers=True))
        scope = visibility.resolve_scope(self.org.acme.pk, None)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=scope)), ["acme-dc-sw", "acme-hq-sw"])

    def test_no_scope_is_allowed_and_empty(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        self.assertEqual(visibility.resolve_scope(None, None), Scope())


class NestedPathTests(TestCase):
    """Models that reach their site through another relation (``device__site``)."""

    def setUp(self):
        self.org = Org()
        for device in self.org.devices:
            Interface.objects.create(device=device, if_index=1, name=f"{device.name}-gi1", admin_status=1, oper_status=1)

    def test_filtering_through_a_relation(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        rows = visibility.filter(Interface.objects.all(), site_path="device__site")
        self.assertEqual(names(rows), ["acme-dc-sw-gi1", "acme-hq-sw-gi1"])

    def test_scope_through_a_relation(self):
        visibility = Visibility.for_user(make_user("ops", all_customers=True))
        scope = visibility.resolve_scope(None, self.org.acme_hq.pk)
        rows = visibility.filter(Interface.objects.all(), site_path="device__site", scope=scope)
        self.assertEqual(names(rows), ["acme-hq-sw-gi1"])


class QueryShapeTests(TestCase):
    def setUp(self):
        self.org = Org()

    def test_the_grants_become_sql_and_the_data_query_carries_the_restriction(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme], sites=[self.org.globex_plant]))
        with CaptureQueriesContext(connection) as captured:
            rows = list(visibility.filter(Device.objects.all()))
        self.assertEqual(len(rows), 3)
        # One lookup of the visible sites (the grants as subqueries, in the database)...
        lookup, data = (q["sql"].lower() for q in captured)
        self.assertIn("console_customeraccess", lookup)
        self.assertIn("console_siteaccess", lookup)
        # ...and the data query itself, restricted by the data table's own column.
        self.assertIn('"inventory_device"."site_id" in (', data)
        self.assertEqual(len(captured), 2)

    def test_the_query_count_does_not_grow_with_the_number_of_customers(self):
        user = make_user(customers=[self.org.acme])
        for i in range(30):
            customer = Customer.objects.create(name=f"Bulk {i}")
            site = Site.objects.create(customer=customer, name="S")
            self.org.device(f"bulk-{i}", site)
        visibility = Visibility.for_user(user)
        with CaptureQueriesContext(connection) as captured:
            list(visibility.filter(Device.objects.all()))
            list(visibility.sites())
            list(visibility.customers())
        self.assertEqual(len(captured), 4)  # the visible-site lookup, then one query each


class RandomizedIsolationTests(TestCase):
    """Whatever the grants, the visible set equals a brute-force computation."""

    def test_random_grants_match_a_reference_implementation(self):
        rng = random.Random(20261012)
        customers = [Customer.objects.create(name=f"C{i}") for i in range(6)]
        sites = [Site.objects.create(customer=rng.choice(customers), name=f"S{i}") for i in range(12)]
        devices = [
            Device.objects.create(name=f"d{i}", management_address="192.0.2.1", site=rng.choice([*sites, None]))
            for i in range(40)
        ]
        for round_number in range(40):
            granted_customers = rng.sample(customers, rng.randint(0, 3))
            granted_sites = rng.sample(sites, rng.randint(0, 4))
            user = make_user(f"u{round_number}", customers=granted_customers, sites=granted_sites)
            expected_site_ids = {
                site.pk
                for site in sites
                if site.customer_id in {c.pk for c in granted_customers} or site in granted_sites
            }
            expected = sorted(d.name for d in devices if d.site_id in expected_site_ids)
            visibility = Visibility.for_user(user)
            self.assertEqual(names(visibility.filter(Device.objects.all())), expected, round_number)
            self.assertEqual({s.pk for s in visibility.sites()}, expected_site_ids)
            expected_customers = {c.pk for c in granted_customers} | {
                s.customer_id for s in sites if s.pk in expected_site_ids and s in granted_sites
            }
            self.assertEqual({c.pk for c in visibility.customers()}, expected_customers)


class SitePathValidationTests(TestCase):
    """A wrong ``site_path`` fails loudly instead of returning duplicates or the wrong rows."""

    def setUp(self):
        self.org = Org()
        self.visibility = Visibility.for_user(make_user("ops", all_customers=True))

    def test_valid_paths(self):
        self.visibility.filter(Device.objects.all(), site_path="site")
        self.visibility.filter(Interface.objects.all(), site_path="device__site")

    def test_invalid_paths_raise_at_the_first_call(self):
        for model, path in (
            (Device, "sites"),  # not a field
            (Device, "assigned_agent"),  # a foreign key, but not to Site
            (Device, "site__customer"),  # ends at Customer
            (Device, "site__devices"),  # a reverse relation
            (Site, "devices"),  # reverse, multi-valued
            (Customer, "sites__customer"),  # reverse relation first
            (Device, "name"),  # not a relation
            (Device, "site_id"),  # the column, not the relation
            (Interface, "device"),  # ends at Device
            (Interface, "samples__interface__device__site"),  # reverse relation inside
        ):
            with self.subTest(model=model.__name__, path=path), self.assertRaises(ImproperlyConfigured):
                self.visibility.filter(model.objects.all(), site_path=path)

    def test_even_nobody_gets_the_check(self):
        with self.assertRaises(ImproperlyConfigured):
            Visibility.nobody().filter(Device.objects.all(), site_path="nope")


class ScopeParsingTests(TestCase):
    """``resolve_scope`` takes what a query string gives it."""

    def setUp(self):
        self.org = Org()
        self.visibility = Visibility.for_user(make_user(customers=[self.org.acme]))

    def test_strings_and_uuids_are_equivalent(self):
        expected = Scope(customer_id=self.org.acme.pk, site_id=self.org.acme_hq.pk)
        self.assertEqual(self.visibility.resolve_scope(str(self.org.acme.pk), str(self.org.acme_hq.pk)), expected)
        self.assertEqual(self.visibility.resolve_scope(self.org.acme.pk, self.org.acme_hq.pk), expected)
        self.assertEqual(self.visibility.resolve_scope(str(self.org.acme.pk).upper(), None).customer_id, self.org.acme.pk)

    def test_the_ui_sends_both_ids_when_a_site_is_picked(self):
        scope = self.visibility.resolve_scope(str(self.org.acme.pk), str(self.org.acme_dc.pk))
        self.assertEqual(names(self.visibility.filter(Device.objects.all(), scope=scope)), ["acme-dc-sw"])

    def test_malformed_ids_are_not_found_not_a_500(self):
        for bad in ("", "abc", "\x00", "1" * 40, " ", "{}", 5, ["x"], b"x"):
            for position in (0, 1):
                args = [None, None]
                args[position] = bad
                with self.subTest(bad=bad, position=position), self.assertRaises(NotVisible):
                    self.visibility.resolve_scope(*args)

    def test_a_valid_pair_whose_site_belongs_elsewhere_is_not_found(self):
        with self.assertRaises(NotVisible):
            self.visibility.resolve_scope(str(self.org.acme.pk), str(self.org.globex_plant.pk))


class RequestScopeTests(TestCase):
    def test_request_scope_reads_the_query_string(self):
        from types import SimpleNamespace

        from django.http import QueryDict

        from apps.console.http import request_scope

        org = Org()
        request = SimpleNamespace(
            visibility=Visibility.for_user(make_user(customers=[org.acme])),
            GET=QueryDict(f"customer={org.acme.pk}&site={org.acme_hq.pk}"),
        )
        self.assertEqual(request_scope(request), Scope(org.acme.pk, org.acme_hq.pk))
        request.GET = QueryDict("")
        self.assertEqual(request_scope(request), Scope())
        request.GET = QueryDict("customer=")
        with self.assertRaises(NotVisible):
            request_scope(request)


class GetTests(TestCase):
    def setUp(self):
        self.org = Org()

    def test_a_visible_row_is_returned(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        self.assertEqual(visibility.get(Device.objects.all(), self.org.dev_hq.pk), self.org.dev_hq)

    def test_hidden_missing_and_malformed_keys_are_all_not_visible(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        for pk in (self.org.dev_plant.pk, self.org.dev_free.pk, uuid.uuid4(), "not-a-uuid", None, "", 5):
            with self.subTest(pk=pk), self.assertRaises(NotVisible):
                visibility.get(Device.objects.all(), pk)

    def test_nobody_gets_nothing(self):
        with self.assertRaises(NotVisible):
            Visibility.nobody().get(Device.objects.all(), self.org.dev_hq.pk)

    def test_misuse_is_an_error_not_a_silent_404_for_every_kind_of_user(self):
        users = {
            "restricted": make_user("r", customers=[self.org.acme]),
            "all access": make_user("a", all_customers=True),
            "no grants": make_user("n"),
        }
        for label, user in users.items():
            visibility = Visibility.for_user(user)
            with self.subTest(user=label):
                with self.assertRaises(ImproperlyConfigured):  # a sliced queryset: filter first, then slice
                    visibility.get(Device.objects.all()[:5], self.org.dev_hq.pk)
                with self.assertRaises(ImproperlyConfigured):
                    visibility.filter(Device.objects.all()[:5])
                combined = Device.objects.filter(name="x").union(Device.objects.filter(name="y"))
                with self.assertRaises(ImproperlyConfigured):
                    visibility.filter(combined)
                with self.assertRaises(ImproperlyConfigured):
                    visibility.get(Device.objects.all(), self.org.dev_hq.pk, site_path="nope")
        with self.assertRaises(ImproperlyConfigured):
            Visibility.nobody().filter(Device.objects.all()[:1])

    def test_keys_that_cannot_belong_to_an_integer_pk_model_are_not_found(self):
        device = Device.objects.get(pk=self.org.dev_hq.pk)
        iface = Interface.objects.create(device=device, if_index=1, name="gi1", admin_status=1, oper_status=1)
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        self.assertEqual(visibility.get(Interface.objects.all(), iface.pk, site_path="device__site"), iface)
        self.assertEqual(visibility.get(Interface.objects.all(), str(iface.pk), site_path="device__site"), iface)
        for bad in ("1e3", "abc", "", None, 10**30, -1, 0, [1], {"a": 1}, b"x", "1; DROP TABLE"):
            with self.subTest(pk=bad), self.assertRaises(NotVisible):
                visibility.get(Interface.objects.all(), bad, site_path="device__site")

    def test_a_server_side_type_error_is_not_swallowed_as_a_404(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        with patch("django.db.models.query.QuerySet.get", side_effect=TypeError("a bug in the query code")):
            with self.assertRaises(TypeError):
                visibility.get(Device.objects.all(), self.org.dev_hq.pk)



class RestrictionStrategyTests(TestCase):
    """How the visible sites reach the data query (see the Visibility docstring)."""

    def setUp(self):
        self.org = Org()

    def sql(self, user, **kwargs):
        return str(Visibility.for_user(user).filter(Device.objects.all(), **kwargs).query).lower()

    def test_a_restricted_filter_is_a_literal_list_on_the_data_tables_own_column(self):
        sql = self.sql(make_user(customers=[self.org.acme]))
        self.assertIn('"inventory_device"."site_id" in (', sql)
        self.assertNotIn("select", sql.split(" where ", 1)[1])  # no subquery
        self.assertNotIn(" join ", sql)

    def test_many_visible_sites_fall_back_to_a_subquery(self):
        user = make_user(customers=[self.org.acme])
        with patch("apps.console.access.MAX_LITERAL_SITES", 1):
            visibility = Visibility.for_user(user)
            rows = visibility.filter(Device.objects.all())
            self.assertEqual(names(rows), ["acme-dc-sw", "acme-hq-sw"])
            self.assertIn("select", str(rows.query).lower().split(" where ", 1)[1])

    def test_a_user_who_sees_no_site_never_touches_the_data_table(self):
        visibility = Visibility.for_user(make_user())  # console user, no grants
        with CaptureQueriesContext(connection) as captured:
            self.assertEqual(list(visibility.filter(Device.objects.all())), [])
            self.assertEqual(visibility.filter(Device.objects.all()).count(), 0)
        self.assertFalse([q for q in captured if "inventory_device" in q["sql"]])
        self.assertEqual(len(captured), 1)  # the one lookup of visible sites, cached for the second call

    def test_the_lookup_is_cached_per_scope_within_a_request(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        with CaptureQueriesContext(connection) as captured:
            for _ in range(3):
                list(visibility.filter(Device.objects.all()))
        site_lookups = [q for q in captured if "inventory_site" in q["sql"]]
        self.assertEqual(len(site_lookups), 1)
        self.assertEqual(len(captured), 4)  # 1 lookup + 3 data queries

    def test_all_access_without_a_scope_adds_no_condition_and_no_lookup(self):
        visibility = Visibility.for_user(make_user("ops", all_customers=True))
        with CaptureQueriesContext(connection) as captured:
            rows = visibility.filter(Device.objects.all())
            self.assertNotIn("where", str(rows.query).lower())
        self.assertEqual(len(captured), 0)

    def test_a_scope_is_intersected_with_the_grants_even_if_built_by_hand(self):
        visibility = Visibility.for_user(make_user(customers=[self.org.acme]))
        forged = Scope(customer_id=self.org.globex.pk, site_id=self.org.globex_plant.pk)
        self.assertEqual(list(visibility.filter(Device.objects.all(), scope=forged)), [])

    def test_the_site_index_is_used_for_a_user_with_one_site(self):
        """On a table with many sites, the data query is an index scan, not a scan of the table."""
        customers = [Customer(name=f"Bulk {i}") for i in range(30)]
        Customer.objects.bulk_create(customers)
        sites = [Site(customer=c, name=f"S{j}") for c in customers for j in range(40)]
        Site.objects.bulk_create(sites)
        Device.objects.bulk_create(
            [Device(name=f"d-{n}", management_address="192.0.2.1", site=site) for n, site in enumerate(sites * 20)]
        )
        with connection.cursor() as cursor:
            cursor.execute("ANALYZE inventory_device; ANALYZE inventory_site")
        user = make_user(sites=[sites[17]])
        queryset = Visibility.for_user(user).filter(Device.objects.order_by("name", "pk"))
        sql, params = queryset.query.sql_with_params()
        with connection.cursor() as cursor:
            cursor.execute("EXPLAIN " + sql, params)
            plan = "\n".join(row[0] for row in cursor.fetchall())
        self.assertNotIn("Seq Scan on inventory_device", plan, plan)
        self.assertEqual(queryset.count(), 20)


class RestrictionCacheAndBoundaryTests(TestCase):
    def setUp(self):
        self.org = Org()
        self.user = make_user(customers=[self.org.acme], sites=[self.org.globex_plant])

    def lookups(self, captured):
        return [q for q in captured if "inventory_site" in q["sql"] and "inventory_device" not in q["sql"]]

    def test_each_scope_has_its_own_cache_entry_and_the_right_rows(self):
        visibility = Visibility.for_user(self.user)
        hq = Scope(site_id=self.org.acme_hq.pk)
        plant = Scope(site_id=self.org.globex_plant.pk)
        with CaptureQueriesContext(connection) as captured:
            self.assertEqual(names(visibility.filter(Device.objects.all(), scope=hq)), ["acme-hq-sw"])
            self.assertEqual(names(visibility.filter(Device.objects.all(), scope=plant)), ["globex-plant-sw"])
            self.assertEqual(names(visibility.filter(Device.objects.all())), ["acme-dc-sw", "acme-hq-sw", "globex-plant-sw"])
            self.assertEqual(names(visibility.filter(Device.objects.all(), scope=hq)), ["acme-hq-sw"])  # cached
        self.assertEqual(len(self.lookups(captured)), 3)  # hq, plant, unscoped: one lookup each

    def test_customer_and_site_scopes_are_intersected(self):
        visibility = Visibility.for_user(self.user)
        both = Scope(customer_id=self.org.acme.pk, site_id=self.org.acme_dc.pk)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=both)), ["acme-dc-sw"])
        mismatched = Scope(customer_id=self.org.globex.pk, site_id=self.org.acme_dc.pk)
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=mismatched)), [])

    def test_the_list_is_used_up_to_the_limit_and_a_subquery_beyond_it(self):
        visibility = Visibility.for_user(self.user)  # sees 3 sites
        for limit, expected in ((3, "ids"), (2, "subquery"), (4, "ids"), (0, "subquery")):
            with self.subTest(limit=limit), patch("apps.console.access.MAX_LITERAL_SITES", limit):
                fresh = Visibility.for_user(self.user)
                kind, _value = fresh._restriction(None)
                self.assertEqual(kind, expected)
                self.assertEqual(
                    names(fresh.filter(Device.objects.all())), ["acme-dc-sw", "acme-hq-sw", "globex-plant-sw"]
                )

    def test_the_subquery_fallback_honours_a_scope(self):
        with patch("apps.console.access.MAX_LITERAL_SITES", 1):
            visibility = Visibility.for_user(self.user)
            scope = visibility.resolve_scope(self.org.acme.pk, None)
            kind, _ = visibility._restriction(scope)
            self.assertEqual(kind, "subquery")
            self.assertEqual(names(visibility.filter(Device.objects.all(), scope=scope)), ["acme-dc-sw", "acme-hq-sw"])
            narrow = visibility.resolve_scope(None, self.org.acme_hq.pk)
            self.assertEqual(visibility._restriction(narrow)[0], "ids")  # a narrow scope fits the list again

    def test_a_granted_customer_without_sites_resolves_but_shows_no_rows(self):
        user = make_user("lonely", customers=[self.org.empty])
        visibility = Visibility.for_user(user)
        scope = visibility.resolve_scope(self.org.empty.pk, None)
        self.assertEqual(scope.customer_id, self.org.empty.pk)
        self.assertEqual(list(visibility.filter(Device.objects.all(), scope=scope)), [])

    def test_a_forged_scope_with_string_ids_cannot_widen_anything(self):
        visibility = Visibility.for_user(self.user)
        forged = Scope(customer_id=str(self.org.globex.pk), site_id=None)  # a hand-built, unparsed scope
        self.assertEqual(names(visibility.filter(Device.objects.all(), scope=forged)), ["globex-plant-sw"])


class SitePathThroughOneToOneTests(TestCase):
    def test_a_forward_one_to_one_is_accepted_and_the_reverse_one_is_not(self):
        from apps.snmp.models import DeviceSnmpState

        org = Org()
        DeviceSnmpState.objects.create(device=org.dev_hq)
        DeviceSnmpState.objects.create(device=org.dev_plant)
        visibility = Visibility.for_user(make_user(customers=[org.acme]))
        rows = visibility.filter(DeviceSnmpState.objects.all(), site_path="device__site")  # forward one-to-one
        self.assertEqual([r.device_id for r in rows], [org.dev_hq.pk])
        with self.assertRaises(ImproperlyConfigured):
            visibility.filter(Device.objects.all(), site_path="snmp_state")  # reverse one-to-one, not a site
        with self.assertRaises(ImproperlyConfigured):
            visibility.filter(Device.objects.all(), site_path="snmp_state__device__site")

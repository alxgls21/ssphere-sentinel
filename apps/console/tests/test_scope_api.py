"""The scope picker endpoint: authorization and the response contract."""

import uuid

from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from apps.console.tests.helpers import load_contract, make_user, signed_in_client
from apps.console.tests.test_session_api import matches
from apps.inventory.models import Customer, Site

SCOPE = "/api/v1/console/scope/"


def fixed(suffix: str) -> uuid.UUID:
    return uuid.UUID(f"00000000-0000-0000-0000-{suffix:0>12}")


class ScopeEndpointTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(id=fixed("c001"), name="Acme")
        self.globex = Customer.objects.create(id=fixed("c002"), name="Globex")
        self.secret = Customer.objects.create(id=fixed("c003"), name="Hidden Industries")
        self.dc = Site.objects.create(id=fixed("a001"), customer=self.acme, name="DC")
        self.hq = Site.objects.create(id=fixed("a002"), customer=self.acme, name="HQ")
        self.plant = Site.objects.create(id=fixed("a003"), customer=self.globex, name="Plant")
        self.bunker = Site.objects.create(id=fixed("a004"), customer=self.secret, name="Bunker")

    def get(self, user):
        return signed_in_client(user).get(SCOPE)

    def test_anonymous_gets_401_json(self):
        response = Client().get(SCOPE)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"error": {"code": "unauthenticated", "message": "Sign in to continue."}})

    def test_a_user_without_console_access_gets_403(self):
        user = make_user("admin-only", console=False, all_customers=True, customers=[self.acme])
        self.assertEqual(self.get(user).status_code, 403)

    def test_the_contract_for_a_restricted_user(self):
        user = make_user(customers=[self.acme], sites=[self.plant])
        response = self.get(user)
        self.assertEqual(response.status_code, 200)
        matches(response.json(), load_contract("scope.json"))

    def test_restricted_users_never_receive_other_customers(self):
        user = make_user(customers=[self.acme], sites=[self.plant])
        text = self.get(user).content.decode()
        for hidden in ("Hidden Industries", "Bunker", str(self.secret.pk), str(self.bunker.pk)):
            self.assertNotIn(hidden, text)

    def test_a_site_grant_exposes_the_customer_name_but_not_its_other_sites(self):
        body = self.get(make_user(sites=[self.hq])).json()
        self.assertEqual(body["customers"], [{"id": str(self.acme.pk), "name": "Acme"}])
        self.assertEqual([s["name"] for s in body["sites"]], ["HQ"])

    def test_all_customers_users_see_everything_including_customers_without_sites(self):
        Customer.objects.create(name="Zeta Without Sites")
        body = self.get(make_user("ops", all_customers=True)).json()
        self.assertEqual([c["name"] for c in body["customers"]], ["Acme", "Globex", "Hidden Industries", "Zeta Without Sites"])
        self.assertEqual(len(body["sites"]), 4)

    def test_a_console_user_without_grants_gets_an_empty_scope(self):
        self.assertEqual(self.get(make_user()).json(), {"customers": [], "sites": []})

    def test_order_is_by_name_and_stable(self):
        body = self.get(make_user("ops", all_customers=True)).json()
        self.assertEqual([s["name"] for s in body["sites"]], ["DC", "HQ", "Plant", "Bunker"])

    def test_the_query_count_is_constant(self):
        user = make_user("ops", all_customers=True)
        client = signed_in_client(user)
        client.get(SCOPE)  # warm up (session, permissions)
        with CaptureQueriesContext(connection) as small:
            client.get(SCOPE)
        for i in range(40):
            customer = Customer.objects.create(name=f"Bulk {i}")
            Site.objects.create(customer=customer, name="S")
        with CaptureQueriesContext(connection) as large:
            client.get(SCOPE)
        self.assertEqual(len(small), len(large))
        self.assertLessEqual(len(large), 8)

    def test_only_get_is_allowed(self):
        client = signed_in_client(make_user("ops", all_customers=True), enforce_csrf=True)
        token = client.get("/api/v1/console/session/").json()["csrfToken"]
        for method in ("post", "put", "patch", "delete"):
            response = getattr(client, method)(SCOPE, HTTP_X_CSRFTOKEN=token)  # a valid token: still not writable
            self.assertEqual(response.status_code, 405, method)
            self.assertEqual(response["Allow"], "GET, HEAD")
        self.assertEqual(client.head(SCOPE).status_code, 200)

    def test_no_cache_headers(self):
        response = self.get(make_user("ops", all_customers=True))
        self.assertIn("no-store", response["Cache-Control"])
        self.assertIn("Cookie", response["Vary"])


class ScopeOrderTests(TestCase):
    def test_order_is_case_insensitive_and_independent_of_the_database_collation(self):
        for name in ("beta", "Alpha", "alpha-two", "Zed", "ÉCOLE", "école-b", "Äpfel"):
            customer = Customer.objects.create(name=name)
            Site.objects.create(customer=customer, name="b-site")
            Site.objects.create(customer=customer, name="A-site")
        body = signed_in_client(make_user("ops", all_customers=True)).get(SCOPE).json()
        names = [c["name"] for c in body["customers"]]
        self.assertEqual(names, sorted(names, key=lambda n: (n.casefold(), n)))
        self.assertEqual(names[:3], ["Alpha", "alpha-two", "beta"])
        site_labels = [(s["customerId"], s["name"]) for s in body["sites"]]
        by_customer = {c["id"]: c["name"] for c in body["customers"]}
        expected = sorted(site_labels, key=lambda p: (by_customer[p[0]].casefold(), by_customer[p[0]], p[1].casefold(), p[1]))
        self.assertEqual(site_labels, expected)
        # within a customer: "A-site" before "b-site" although 'A' < 'b' in ASCII either way; case does not decide
        first = [n for cid, n in site_labels if cid == body["customers"][0]["id"]]
        self.assertEqual(first, ["A-site", "b-site"])

    def test_sites_of_one_customer_sort_case_insensitively(self):
        customer = Customer.objects.create(name="Mixed")
        for name in ("b-lower", "A-upper", "B-upper", "a-lower"):
            Site.objects.create(customer=customer, name=name)
        body = signed_in_client(make_user("ops", all_customers=True)).get(SCOPE).json()
        self.assertEqual([s["name"] for s in body["sites"]], ["a-lower", "A-upper", "b-lower", "B-upper"])
        # (a case-sensitive sort would give A-upper, B-upper, a-lower, b-lower)

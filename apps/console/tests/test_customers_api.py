"""Customers and sites from the console (``apps.console.customers``): reading by the grants, writing by
the editor gate and the admin's permissions, refusal to delete what is still in use, the audit trail."""

from __future__ import annotations

import json

from django.test import Client, TestCase
from django.utils import timezone

from apps.alerts.tests.helpers import make_rule, open_incident
from apps.console.models import AuditEntry, CustomerAccess, SiteAccess
from apps.console.tests.helpers import API, grant, make_admin, make_editor, make_server, make_user, send, signed_in_client
from apps.infrastructure.models import Server
from apps.inventory.models import Customer, Device, Site
from apps.network.models import NetworkTarget
from apps.web.domains import new_token
from apps.web.models import MonitoredDomain

CUSTOMERS = API + "customers/"
SITES = API + "sites/"
CUSTOMER_KEYS = {"id", "name", "notes", "sites", "servers", "devices", "targets", "domains", "createdAt", "updatedAt"}
SITE_KEYS = {"id", "customerId", "customerName", "name", "description", "servers", "devices", "targets", "createdAt", "updatedAt"}


class CustomerTestCase(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme", notes="first")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.editor = make_editor()
        self.client_ = signed_in_client(self.editor)

    def audit(self, action):
        return list(AuditEntry.objects.filter(action=action).order_by("pk"))


class PermissionTests(CustomerTestCase):
    def writes(self, client: Client):
        return (
            send(client, "post", CUSTOMERS, {"name": "Initech"}),
            send(client, "patch", f"{CUSTOMERS}{self.acme.pk}/", {"name": "Acme Inc"}),
            send(client, "delete", f"{CUSTOMERS}{self.globex.pk}/"),
            send(client, "post", SITES, {"customerId": str(self.acme.pk), "name": "DC"}),
            send(client, "patch", f"{SITES}{self.hq.pk}/", {"name": "HQ 2"}),
            send(client, "delete", f"{SITES}{self.hq.pk}/"),
        )

    def assert_refused(self, client, status):
        for response in self.writes(client):
            self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(Customer.objects.count(), 2)
        self.assertEqual(Site.objects.count(), 2)
        self.assertEqual(Customer.objects.get(pk=self.acme.pk).name, "Acme")
        self.assertFalse(AuditEntry.objects.exists())

    def test_anonymous_requests_are_refused(self):
        self.assert_refused(Client(), 401)
        self.assertEqual(Client().get(CUSTOMERS).status_code, 401)

    def test_a_reader_may_read_but_not_write(self):
        viewer = signed_in_client(make_user("viewer", all_customers=True))
        self.assertEqual(viewer.get(CUSTOMERS).status_code, 200)
        self.assertEqual(viewer.get(f"{CUSTOMERS}{self.acme.pk}/").status_code, 200)
        self.assertEqual(viewer.get(SITES).status_code, 200)
        self.assert_refused(viewer, 403)
        self.assertEqual(viewer.get(API + "session/").json()["capabilities"]["manageCustomers"], False)

    def test_the_admins_permissions_without_global_visibility_are_not_enough(self):
        # A restricted account cannot even see the other customer: it has nothing to administer.
        restricted = grant(make_user("restricted", customers=[self.acme]), "alerts.change_alertrule",
                           *("inventory.add_customer", "inventory.change_customer", "inventory.delete_customer",
                             "inventory.add_site", "inventory.change_site", "inventory.delete_site"))
        self.assert_refused(signed_in_client(restricted), 403)

    def test_each_write_needs_the_permission_the_admin_asks_for_it(self):
        base = ("alerts.change_alertrule",)
        for codename, expected in (
            ("inventory.add_customer", (201, 403, 403, 403, 403, 403)),
            ("inventory.change_customer", (403, 200, 403, 403, 403, 403)),
            ("inventory.delete_customer", (403, 403, 409, 403, 403, 403)),  # Globex still has its site; refused for that, not for who asks
            ("inventory.add_site", (403, 403, 403, 201, 403, 403)),
            ("inventory.change_site", (403, 403, 403, 403, 200, 403)),
            ("inventory.delete_site", (403, 403, 403, 403, 403, 409)),  # HQ is in use below; refused for that, not for who asks
        ):
            with self.subTest(permission=codename):
                Server.objects.filter(site=self.hq).exists() or Server.objects.create(name=f"s-{codename}", hostname="h", site=self.hq)
                client = signed_in_client(grant(make_user(codename, all_customers=True), *base, codename))
                self.assertEqual(tuple(r.status_code for r in self.writes(client)), expected)
                self.assertFalse(client.get(API + "session/").json()["capabilities"]["manageCustomers"])
                # Put things back for the next account.
                Customer.objects.filter(name="Initech").delete()
                Customer.objects.filter(pk=self.acme.pk).update(name="Acme")
                Site.objects.filter(name="DC").delete()
                Site.objects.filter(pk=self.hq.pk).update(name="HQ")
                if not Customer.objects.filter(pk=self.globex.pk).exists():
                    self.globex = Customer.objects.create(name="Globex")
        self.assertTrue(self.client_.get(API + "session/").json()["capabilities"]["manageCustomers"])
        self.assertTrue(signed_in_client(make_admin()).get(API + "session/").json()["capabilities"]["manageCustomers"])

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.editor, enforce_csrf=True)
        for response in self.writes(client):
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        token = client.get(API + "session/").json()["csrfToken"]
        self.assertEqual(send(client, "post", CUSTOMERS, {"name": "Initech"}, HTTP_X_CSRFTOKEN=token).status_code, 201)

    def test_only_the_documented_methods(self):
        self.assertEqual(self.client_.put(CUSTOMERS, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.post(f"{CUSTOMERS}{self.acme.pk}/", "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.put(f"{SITES}{self.hq.pk}/", "{}", content_type="application/json").status_code, 405)


class ReadTests(CustomerTestCase):
    def test_a_restricted_account_sees_its_customers_and_sites_only_and_the_rest_is_not_found(self):
        client = signed_in_client(make_user("acme-only", customers=[self.acme]))
        body = client.get(CUSTOMERS).json()
        self.assertEqual(set(body), {"generatedAt", "items", "page", "scopeTotal"})
        self.assertEqual([item["name"] for item in body["items"]], ["Acme"])
        self.assertEqual(set(body["items"][0]), CUSTOMER_KEYS)
        self.assertEqual(client.get(f"{CUSTOMERS}{self.acme.pk}/").status_code, 200)
        self.assertEqual(client.get(f"{CUSTOMERS}{self.globex.pk}/").status_code, 404)
        self.assertEqual([item["name"] for item in client.get(SITES).json()["items"]], ["HQ"])
        self.assertEqual(client.get(f"{SITES}{self.plant.pk}/").status_code, 404)
        self.assertEqual(client.get(SITES, {"customer": str(self.globex.pk)}).status_code, 404)
        # A site-only grant shows the customer (its name labels the site) and that site alone.
        site_only = signed_in_client(make_user("plant-only", sites=[self.plant]))
        self.assertEqual([item["name"] for item in site_only.get(CUSTOMERS).json()["items"]], ["Globex"])
        self.assertEqual(site_only.get(f"{CUSTOMERS}{self.globex.pk}/").json()["sites"][0]["name"], "Plant")

    def test_the_detail_counts_what_belongs_to_the_customer(self):
        now = timezone.now()
        make_server("web", site=self.hq, now=now)
        Device.objects.create(name="sw", management_address="192.0.2.1", site=self.hq)
        NetworkTarget.objects.create(name="gw", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.hq)
        MonitoredDomain.objects.create(customer=self.acme, name="acme.example", display_name="acme.example", token=new_token(),
                                       token_created_at=now, created_by_name="x", created_at=now, updated_at=now)
        body = self.client_.get(f"{CUSTOMERS}{self.acme.pk}/").json()
        self.assertEqual(set(body), {"generatedAt", "item", "sites"})
        item = body["item"]
        self.assertEqual((item["name"], item["notes"], item["sites"], item["servers"], item["devices"], item["targets"], item["domains"]), ("Acme", "first", 1, 1, 1, 1, 1))
        [site] = body["sites"]
        self.assertEqual(set(site), SITE_KEYS)
        self.assertEqual((site["name"], site["customerName"], site["servers"], site["devices"], site["targets"]), ("HQ", "Acme", 1, 1, 1))
        globex = self.client_.get(f"{CUSTOMERS}{self.globex.pk}/").json()["item"]
        self.assertEqual((globex["sites"], globex["servers"], globex["domains"]), (1, 0, 0))

    def test_lists_are_searched_sorted_and_paged(self):
        for name in ("Initech", "Umbrella"):
            Customer.objects.create(name=name)
        self.assertEqual([c["name"] for c in self.client_.get(CUSTOMERS).json()["items"]], ["Acme", "Globex", "Initech", "Umbrella"])
        self.assertEqual([c["name"] for c in self.client_.get(CUSTOMERS, {"sort": "name", "dir": "desc"}).json()["items"]], ["Umbrella", "Initech", "Globex", "Acme"])
        body = self.client_.get(CUSTOMERS, {"q": "first"}).json()  # the notes are searched
        self.assertEqual(([c["name"] for c in body["items"]], body["page"]["total"], body["scopeTotal"]), (["Acme"], 1, 4))
        body = self.client_.get(CUSTOMERS, {"pageSize": "1", "page": "2"}).json()
        self.assertEqual(([c["name"] for c in body["items"]], body["page"]["pages"]), (["Globex"], 4))
        self.assertEqual([s["name"] for s in self.client_.get(SITES, {"customer": str(self.acme.pk)}).json()["items"]], ["HQ"])
        for params in ({"sort": "size"}, {"dir": "up"}, {"page": "0"}, {"customer": "x"}, {"x": "1"}):
            with self.subTest(params=params):
                self.assertEqual(self.client_.get(SITES, params).status_code, 400)


class WriteTests(CustomerTestCase):
    def test_a_customer_is_created_changed_and_deleted_with_an_audit_entry_each(self):
        with self.assertLogs("apps.console", level="INFO") as logs:
            response = send(self.client_, "post", CUSTOMERS, {"name": "  Initech ", "notes": "line one\nline two"})
        self.assertEqual(response.status_code, 201, response.content)
        customer = Customer.objects.get(name="Initech")
        self.assertEqual(response["Location"], f"{CUSTOMERS}{customer.pk}/")
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertEqual((body["item"]["name"], body["item"]["notes"], body["sites"]), ("Initech", "line one\nline two", []))
        [created] = self.audit("customer_created")
        self.assertEqual((created.actor, created.actor_name, created.target_type, created.target_id, created.target_name), (self.editor, "editor", "customer", str(customer.pk), "Initech"))
        self.assertEqual(created.changes, {"name": {"before": None, "after": "Initech"}, "notes": {"before": None, "after": "line one\nline two"}})
        self.assertIn(f"Customer created (customer={customer.pk}, user_id={self.editor.pk})", "\n".join(logs.output))

        response = send(self.client_, "patch", f"{CUSTOMERS}{customer.pk}/", {"notes": "changed"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["item"]["notes"], "changed")
        [changed] = self.audit("customer_changed")
        self.assertEqual(changed.changes, {"notes": {"before": "line one\nline two", "after": "changed"}})
        # Nothing to change: nothing recorded.
        self.assertEqual(send(self.client_, "patch", f"{CUSTOMERS}{customer.pk}/", {"name": "Initech"}).status_code, 200)
        self.assertEqual(len(self.audit("customer_changed")), 1)

        response = send(self.client_, "delete", f"{CUSTOMERS}{customer.pk}/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["deleted"], {"id": str(customer.pk), "name": "Initech"})
        self.assertFalse(Customer.objects.filter(pk=customer.pk).exists())
        [deleted] = self.audit("customer_deleted")
        self.assertEqual(deleted.changes["name"], {"before": "Initech", "after": None})
        self.assertEqual(self.client_.get(f"{CUSTOMERS}{customer.pk}/").status_code, 404)

    def test_a_name_is_taken_whatever_its_case(self):
        response = send(self.client_, "post", CUSTOMERS, {"name": "ACME"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "customer_exists"))
        response = send(self.client_, "patch", f"{CUSTOMERS}{self.globex.pk}/", {"name": "acme"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "customer_exists"))
        self.assertEqual(Customer.objects.get(pk=self.globex.pk).name, "Globex")
        response = send(self.client_, "post", SITES, {"customerId": str(self.acme.pk), "name": "hq"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "site_exists"))
        # The same name under another customer is fine.
        self.assertEqual(send(self.client_, "post", SITES, {"customerId": str(self.globex.pk), "name": "HQ"}).status_code, 201)
        self.assertFalse(AuditEntry.objects.filter(action__in=["customer_created", "customer_changed"]).exists())

    def test_the_body_is_checked_field_by_field(self):
        cases = [
            (CUSTOMERS, {}, "name", "Required."),
            (CUSTOMERS, {"name": "  "}, "name", "Required."),
            (CUSTOMERS, {"name": 1}, "name", "Expected text."),
            (CUSTOMERS, {"name": "a" * 256}, "name", "At most 255 characters."),
            (CUSTOMERS, {"name": "bad\x1b[0m"}, "name", "Control characters are not allowed."),
            (CUSTOMERS, {"name": "x", "notes": "n" * 2001}, "notes", "At most 2000 characters."),
            (CUSTOMERS, {"name": "x", "notes": "bell\x07"}, "notes", "Control characters are not allowed."),
            (CUSTOMERS, {"name": "x", "id": "mine"}, "id", "Unknown field."),
            (SITES, {"name": "x"}, "customerId", "Required."),
            (SITES, {"name": "x", "customerId": "not-an-id"}, "customerId", "Expected the id of a customer."),
            (SITES, {"name": "x", "customerId": "00000000-0000-0000-0000-000000000000"}, "customerId", "No such customer."),
            (SITES, {"customerId": str(self.acme.pk)}, "name", "Required."),
            (SITES, {"customerId": str(self.acme.pk), "name": "x", "description": 3}, "description", "Expected text."),
        ]
        for path, body, field, message in cases:
            with self.subTest(body=body):
                response = send(self.client_, "post", path, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["fields"][field], [message])
        self.assertEqual(Customer.objects.count(), 2)
        self.assertEqual(Site.objects.count(), 2)
        self.assertEqual(send(self.client_, "post", CUSTOMERS, {"name": "x", "notes": "n" * 16 * 1024}).status_code, 413)
        self.assertEqual(self.client_.post(CUSTOMERS, "name=x", content_type="text/plain").status_code, 415)
        self.assertEqual(self.client_.post(CUSTOMERS + "?x=1", json.dumps({"name": "x"}), content_type="application/json").status_code, 400)

    def test_a_customer_in_use_is_not_deleted_and_the_message_counts_what_it_holds(self):
        now = timezone.now()
        MonitoredDomain.objects.create(customer=self.acme, name="acme.example", display_name="acme.example", token=new_token(),
                                       token_created_at=now, created_by_name="x", created_at=now, updated_at=now)
        make_rule(name="Acme rule", customer=self.acme)
        response = send(self.client_, "delete", f"{CUSTOMERS}{self.acme.pk}/")
        self.assertEqual(response.status_code, 409, response.content)
        error = response.json()["error"]
        self.assertEqual(error["code"], "customer_in_use")
        self.assertEqual(error["message"], "The customer “Acme” still has 1 site, 1 monitored domain, 1 alert rule: move or delete them first. Nothing is deleted along with it.")
        self.assertTrue(Customer.objects.filter(pk=self.acme.pk).exists())
        self.assertTrue(Site.objects.filter(pk=self.hq.pk).exists())
        self.assertFalse(AuditEntry.objects.filter(action="customer_deleted").exists())

    def test_a_site_in_use_is_not_deleted_and_an_empty_one_goes_with_its_grants(self):
        now = timezone.now()
        make_server("web", site=self.hq, now=now)
        Device.objects.create(name="sw", management_address="192.0.2.1", site=self.hq)
        NetworkTarget.objects.create(name="gw", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.hq)
        rule = make_rule(name="Site rule", site=self.hq)
        open_incident(rule, site=self.hq)
        response = send(self.client_, "delete", f"{SITES}{self.hq.pk}/")
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(response.json()["error"]["code"], "site_in_use")
        self.assertIn("1 server, 1 device, 1 network target, 1 alert rule, 1 incident", response.json()["error"]["message"])
        self.assertTrue(Site.objects.filter(pk=self.hq.pk).exists())

        viewer = make_user("plant-viewer", sites=[self.plant])
        grantee = make_user("globex-viewer", customers=[self.globex])
        response = send(self.client_, "delete", f"{SITES}{self.plant.pk}/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(Site.objects.filter(pk=self.plant.pk).exists())
        self.assertFalse(SiteAccess.objects.filter(user=viewer).exists())  # the grant went with the site
        [deleted] = self.audit("site_deleted")
        self.assertEqual((deleted.target_name, deleted.changes["customerId"]["before"]), ("Plant", str(self.globex.pk)))
        # Now the customer is empty: it goes too, with the grant to it.
        self.assertEqual(send(self.client_, "delete", f"{CUSTOMERS}{self.globex.pk}/").status_code, 200)
        self.assertFalse(CustomerAccess.objects.filter(user=grantee).exists())

    def test_a_site_is_created_changed_and_moved_to_another_customer(self):
        response = send(self.client_, "post", SITES, {"customerId": str(self.acme.pk), "name": "DC", "description": "second"})
        self.assertEqual(response.status_code, 201, response.content)
        site = Site.objects.get(name="DC")
        self.assertEqual(response["Location"], f"{SITES}{site.pk}/")
        item = response.json()["item"]
        self.assertEqual((item["customerId"], item["customerName"], item["description"]), (str(self.acme.pk), "Acme", "second"))
        [created] = self.audit("site_created")
        self.assertEqual(created.changes["customerId"], {"before": None, "after": str(self.acme.pk)})

        response = send(self.client_, "patch", f"{SITES}{site.pk}/", {"customerId": str(self.globex.pk), "name": "Plant 2"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["item"]["customerName"], response.json()["item"]["name"]), ("Globex", "Plant 2"))
        [changed] = self.audit("site_changed")
        self.assertEqual(changed.changes, {
            "customerId": {"before": str(self.acme.pk), "after": str(self.globex.pk)},
            "name": {"before": "DC", "after": "Plant 2"},
        })
        # Moving it under a name the customer already uses is refused.
        response = send(self.client_, "patch", f"{SITES}{site.pk}/", {"name": "Plant"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "site_exists"))
        self.assertEqual(send(self.client_, "patch", f"{SITES}{site.pk}/", {"customerId": None}).status_code, 400)

    def test_an_administrator_may_do_all_of_it(self):
        client = signed_in_client(make_admin())
        self.assertEqual(send(client, "post", CUSTOMERS, {"name": "Initech"}).status_code, 201)
        self.assertEqual(send(client, "delete", f"{SITES}{self.plant.pk}/").status_code, 200)

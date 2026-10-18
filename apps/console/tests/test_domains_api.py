"""Monitored domains in the console: add, list, read, ask for a verification and follow it."""

import json
import threading
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.db import connection
from django.test import Client, TestCase, TransactionTestCase
from django.utils import timezone

from apps.alerts.models import ConfigurationEvent
from apps.console.tests.helpers import API, make_user, signed_in_client
from apps.inventory.models import Customer, Site
from apps.web import dns_verification as dv
from apps.web.management.commands.run_domain_verifier import Verifier
from apps.web.models import DomainVerification, MonitoredDomain

DOMAINS = API + "domains/"
ALL = ("web.view_monitoreddomain", "web.add_monitoreddomain", "web.verify_monitoreddomain")


def grant(user, *codenames: str):
    for codename in codenames:
        app, _, name = codename.partition(".")
        user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=name))
    return type(user).objects.get(pk=user.pk)


def domain_admin(username="admin", *codenames):
    return grant(make_user(username, all_customers=True), *(codenames or ALL))


def post(client: Client, path: str, body=None, **extra):
    if body is None:
        return client.post(path, **extra)
    return client.post(path, json.dumps(body), content_type="application/json", **extra)


def add(client, customer, name="example.com"):
    return post(client, DOMAINS, {"customerId": str(customer.pk), "name": name})


def found(domain, values):
    return dv.Result(dv.VERIFIED, dv.FOUND, {"zone": domain, "aliases": [], "nameserverCount": 2, "nameservers": [
        {"name": "ns1.dns.example", "address": "192.0.2.1", "result": "match"},
        {"name": "ns2.dns.example", "address": "192.0.2.2", "result": "match"},
    ]})


class PermissionTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.admin = domain_admin()
        self.domain_id = add(signed_in_client(self.admin), self.acme).json()["item"]["id"]

    def test_anonymous_requests_are_refused(self):
        client = Client()
        for response in (
            client.get(DOMAINS),
            client.get(f"{DOMAINS}{self.domain_id}/"),
            post(client, DOMAINS, {"customerId": str(self.acme.pk), "name": "x.example.com"}),
            post(client, f"{DOMAINS}{self.domain_id}/verify/"),
        ):
            self.assertIn(response.status_code, (401, 403))
        self.assertEqual(MonitoredDomain.objects.count(), 1)

    def test_every_endpoint_needs_global_visibility_whatever_the_permissions(self):
        # Granted the customer itself, and every domain permission: still not enough.
        user = grant(make_user("restricted", customers=[self.acme]), *ALL)
        client = signed_in_client(user)
        responses = [
            client.get(DOMAINS),
            client.get(f"{DOMAINS}{self.domain_id}/"),
            add(client, self.acme, "other.example.com"),
            post(client, f"{DOMAINS}{self.domain_id}/verify/"),
        ]
        verification = DomainVerification.objects.create(
            domain_id=self.domain_id, created_at=timezone.now(), expires_at=timezone.now() + timedelta(minutes=1)
        )
        responses.append(client.get(f"{DOMAINS}{self.domain_id}/verifications/{verification.pk}/"))
        for response in responses:
            self.assertEqual(response.status_code, 403, response.content)
            self.assertNotIn(MonitoredDomain.objects.get().token, response.content.decode())
        self.assertEqual(MonitoredDomain.objects.count(), 1)

    def test_each_action_needs_its_permission(self):
        viewer = signed_in_client(domain_admin("viewer", "web.view_monitoreddomain"))
        self.assertEqual(viewer.get(DOMAINS).status_code, 200)
        self.assertEqual(add(viewer, self.acme, "x.example.com").status_code, 403)
        self.assertEqual(post(viewer, f"{DOMAINS}{self.domain_id}/verify/").status_code, 403)
        adder = signed_in_client(domain_admin("adder", "web.add_monitoreddomain"))
        self.assertEqual(add(adder, self.acme, "x.example.com").status_code, 201)
        self.assertEqual(adder.get(DOMAINS).status_code, 200)  # who adds them sees them
        self.assertEqual(post(adder, f"{DOMAINS}{self.domain_id}/verify/").status_code, 403)
        verifier = signed_in_client(domain_admin("verifier", "web.verify_monitoreddomain"))
        self.assertEqual(post(verifier, f"{DOMAINS}{self.domain_id}/verify/").status_code, 202)
        self.assertEqual(add(verifier, self.acme, "y.example.com").status_code, 403)
        nobody = signed_in_client(make_user("plain", all_customers=True))
        self.assertEqual(nobody.get(DOMAINS).status_code, 403)

    def test_a_superuser_may_do_everything(self):
        client = signed_in_client(make_user("root", superuser=True))
        self.assertEqual(add(client, self.acme, "root.example.com").status_code, 201)
        self.assertEqual(post(client, f"{DOMAINS}{self.domain_id}/verify/").status_code, 202)

    def test_the_session_says_what_the_user_may_do(self):
        caps = signed_in_client(domain_admin("viewer2", "web.view_monitoreddomain")).get(API + "session/").json()["capabilities"]
        self.assertEqual((caps["viewDomains"], caps["addDomains"], caps["verifyDomains"]), (True, False, False))
        caps = signed_in_client(self.admin).get(API + "session/").json()["capabilities"]
        self.assertEqual((caps["viewDomains"], caps["addDomains"], caps["verifyDomains"]), (True, True, True))
        restricted = grant(make_user("restricted2", customers=[self.acme]), *ALL)
        caps = signed_in_client(restricted).get(API + "session/").json()["capabilities"]
        self.assertEqual((caps["viewDomains"], caps["addDomains"], caps["verifyDomains"]), (False, False, False))

    def test_writes_need_the_csrf_token(self):
        client = signed_in_client(self.admin, enforce_csrf=True)
        response = add(client, self.acme, "csrf.example.com")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        response = post(client, f"{DOMAINS}{self.domain_id}/verify/")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertFalse(DomainVerification.objects.exists())
        token = client.get(API + "session/").json()["csrfToken"]
        response = post(client, DOMAINS, {"customerId": str(self.acme.pk), "name": "csrf.example.com"}, HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(post(client, f"{DOMAINS}{self.domain_id}/verify/", HTTP_X_CSRFTOKEN=token).status_code, 202)


class CreateTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.admin = domain_admin()
        self.client_ = signed_in_client(self.admin)

    def test_a_domain_is_added_normalized_with_its_own_record(self):
        response = add(self.client_, self.acme, "  Bücher.DE. ")
        self.assertEqual(response.status_code, 201, response.content)
        item = response.json()["item"]
        domain = MonitoredDomain.objects.get()
        self.assertEqual(response["Location"], f"{DOMAINS}{domain.pk}/")
        self.assertEqual((item["name"], item["displayName"]), ("xn--bcher-kva.de", "bücher.de"))
        self.assertEqual(item["customer"], {"id": str(self.acme.pk), "name": "Acme"})
        self.assertEqual((item["status"], item["lastOutcome"], item["verifiedAt"]), ("pending", None, None))
        self.assertEqual((item["createdBy"], item["version"], item["latestVerification"]), ("admin", 1, None))
        self.assertEqual(item["record"], {
            "type": "TXT",
            "name": "_ssphere-sentinel.xn--bcher-kva.de",
            "value": f"ssphere-verification={domain.token}",
        })
        event = ConfigurationEvent.objects.get(action="domain_created")
        self.assertEqual((event.actor, event.actor_name, event.source, event.target_type), (self.admin, "admin", "console", "domain"))
        self.assertEqual(event.changes["name"], {"before": None, "after": "xn--bcher-kva.de"})
        self.assertEqual(event.changes["customerId"], {"before": None, "after": str(self.acme.pk)})
        self.assertNotIn(domain.token, json.dumps(event.changes))

    def test_a_domain_once_per_customer_in_any_spelling(self):
        self.assertEqual(add(self.client_, self.acme, "bücher.de").status_code, 201)
        for spelling in ("BÜCHER.DE", "xn--bcher-kva.de.", "Xn--Bcher-Kva.De"):
            with self.subTest(spelling=spelling):
                response = add(self.client_, self.acme, spelling)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "domain_exists"))
        self.assertEqual(MonitoredDomain.objects.count(), 1)

    def test_another_customer_may_have_the_same_domain_with_its_own_token(self):
        first = add(self.client_, self.acme, "shared.example.com").json()["item"]
        second = add(self.client_, self.globex, "shared.example.com").json()["item"]
        self.assertNotEqual(first["record"]["value"], second["record"]["value"])
        self.assertEqual(first["record"]["name"], second["record"]["name"])
        # Neither's detail gives the other's token.
        token = MonitoredDomain.objects.get(customer=self.globex).token
        self.assertNotIn(token, self.client_.get(f"{DOMAINS}{first['id']}/").content.decode())

    def test_invalid_names_are_field_errors(self):
        cases = {
            "192.0.2.1": "not an IP address",
            "co.uk": "public suffix",
            "github.io": "public suffix",
            "intranet": "full domain name",
            "printer.local": "special use",
            "example.notatld": "known public domain suffix",
            "-bad-.com": "not a valid domain name",
            "xn--zz.com": "not a valid domain name",
        }
        for name, words in cases.items():
            with self.subTest(name=name):
                response = add(self.client_, self.acme, name)
                self.assertEqual(response.status_code, 400)
                body = response.json()["error"]
                self.assertEqual(body["code"], "validation_error")
                self.assertIn(words, body["fields"]["name"][0])
        self.assertFalse(MonitoredDomain.objects.exists())

    def test_the_body_is_checked(self):
        cases = [
            ({"name": "example.com"}, "customerId"),
            ({"customerId": str(self.acme.pk)}, "name"),
            ({"customerId": "not-an-id", "name": "example.com"}, "customerId"),
            ({"customerId": "00000000-0000-0000-0000-000000000000", "name": "example.com"}, "customerId"),
            ({"customerId": "{" + str(self.acme.pk) + "}", "name": "example.com"}, "customerId"),
            ({"customerId": str(self.acme.pk), "name": 42}, "name"),
            ({"customerId": str(self.acme.pk), "name": "example.com", "token": "mine"}, "token"),
        ]
        for body, field in cases:
            with self.subTest(body=body):
                response = post(self.client_, DOMAINS, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(post(self.client_, DOMAINS, [1, 2]).status_code, 400)
        response = self.client_.post(DOMAINS, "name=example.com", content_type="application/x-www-form-urlencoded")
        self.assertEqual(response.status_code, 415)
        huge = {"customerId": str(self.acme.pk), "name": "a" * 5000}
        self.assertEqual(post(self.client_, DOMAINS, huge).status_code, 413)
        self.assertFalse(MonitoredDomain.objects.exists())

    def test_a_customer_has_a_limit(self):
        with patch("apps.console.domains.MAX_DOMAINS_PER_CUSTOMER", 2):
            for name in ("a.example.com", "b.example.com"):
                self.assertEqual(add(self.client_, self.acme, name).status_code, 201)
            response = add(self.client_, self.acme, "c.example.com")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "domain_limit"))
            self.assertEqual(add(self.client_, self.globex, "c.example.com").status_code, 201)


class ListTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.client_ = signed_in_client(domain_admin())
        for customer, name in ((self.acme, "beta.example.com"), (self.acme, "alpha.example.com"), (self.globex, "bücher.de")):
            add(self.client_, customer, name)
        MonitoredDomain.objects.filter(name="beta.example.com").update(status="verified", verified_at=timezone.now())

    def names(self, query=""):
        response = self.client_.get(DOMAINS + query)
        self.assertEqual(response.status_code, 200, response.content)
        return [item["name"] for item in response.json()["items"]]

    def test_the_list_its_counts_and_no_record(self):
        body = self.client_.get(DOMAINS).json()
        self.assertEqual([item["name"] for item in body["items"]], ["alpha.example.com", "beta.example.com", "xn--bcher-kva.de"])
        self.assertEqual(body["counts"], {"pending": 2, "verified": 1, "degraded": 0, "suspended": 0})
        self.assertEqual((body["page"]["total"], body["scopeTotal"]), (3, 3))
        self.assertNotIn("record", body["items"][0])
        for domain in MonitoredDomain.objects.all():
            self.assertNotIn(domain.token, json.dumps(body))

    def test_filters_search_and_sorting(self):
        self.assertEqual(self.names("?status=verified"), ["beta.example.com"])
        self.assertEqual(self.names(f"?customer={self.globex.pk}"), ["xn--bcher-kva.de"])
        self.assertEqual(self.names("?q=bücher"), ["xn--bcher-kva.de"])
        self.assertEqual(self.names("?q=acme"), ["alpha.example.com", "beta.example.com"])
        self.assertEqual(self.names("?sort=name&dir=desc"), ["xn--bcher-kva.de", "beta.example.com", "alpha.example.com"])
        self.assertEqual(self.names("?sort=customer&dir=desc")[0], "xn--bcher-kva.de")
        body = self.client_.get(DOMAINS + "?status=verified").json()
        self.assertEqual((body["page"]["total"], body["counts"]["pending"]), (1, 2))

    def test_parameters_are_checked(self):
        for query in ("?status=gone", "?sort=token", "?customer=nope", "?other=1", "?q=a&q=b"):
            with self.subTest(query=query):
                self.assertEqual(self.client_.get(DOMAINS + query).status_code, 400)
        self.assertEqual(self.client_.get(DOMAINS + "?customer=00000000-0000-0000-0000-000000000000").status_code, 404)


class VerifyTests(TestCase):
    def setUp(self):
        self.acme = Customer.objects.create(name="Acme")
        self.admin = domain_admin()
        self.client_ = signed_in_client(self.admin)
        self.domain_id = add(self.client_, self.acme).json()["item"]["id"]
        self.verify = f"{DOMAINS}{self.domain_id}/verify/"

    def test_a_request_is_queued_and_answered_by_the_verifier_not_the_web_process(self):
        with patch("apps.web.dns_verification.verify", side_effect=AssertionError("the web process asked the DNS")):
            response = post(self.client_, self.verify)
        self.assertEqual(response.status_code, 202, response.content)
        body = response.json()
        item = body["item"]
        self.assertEqual((item["status"], item["outcome"], item["requestedBy"]), ("pending", None, "admin"))
        self.assertEqual(body["verifier"], {"state": "never_started"})
        location = response["Location"]
        self.assertEqual(location, f"{DOMAINS}{self.domain_id}/verifications/{item['id']}/")
        self.assertEqual(self.client_.get(location).json()["item"]["status"], "pending")

        with self.assertLogs("apps.web.verifier", "INFO"):
            Verifier(verify=found).cycle()
        followed = self.client_.get(location).json()
        self.assertEqual(followed["item"]["status"], "done")
        self.assertEqual(followed["item"]["outcome"], {"value": "verified", "label": "Verified"})
        self.assertEqual(followed["item"]["detail"]["value"], "found")
        self.assertEqual(followed["item"]["evidence"]["nameservers"][0]["result"], "match")
        self.assertEqual(followed["verifier"], {"state": "running"})
        detail = self.client_.get(f"{DOMAINS}{self.domain_id}/").json()["item"]
        self.assertEqual((detail["status"], detail["lastOutcome"]["value"], detail["version"]), ("verified", "verified", 2))
        self.assertEqual(detail["latestVerification"]["id"], item["id"])
        actions = list(ConfigurationEvent.objects.order_by("id").values_list("action", flat=True))
        self.assertEqual(actions, ["domain_created", "domain_verification_requested", "domain_verified"])

    def test_one_at_a_time_and_then_a_short_wait(self):
        self.assertEqual(post(self.client_, self.verify).status_code, 202)
        response = post(self.client_, self.verify)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "verification_active"))
        DomainVerification.objects.update(status="done", outcome="absent", detail="not_found", finished_at=timezone.now())
        response = post(self.client_, self.verify)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (429, "rate_limited"))
        self.assertTrue(1 <= int(response["Retry-After"]) <= 10)

    def test_the_queue_full_answer(self):
        with patch("apps.web.verification.QUEUE_LIMIT", 0):
            response = post(self.client_, self.verify)
        self.assertEqual((response.status_code, response.json()["error"]["code"], response["Retry-After"]), (503, "queue_full", "30"))

    def test_a_verification_takes_no_options(self):
        response = post(self.client_, self.verify, {"nameserver": "10.0.0.1"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("nameserver", response.json()["error"]["fields"])
        self.assertEqual(post(self.client_, self.verify, {}).status_code, 202)

    def test_unknown_domains_and_verifications_of_another_domain_are_not_found(self):
        self.assertEqual(post(self.client_, f"{DOMAINS}00000000-0000-0000-0000-000000000000/verify/").status_code, 404)
        self.assertEqual(self.client_.get(f"{DOMAINS}00000000-0000-0000-0000-000000000000/").status_code, 404)
        other_id = add(self.client_, self.acme, "other.example.com").json()["item"]["id"]
        vid = post(self.client_, f"{DOMAINS}{other_id}/verify/").json()["item"]["id"]
        self.assertEqual(self.client_.get(f"{DOMAINS}{self.domain_id}/verifications/{vid}/").status_code, 404)
        self.assertEqual(self.client_.get(f"{DOMAINS}{other_id}/verifications/{vid}/").status_code, 200)

    def test_a_request_no_verifier_took_expires_when_read(self):
        vid = post(self.client_, self.verify).json()["item"]["id"]
        DomainVerification.objects.filter(pk=vid).update(
            created_at=timezone.now() - timedelta(minutes=11), expires_at=timezone.now() - timedelta(minutes=1)
        )
        item = self.client_.get(f"{DOMAINS}{self.domain_id}/verifications/{vid}/").json()["item"]
        self.assertEqual((item["status"], item["detail"]["value"]), ("expired", "expired"))
        self.assertEqual(post(self.client_, self.verify).status_code, 202)

    def test_only_get_and_post(self):
        self.assertEqual(self.client_.delete(f"{DOMAINS}{self.domain_id}/").status_code, 405)
        self.assertEqual(self.client_.patch(f"{DOMAINS}{self.domain_id}/", "{}", content_type="application/json").status_code, 405)
        self.assertEqual(self.client_.get(self.verify).status_code, 405)

    def test_the_site_of_a_customer_changes_nothing(self):
        Site.objects.create(customer=self.acme, name="HQ")
        self.assertEqual(self.client_.get(f"{DOMAINS}{self.domain_id}/").status_code, 200)


class ConcurrentTests(TransactionTestCase):
    def run_at_once(self, count, action):
        barrier = threading.Barrier(count)
        statuses = []

        def run():
            try:
                barrier.wait(timeout=10)
                statuses.append(action().status_code)
            finally:
                connection.close()

        threads = [threading.Thread(target=run) for _ in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        return sorted(statuses)

    def test_the_same_domain_added_at_once_is_added_once(self):
        acme = Customer.objects.create(name="Acme")
        admin = domain_admin()
        clients = [signed_in_client(admin) for _ in range(4)]
        spellings = iter(["example.com", "EXAMPLE.com", "example.com.", "Example.Com"])
        pairs = [(client, next(spellings)) for client in clients]
        actions = iter(pairs)
        lock = threading.Lock()

        def action():
            with lock:
                client, name = next(actions)
            return add(client, acme, name)

        self.assertEqual(self.run_at_once(4, action), [201, 409, 409, 409])
        self.assertEqual(MonitoredDomain.objects.count(), 1)

    def test_verifications_asked_at_once_queue_one(self):
        acme = Customer.objects.create(name="Acme")
        admin = domain_admin()
        domain_id = add(signed_in_client(admin), acme).json()["item"]["id"]
        clients = iter([signed_in_client(admin) for _ in range(4)])
        lock = threading.Lock()

        def action():
            with lock:
                client = next(clients)
            return post(client, f"{DOMAINS}{domain_id}/verify/")

        statuses = self.run_at_once(4, action)
        self.assertEqual(statuses[0], 202)
        self.assertTrue(all(status in (409, 429) for status in statuses[1:]), statuses)
        self.assertEqual(DomainVerification.objects.count(), 1)

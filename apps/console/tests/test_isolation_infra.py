"""Customer and site isolation of the server and container endpoints.

An estate of three customers, with servers and containers in every site and
some servers that belong to no site, is read by users with every kind of grant
(and none). Each test states what one kind of user may see and checks that
nothing else is in the response in any form: rows, counts, totals, names,
ids, addresses, error messages.
"""

import json
import re
from uuid import uuid4

from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from apps.console.models import CustomerAccess, SiteAccess
from apps.console.tests.helpers import (
    API,
    ConsoleDataTestCase,
    make_container,
    make_docker_host,
    make_server,
    make_user,
    signed_in_client,
    start_console_session,
)
from apps.inventory.models import Customer, Site
from apps.network.models import NetworkTarget


class Estate:
    """Acme (HQ, DC), Globex (Plant), Initech (Vault) and servers without a site."""

    def __init__(self, now):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.initech = Customer.objects.create(name="Initech")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.vault = Site.objects.create(customer=self.initech, name="Vault")
        self.servers = {}
        for name, site, address in (
            ("acme-hq-web", self.hq, "10.1.0.1"),
            ("acme-dc-db", self.dc, "10.1.0.2"),
            ("globex-plant-app", self.plant, "10.2.0.1"),
            ("initech-vault-secret", self.vault, "10.3.0.1"),
            ("unassigned-new", None, "10.9.0.1"),
            ("unassigned-old", None, "10.9.0.2"),
        ):
            server = make_server(name, site=site, now=now, cpu=96 if site is self.vault else 10, ip_address=address)
            make_docker_host(server, now=now)
            make_container(server, f"{name}-main", now=now, image=f"registry.example/{name}:1")
            make_container(server, f"{name}-sidecar", now=now, state="exited")
            self.servers[name] = server

    def ids(self, *names):
        return {str(self.servers[name].pk) for name in names}


ALL = ("acme-hq-web", "acme-dc-db", "globex-plant-app", "initech-vault-secret", "unassigned-new", "unassigned-old")
ASSIGNED = ALL[:4]


class ServerIsolationTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.estate = Estate(self.now)

    def server_names(self, user, **params):
        return sorted(self.names(self.get(user, "servers/", **params)))

    def container_names(self, user, **params):
        response = self.get(user, "containers/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return sorted(item["container"]["name"] for item in response.json()["items"])

    # -- who sees what ----------------------------------------------------------

    def test_a_customer_grant_shows_all_of_that_customers_sites_and_nothing_else(self):
        user = make_user("acme", customers=[self.estate.acme])
        self.assertEqual(self.server_names(user), ["acme-dc-db", "acme-hq-web"])

    def test_a_site_grant_shows_that_site_only(self):
        user = make_user("hq", sites=[self.estate.hq])
        self.assertEqual(self.server_names(user), ["acme-hq-web"])

    def test_grants_add_up(self):
        user = make_user("mixed", customers=[self.estate.acme], sites=[self.estate.plant])
        self.assertEqual(self.server_names(user), ["acme-dc-db", "acme-hq-web", "globex-plant-app"])

    def test_servers_without_a_site_are_invisible_to_every_restricted_user(self):
        everything_assigned = make_user(
            "everything", customers=[self.estate.acme, self.estate.globex, self.estate.initech]
        )
        names = self.server_names(everything_assigned)
        self.assertEqual(names, sorted(ASSIGNED))
        self.assertNotIn("unassigned-new", names)

    def test_only_users_who_may_see_all_customers_see_servers_without_a_site(self):
        for user in (make_user("all", all_customers=True), make_user("root", superuser=True)):
            self.assertEqual(self.server_names(user), sorted(ALL), user.username)

    def test_a_scope_narrows_an_all_customers_user_and_leaves_out_unassigned_servers(self):
        user = make_user("all", all_customers=True)
        self.assertEqual(self.server_names(user, customer=self.estate.acme.pk), ["acme-dc-db", "acme-hq-web"])
        self.assertEqual(self.server_names(user, site=self.estate.dc.pk), ["acme-dc-db"])

    def test_a_console_user_without_grants_sees_nothing(self):
        user = make_user("nobody")
        body = self.get(user, "servers/").json()
        self.assertEqual((body["items"], body["page"]["total"], body["scopeTotal"]), ([], 0, 0))
        self.assertEqual(set(body["counts"].values()), {0})
        self.assertEqual(self.container_names(user), [])

    def test_grants_without_the_console_permission_open_nothing(self):
        user = make_user("granted-but-no-console", console=False, customers=[self.estate.acme])
        for path in ("servers/", "containers/", f"servers/{self.estate.servers['acme-hq-web'].pk}/"):
            self.assertEqual(self.get(user, path).status_code, 403, path)

    def test_an_inactive_user_sees_nothing(self):
        user = make_user("gone", customers=[self.estate.acme])
        client = signed_in_client(user)
        user.is_active = False
        user.save()
        self.assertEqual(client.get(API + "servers/").status_code, 401)

    def test_new_and_moved_servers_follow_the_grants_immediately(self):
        user = make_user("acme", customers=[self.estate.acme])
        self.assertNotIn("unassigned-new", self.server_names(user))
        server = self.estate.servers["unassigned-new"]
        server.site = self.estate.hq  # an administrator assigns it
        server.save()
        self.assertIn("unassigned-new", self.server_names(user))
        server.site = self.estate.vault  # ...and moves it to another customer
        server.save()
        self.assertNotIn("unassigned-new", self.server_names(user))
        extra = Site.objects.create(customer=self.estate.acme, name="Annex")  # a site added later is covered
        server.site = extra
        server.save()
        self.assertIn("unassigned-new", self.server_names(user))

    def test_a_revoked_grant_takes_effect_at_once(self):
        user = make_user("acme", customers=[self.estate.acme])
        client = signed_in_client(user)
        self.assertEqual(client.get(API + "servers/").json()["page"]["total"], 2)
        CustomerAccess.objects.filter(user=user).delete()
        self.assertEqual(client.get(API + "servers/").json()["page"]["total"], 0)

    # -- containers follow their server ---------------------------------------

    def test_containers_follow_the_visibility_of_their_server(self):
        acme = make_user("acme", customers=[self.estate.acme])
        self.assertEqual(
            self.container_names(acme),
            sorted(f"{s}-{kind}" for s in ("acme-hq-web", "acme-dc-db") for kind in ("main", "sidecar")),
        )
        free = make_user("all", all_customers=True)
        self.assertEqual(len(self.container_names(free)), 2 * len(ALL))

    def test_a_server_filter_on_a_hidden_server_looks_like_one_with_no_containers(self):
        acme = make_user("acme", customers=[self.estate.acme])
        hidden = self.get(acme, "containers/", server=self.estate.servers["globex-plant-app"].pk)
        unknown = self.get(acme, "containers/", server=uuid4())
        empty_visible = self.get(acme, "containers/", server=self.estate.servers["acme-hq-web"].pk, q="zzz-no-match")
        for response in (hidden, unknown, empty_visible):
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual((body["items"], body["page"]["total"]), ([], 0))
        self.assertEqual(hidden.json()["scopeTotal"], 0)
        self.assertEqual(unknown.json()["scopeTotal"], 0)

    # -- details ---------------------------------------------------------------

    def test_a_hidden_server_and_an_unknown_one_are_the_same_404(self):
        acme = make_user("acme", customers=[self.estate.acme])
        hidden = self.get(acme, f"servers/{self.estate.servers['globex-plant-app'].pk}/")
        unassigned = self.get(acme, f"servers/{self.estate.servers['unassigned-new'].pk}/")
        unknown = self.get(acme, f"servers/{uuid4()}/")
        for response in (hidden, unassigned, unknown):
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Not found."}})
        self.assertEqual(hidden.content, unknown.content)
        self.assertEqual(self.get(acme, f"servers/{self.estate.servers['acme-hq-web'].pk}/").status_code, 200)

    def test_the_detail_view_embeds_only_that_servers_containers(self):
        acme = make_user("acme", customers=[self.estate.acme])
        body = self.get(acme, f"servers/{self.estate.servers['acme-hq-web'].pk}/").json()
        self.assertEqual(sorted(c["container"]["name"] for c in body["containers"]), ["acme-hq-web-main", "acme-hq-web-sidecar"])
        self.assertEqual({c["container"]["serverId"] for c in body["containers"]}, {str(self.estate.servers["acme-hq-web"].pk)})

    def test_an_unassigned_server_is_only_openable_by_all_customers_users(self):
        server = self.estate.servers["unassigned-old"]
        self.assertEqual(self.get(make_user("all", all_customers=True), f"servers/{server.pk}/").status_code, 200)
        self.assertEqual(self.get(make_user("acme", customers=[self.estate.acme]), f"servers/{server.pk}/").status_code, 404)

    # -- scope parameters ------------------------------------------------------

    def test_a_scope_outside_the_grants_is_a_404_whether_or_not_it_exists(self):
        acme = make_user("acme", customers=[self.estate.acme], sites=[self.estate.plant])
        for path in ("servers/", "containers/"):
            for params in (
                {"customer": self.estate.initech.pk},
                {"site": self.estate.vault.pk},
                {"customer": uuid4()},
                {"site": uuid4()},
                {"customer": self.estate.acme.pk, "site": self.estate.plant.pk},  # a site of another customer
            ):
                response = self.get(acme, path, **params)
                self.assertEqual(response.status_code, 404, (path, params))
                self.assertEqual(response.json()["error"]["code"], "not_found")

    def test_a_scope_inside_the_grants_works(self):
        acme = make_user("acme", customers=[self.estate.acme], sites=[self.estate.plant])
        self.assertEqual(self.server_names(acme, site=self.estate.plant.pk), ["globex-plant-app"])
        self.assertEqual(self.server_names(acme, customer=self.estate.globex.pk), ["globex-plant-app"])
        self.assertEqual(self.server_names(acme, customer=self.estate.acme.pk, site=self.estate.dc.pk), ["acme-dc-db"])

    # -- nothing leaks through the other parts of the response -------------------

    def test_counts_totals_and_pages_describe_only_visible_servers(self):
        acme = make_user("acme", customers=[self.estate.acme])
        body = self.get(acme, "servers/").json()
        self.assertEqual(body["scopeTotal"], 2)
        self.assertEqual(sum(body["counts"].values()), 2)
        self.assertEqual(body["page"]["total"], 2)
        # The Vault server is critical (cpu 96); it must not be counted for Acme.
        self.assertEqual(body["counts"]["critical"], 0)
        vault = make_user("vault", sites=[self.estate.vault])
        self.assertEqual(self.get(vault, "servers/").json()["counts"]["critical"], 1)

    def test_searching_for_another_customers_names_finds_nothing(self):
        acme = make_user("acme", customers=[self.estate.acme])
        for term in ("globex", "Plant", "initech", "vault", "secret", "10.3.0.1", "10.9.0", "unassigned", "registry.example/initech"):
            for path in ("servers/", "containers/"):
                body = self.get(acme, path, q=term).json()
                self.assertEqual((body["items"], body["page"]["total"]), ([], 0), (path, term))
                self.assertEqual(sum(body["counts"].values()), 0)

    def test_the_scope_total_does_not_depend_on_the_search_and_stays_inside_the_grants(self):
        acme = make_user("acme", customers=[self.estate.acme])
        searched = self.get(acme, "servers/", q="globex").json()
        self.assertEqual(searched["scopeTotal"], 2)
        searched = self.get(acme, "containers/", q="globex").json()
        self.assertEqual(searched["scopeTotal"], 4)

    def test_responses_for_a_restricted_user_never_contain_other_tenants_data(self):
        acme = make_user("acme", customers=[self.estate.acme])
        forbidden = [
            "Globex", "Plant", "Initech", "Vault", "globex-plant-app", "initech-vault-secret",
            "unassigned", "10.2.0.1", "10.3.0.1", "10.9.0.1",
            str(self.estate.globex.pk), str(self.estate.initech.pk), str(self.estate.plant.pk), str(self.estate.vault.pk),
            *(str(self.estate.servers[name].pk) for name in ("globex-plant-app", "initech-vault-secret", "unassigned-new", "unassigned-old")),
        ]
        paths = [
            "servers/", "servers/?sort=cpu", "servers/?status=critical", "servers/?pageSize=200&page=1",
            "containers/", "containers/?status=idle", "containers/?sort=server",
            f"servers/{self.estate.servers['acme-hq-web'].pk}/",
        ]
        client = signed_in_client(acme)
        for path in paths:
            text = client.get(API + path).content.decode()
            for needle in forbidden:
                self.assertNotIn(needle, text, (path, needle))

    def test_errors_do_not_reveal_whether_a_hidden_object_exists(self):
        acme = make_user("acme", customers=[self.estate.acme])
        real = self.get(acme, "servers/", site=self.estate.vault.pk)
        fake = self.get(acme, "servers/", site=uuid4())
        self.assertEqual((real.status_code, real.content), (fake.status_code, fake.content))

    def test_two_users_see_different_data_from_the_same_urls_and_never_each_others(self):
        a = signed_in_client(make_user("acme", customers=[self.estate.acme]))
        g = signed_in_client(make_user("globex", customers=[self.estate.globex]))
        for path in ("servers/", "containers/"):
            body_a = json.dumps(a.get(API + path).json())
            body_g = json.dumps(g.get(API + path).json())
            self.assertIn("Acme", body_a)
            self.assertNotIn("Acme", body_g)
            self.assertIn("Globex", body_g)
            self.assertNotIn("Globex", body_a)

    def test_ordering_and_filters_never_widen_the_result(self):
        acme = make_user("acme", customers=[self.estate.acme])
        for sort in ("status", "name", "cpu", "memory", "disk", "uptime", "seen"):
            for direction in ("asc", "desc"):
                for status in ("all", "critical", "warning", "unknown", "healthy"):
                    names = self.server_names(acme, sort=sort, dir=direction, status=status)
                    self.assertTrue(set(names) <= {"acme-hq-web", "acme-dc-db"}, (sort, direction, status, names))
        for sort in ("status", "name", "server", "started"):
            names = self.container_names(acme, sort=sort)
            self.assertTrue(all(n.startswith("acme-") for n in names), (sort, names))

    def test_every_data_query_carries_the_visibility_condition(self):
        """No SQL statement against the tenant tables may run without a site restriction."""
        acme = make_user("acme", customers=[self.estate.acme])
        client = signed_in_client(acme)
        client.get(API + "servers/")  # warm up (session, permissions)
        site_ids = {str(self.estate.hq.pk).replace("-", ""), str(self.estate.dc.pk).replace("-", "")}
        with CaptureQueriesContext(connection) as queries:
            client.get(API + "servers/?q=acme&sort=cpu")
            client.get(API + "containers/?q=acme")
            client.get(API + f"servers/{self.estate.servers['acme-hq-web'].pk}/")
        data = [q["sql"] for q in queries if "infrastructure_server" in q["sql"] or "infrastructure_dockercontainer" in q["sql"]]
        self.assertGreaterEqual(len(data), 7)
        for sql in data:
            self.assertIn("site_id\" IN (", sql, sql[:200])
            self.assertTrue(any(site_id in sql for site_id in site_ids), sql[:200])


class AuthenticationTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.estate = Estate(self.now)
        self.paths = ["servers/", "containers/", f"servers/{self.estate.servers['acme-hq-web'].pk}/"]

    def test_anonymous_requests_are_401(self):
        for path in self.paths:
            response = Client().get(API + path)
            self.assertEqual(response.status_code, 401, path)
            self.assertEqual(response.json(), {"error": {"code": "unauthenticated", "message": "Sign in to continue."}})

    def test_a_session_that_did_not_come_from_the_console_sign_in_is_refused(self):
        user = make_user("admin-session", all_customers=True, superuser=True)
        client = Client()
        client.force_login(user)  # what the admin login creates: no console marker
        for path in self.paths:
            self.assertEqual(client.get(API + path).status_code, 401, path)

    def test_an_agent_token_is_not_a_credential_here(self):
        from apps.agents.services import create_agent

        _agent, token = create_agent(server=self.estate.servers["acme-hq-web"], name="agent-1")
        for path in self.paths:
            response = Client().get(API + path, HTTP_AUTHORIZATION=f"Bearer {token}")
            self.assertEqual(response.status_code, 401, path)

    def test_only_get_and_head_are_allowed(self):
        client = signed_in_client(make_user("all", all_customers=True), enforce_csrf=False)
        for path in self.paths:
            for method in ("post", "put", "patch", "delete"):
                response = getattr(client, method)(API + path)
                self.assertEqual(response.status_code, 405, (method, path))
                self.assertEqual(response["Allow"], "GET, HEAD")
            self.assertEqual(client.head(API + path).status_code, 200)

    def test_responses_are_private_and_uncached(self):
        client = signed_in_client(make_user("all", all_customers=True))
        for path in self.paths:
            response = client.get(API + path)
            self.assertIn("no-store", response["Cache-Control"])
            self.assertIn("Cookie", response["Vary"])
            self.assertEqual(response["Content-Type"], "application/json")

    def test_session_expiry_closes_the_endpoints(self):
        user = make_user("old", all_customers=True)
        client = Client()
        start_console_session(client, user, signed_in_at=0)  # signed in long ago
        for path in self.paths:
            self.assertEqual(client.get(API + path).status_code, 401)


class SecretsTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        from apps.agents.services import create_agent

        self.estate = Estate(self.now)
        self.agent, self.token = create_agent(server=self.estate.servers["acme-hq-web"], name="the-agent")
        NetworkTarget.objects.create(name="t", hostname_or_ip="192.0.2.1", protocol="icmp", site=self.estate.hq)

    def test_no_secret_is_in_any_response(self):
        client = signed_in_client(make_user("all", all_customers=True))
        server = self.estate.servers["acme-hq-web"]
        for path in ("servers/", "containers/", f"servers/{server.pk}/"):
            text = client.get(API + path).content.decode()
            for secret in (self.token, self.agent.token_hash, "token", "hash", "password"):
                self.assertNotIn(secret, text, (path, secret))

    def test_the_token_hash_is_never_even_read_from_the_database(self):
        client = signed_in_client(make_user("all", all_customers=True))
        client.get(API + "servers/")
        with CaptureQueriesContext(connection) as queries:
            client.get(API + "servers/?q=acme&sort=name")
            client.get(API + f"servers/{self.estate.servers['acme-hq-web'].pk}/")
            client.get(API + "containers/")
        used = set()
        for query in queries:
            self.assertNotIn("token_hash", query["sql"])
            used |= set(re.findall(r'"agents_agent"\."(\w+)"', query["sql"]))
        # The version is the only agent column read; server_id is the join key.
        self.assertEqual(used, {"agent_version", "server_id"})

    def test_the_agent_version_is_shown_and_nothing_else_about_the_agent(self):
        self.agent.agent_version = "1.4.2"
        self.agent.save()
        body = signed_in_client(make_user("all", all_customers=True)).get(API + "servers/?q=acme-hq-web").json()
        server = body["items"][0]["server"]
        self.assertEqual(server["agentVersion"], "1.4.2")
        self.assertEqual(
            set(server),
            {"id", "name", "hostname", "ipAddress", "operatingSystem", "status", "siteId", "lastSeenAt", "agentVersion", "telemetry"},
        )


class OtherModelsTests(ConsoleDataTestCase):
    def test_network_targets_are_isolated_by_their_own_site_too(self):
        """Their own site isolates them, through the same layer (``/targets/`` reads them so)."""
        estate = Estate(self.now)
        for name, site in (("t-hq", estate.hq), ("t-plant", estate.plant), ("t-none", None)):
            NetworkTarget.objects.create(name=name, hostname_or_ip="192.0.2.10", protocol="icmp", site=site)
        from apps.console.access import Visibility

        def visible(user):
            return sorted(Visibility.for_user(user).filter(NetworkTarget.objects.all()).values_list("name", flat=True))

        self.assertEqual(visible(make_user("acme", customers=[estate.acme])), ["t-hq"])
        self.assertEqual(visible(make_user("plant", sites=[estate.plant])), ["t-plant"])
        self.assertEqual(visible(make_user("all", all_customers=True)), ["t-hq", "t-none", "t-plant"])
        self.assertEqual(visible(make_user("nobody")), [])

    def test_a_site_grant_row_for_another_user_gives_nothing(self):
        estate = Estate(self.now)
        other = make_user("other", sites=[estate.hq])
        mine = make_user("mine")
        self.assertEqual(self.names(self.get(other, "servers/")), ["acme-hq-web"])
        self.assertEqual(self.names(self.get(mine, "servers/")), [])
        SiteAccess.objects.filter(user=other).delete()
        self.assertEqual(self.names(self.get(other, "servers/")), [])

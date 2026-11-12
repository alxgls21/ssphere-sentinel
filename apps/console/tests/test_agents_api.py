"""The agents of the servers the user may see (``apps.console.agents``): ``GET /agents/``, for choosing which agent
probes a target or polls a device. Never a token, never an agent of a hidden server."""

from __future__ import annotations

from datetime import timedelta

from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.console.tests.helpers import API, ConsoleDataTestCase, make_server, make_user, signed_in_client
from apps.inventory.models import Customer, Site

AGENTS = API + "agents/"
ITEM_KEYS = {"id", "name", "enabled", "status", "lastSeenAt", "serverId", "serverName"}


class AgentListTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.online, self.token = create_agent(server=make_server("web-1", site=self.hq, now=self.now), name="web-agent")
        self.seen(self.online, 5)
        self.offline, _ = create_agent(server=make_server("db-1", site=self.hq, now=self.now), name="db-agent")
        self.seen(self.offline, 500)
        self.offline.enabled = False
        self.offline.save(update_fields=["enabled"])
        self.never, _ = create_agent(server=make_server("plant-1", site=self.plant, now=self.now, seen_ago=None), name="plant-agent")
        self.lonely, _ = create_agent(server=make_server("lonely", site=None, now=self.now), name="lonely-agent")
        make_server("agentless", site=self.hq, now=self.now)
        self.admin = make_user("ops", all_customers=True)

    def seen(self, agent, ago):
        agent.last_seen_at = None if ago is None else self.now - timedelta(seconds=ago)
        agent.save(update_fields=["last_seen_at"])

    def test_every_agent_of_a_visible_server_with_its_status(self):
        with CaptureQueriesContext(connection) as queries:
            response = self.get(self.admin, "agents/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("no-store", response["Cache-Control"])
        body = response.json()
        self.assertEqual(set(body), {"generatedAt", "items", "page"})
        self.assertEqual([item["name"] for item in body["items"]], ["db-agent", "lonely-agent", "plant-agent", "web-agent"])
        by_name = {item["name"]: item for item in body["items"]}
        self.assertEqual(set(by_name["web-agent"]), ITEM_KEYS)
        self.assertEqual((by_name["web-agent"]["status"], by_name["web-agent"]["enabled"], by_name["web-agent"]["serverName"]), ("online", True, "web-1"))
        self.assertEqual((by_name["db-agent"]["status"], by_name["db-agent"]["enabled"]), ("offline", False))
        self.assertEqual((by_name["plant-agent"]["status"], by_name["plant-agent"]["lastSeenAt"]), ("unknown", None))
        self.assertEqual(by_name["web-agent"]["id"], str(self.online.pk))
        self.assertEqual(body["page"], {"number": 1, "size": 50, "total": 4, "pages": 1})
        text = response.content.decode()
        for secret in (self.token, self.online.token_hash, "token", "hash"):
            self.assertNotIn(secret, text)
        for query in queries.captured_queries:
            self.assertNotIn("token_hash", query["sql"])

    def test_a_restricted_account_sees_the_agents_of_its_servers_only(self):
        acme = make_user("acme", customers=[self.acme])
        self.assertEqual([item["name"] for item in self.get(acme, "agents/").json()["items"]], ["db-agent", "web-agent"])
        plant = make_user("plant", sites=[self.plant])
        self.assertEqual([item["name"] for item in self.get(plant, "agents/").json()["items"]], ["plant-agent"])
        nothing = make_user("nothing")
        self.assertEqual(self.get(nothing, "agents/").json()["items"], [])

    def test_search_paging_and_bad_queries(self):
        names = lambda **params: [item["name"] for item in self.get(self.admin, "agents/", **params).json()["items"]]  # noqa: E731
        self.assertEqual(names(q="web"), ["web-agent"])
        self.assertEqual(names(q="db-1"), ["db-agent"])  # the server's name too
        self.assertEqual(names(q="agent plant"), ["plant-agent"])
        body = self.get(self.admin, "agents/", pageSize="3", page="2").json()
        self.assertEqual(([item["name"] for item in body["items"]], body["page"]["pages"]), (["web-agent"], 2))
        for params in ({"sort": "name"}, {"status": "online"}, {"page": "0"}, {"pageSize": "201"}, {"customer": str(self.acme.pk)}):
            with self.subTest(params=params):
                self.assertEqual(self.get(self.admin, "agents/", **params).status_code, 400)

    def test_signed_out_and_the_methods(self):
        self.assertEqual(Client().get(AGENTS).status_code, 401)
        self.assertEqual(signed_in_client(make_user("plain", console=False)).get(AGENTS).status_code, 403)
        client = signed_in_client(self.admin)
        self.assertEqual(client.post(AGENTS, "{}", content_type="application/json").status_code, 405)
        self.assertEqual(client.delete(AGENTS).status_code, 405)

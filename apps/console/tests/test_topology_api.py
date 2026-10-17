"""The infrastructure graph, ``GET /topology/`` (``apps.console.topology``).

Access and visibility (nothing hidden is a node, an edge end, a label or a
count), cross-site monitoring assignments, stable ids, parent and edge
integrity, no physical edges, health as the other endpoints report it, the
optional kinds, the limit and truncation, bounded queries, invalid parameters.
"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.agents.services import create_agent
from apps.console.tests.helpers import (
    API,
    ConsoleDataTestCase,
    make_container,
    make_docker_host,
    make_server,
    make_user,
    signed_in_client,
)
from apps.inventory.models import Customer, Device, Site
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.snmp.models import DeviceSnmpState, Interface, SnmpConfig


class Estate:
    """Two customers; servers with agents and containers; targets and devices, some measured from another site."""

    def __init__(self, now):
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.empty = Customer.objects.create(name="Empty Corp")
        self.hq = Site.objects.create(customer=self.acme, name="HQ")
        self.dc = Site.objects.create(customer=self.acme, name="DC")
        self.plant = Site.objects.create(customer=self.globex, name="Plant")
        self.web = make_server("hq-web", site=self.hq, now=now)
        self.down = make_server("hq-down", site=self.hq, now=now, seen_ago=600)  # offline: critical
        self.plant_srv = make_server("plant-srv", site=self.plant, now=now)
        self.loose = make_server("loose-srv", now=now)  # no site
        self.agents = {}
        for server in (self.web, self.down, self.plant_srv, self.loose):
            agent, _ = create_agent(server=server, name=f"{server.name}-agent")
            agent.last_seen_at = server.last_seen_at
            agent.agent_version = "1.2.3"
            agent.save()
            self.agents[server.name] = agent
        make_docker_host(self.web, now=now)
        make_container(self.web, "app", now=now)
        make_container(self.web, "db", now=now, state="dead")
        # A target at the plant, measured by the HQ server's agent: cross-site.
        self.t_plant = self.target("plant-gw", self.plant, self.agents["hq-web"], now)
        self.t_hq = self.target("hq-gw", self.hq, self.agents["hq-web"], now)
        self.t_free = self.target("unassigned-gw", self.hq, None, now)  # no agent: no edge
        self.d_dc = self.device("dc-sw", self.dc, self.agents["hq-web"], now)
        self.d_plant = self.device("plant-sw", self.plant, self.agents["plant-srv"], now)
        Device.objects.create(name="no-snmp", management_address="192.0.2.9", site=self.hq)  # not an SNMP device
        for i, (admin, oper) in enumerate(((1, 1), (1, 2), (2, 2)), start=1):
            Interface.objects.create(device=self.d_dc, if_index=i, name=f"Gi0/{i}", admin_status=admin, oper_status=oper,
                                     speed_bps=10**9)

    @staticmethod
    def target(name, site, agent, now):
        target = NetworkTarget.objects.create(name=name, hostname_or_ip="192.0.2.1", protocol="icmp", site=site, assigned_agent=agent)
        if agent is not None:
            NetworkMeasurement.objects.create(
                id=uuid.uuid4(), target=target, agent=agent, measured_at=now - timedelta(seconds=10), received_at=now,
                success=True, latency_ms=5.0, packet_loss_percentage=0.0, probe_count=4, successful_probes=4,
            )
        return target

    @staticmethod
    def device(name, site, agent, now):
        device = Device.objects.create(name=name, management_address="192.0.2.2", site=site, assigned_agent=agent)
        SnmpConfig.objects.create(device=device, credential_profile="secret-profile-name")
        DeviceSnmpState.objects.create(device=device, last_poll_at=now - timedelta(seconds=10), reachable=True,
                                       response_ms=3.0, received_at=now)
        return device


class TopologyTestCase(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.estate = Estate(self.now)
        self.admin = make_user("ops", all_customers=True)

    def graph(self, user=None, **params):
        response = self.get(user or self.admin, "topology/", **params)
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    @staticmethod
    def nodes(body):
        return {node["data"]["id"]: node["data"] for node in body["elements"]["nodes"]}

    @staticmethod
    def edges(body):
        return {edge["data"]["id"]: edge["data"] for edge in body["elements"]["edges"]}

    def assertIntegrity(self, body):
        nodes = self.nodes(body)
        self.assertEqual(len(nodes), len(body["elements"]["nodes"]), "duplicate node ids")
        self.assertEqual(len(self.edges(body)), len(body["elements"]["edges"]), "duplicate edge ids")
        for node in nodes.values():
            if "parent" in node:
                self.assertIn(node["parent"], nodes, node)
        for edge in self.edges(body).values():
            self.assertIn(edge["source"], nodes)
            self.assertIn(edge["target"], nodes)
            self.assertEqual(edge["category"], "monitoring")
        self.assertIs(body["physicalLinksKnown"], False)


class TopologyAccessTests(TopologyTestCase):
    def test_signed_out_and_without_console_access(self):
        self.assertEqual(self.client.get(API + "topology/").status_code, 401)
        self.assertEqual(signed_in_client(make_user("plain", console=False)).get(API + "topology/").status_code, 403)

    def test_a_customer_user_sees_only_their_graph_and_counts(self):
        acme = make_user("acme", customers=[self.estate.acme])
        body = self.graph(acme)
        self.assertIntegrity(body)
        labels = {node["label"] for node in self.nodes(body).values()}
        self.assertEqual(labels, {"Acme", "HQ", "DC", "hq-web", "hq-down", "hq-gw", "unassigned-gw", "dc-sw"})
        self.assertEqual(body["counts"]["server"], {"visible": 2, "returned": 2})
        self.assertEqual(body["counts"]["customer"], {"visible": 1, "returned": 1})
        self.assertNotIn("group", body["counts"])
        text = json.dumps(body)
        for hidden in ("Globex", "Plant", "plant", "loose", str(self.estate.plant_srv.pk), str(self.estate.loose.pk)):
            self.assertNotIn(hidden, text)

    def test_a_site_grant_shows_the_customer_name_but_not_its_other_sites(self):
        dc = make_user("dc", sites=[self.estate.dc])
        nodes = self.nodes(self.graph(dc))
        self.assertEqual({n["label"] for n in nodes.values()}, {"Acme", "DC", "dc-sw"})

    def test_a_cross_site_assignment_does_not_reveal_the_hidden_server(self):
        plant = make_user("plant", sites=[self.estate.plant])
        body = self.graph(plant)
        self.assertIntegrity(body)
        nodes = self.nodes(body)
        self.assertIn(f"target:{self.estate.t_plant.pk}", nodes)
        # Its agent's server is at HQ, which this user may not see: no node, no edge, no name, no id.
        self.assertNotIn(f"monitors:target:{self.estate.t_plant.pk}", self.edges(body))
        self.assertIn(f"polls:device:{self.estate.d_plant.pk}", self.edges(body))  # the plant's own server
        text = json.dumps(body)
        for hidden in ("hq-web", str(self.estate.web.pk), str(self.estate.agents["hq-web"].pk)):
            self.assertNotIn(hidden, text)
        # Everyone who may see both ends sees the assignment.
        self.assertIn(f"monitors:target:{self.estate.t_plant.pk}", self.edges(self.graph()))

    def test_the_scope_filters_and_unknown_scopes_are_not_found(self):
        body = self.graph(customer=str(self.estate.globex.pk))
        self.assertEqual({n["kind"] for n in self.nodes(body).values()}, {"customer", "site", "server", "target", "device"})
        self.assertNotIn(f"monitors:target:{self.estate.t_plant.pk}", self.edges(body))  # its server is out of scope
        self.assertFalse(body["truncated"])
        acme = make_user("acme", customers=[self.estate.acme])
        self.assertEqual(self.get(acme, "topology/", customer=str(self.estate.globex.pk)).status_code, 404)
        self.assertEqual(self.get(acme, "topology/", site=str(uuid.uuid4())).status_code, 404)

    def test_no_secret_is_read_or_sent(self):
        client = signed_in_client(self.admin)
        client.get(API + "topology/")
        with CaptureQueriesContext(connection) as queries:
            text = client.get(API + "topology/?include=containers,interfaces").content.decode()
        for query in queries:
            self.assertNotIn("token_hash", query["sql"])
            self.assertNotIn("credential_profile", query["sql"])
        for secret in ("secret-profile-name", "credential", "token"):
            self.assertNotIn(secret, text)


class TopologyGraphTests(TopologyTestCase):
    def test_nodes_ids_parents_and_the_agent_on_its_server(self):
        e = self.estate
        body = self.graph(include="containers,interfaces")
        self.assertIntegrity(body)
        nodes = self.nodes(body)
        self.assertEqual(nodes[f"site:{e.hq.pk}"]["parent"], f"customer:{e.acme.pk}")
        self.assertEqual(nodes[f"server:{e.web.pk}"]["parent"], f"site:{e.hq.pk}")
        self.assertEqual(nodes[f"server:{e.loose.pk}"]["parent"], "group:unassigned")
        self.assertEqual(nodes["group:unassigned"], {"id": "group:unassigned", "kind": "group", "label": "No site", "synthetic": True})
        container = next(n for n in nodes.values() if n["kind"] == "container" and n["label"] == "db")
        self.assertEqual(container["parent"], f"server:{e.web.pk}")
        self.assertTrue(container["id"].startswith(f"container:{e.web.pk}:"))
        self.assertEqual(nodes[f"interface:{e.d_dc.pk}:2"]["parent"], f"device:{e.d_dc.pk}")
        self.assertEqual(nodes[f"target:{e.t_plant.pk}"]["parent"], f"site:{e.plant.pk}")
        self.assertEqual(
            nodes[f"server:{e.web.pk}"]["agent"],
            {"id": str(e.agents["hq-web"].pk), "name": "hq-web-agent", "version": "1.2.3", "status": "online",
             "lastSeenAt": nodes[f"server:{e.web.pk}"]["agent"]["lastSeenAt"]},
        )
        self.assertEqual(set(nodes[f"server:{e.web.pk}"]), {"id", "kind", "label", "health", "ref", "parent", "agent"})
        self.assertNotIn("no-snmp", {n["label"] for n in nodes.values()})
        # Stable: the same graph twice.
        self.assertEqual(body["elements"], self.graph(include="containers,interfaces")["elements"])

    def test_only_monitoring_edges_and_only_for_assigned_agents(self):
        e = self.estate
        edges = self.edges(self.graph())
        self.assertEqual(
            edges,
            {
                f"monitors:target:{e.t_plant.pk}": {"id": f"monitors:target:{e.t_plant.pk}", "source": f"server:{e.web.pk}",
                                                     "target": f"target:{e.t_plant.pk}", "category": "monitoring", "kind": "probes"},
                f"monitors:target:{e.t_hq.pk}": {"id": f"monitors:target:{e.t_hq.pk}", "source": f"server:{e.web.pk}",
                                                  "target": f"target:{e.t_hq.pk}", "category": "monitoring", "kind": "probes"},
                f"polls:device:{e.d_dc.pk}": {"id": f"polls:device:{e.d_dc.pk}", "source": f"server:{e.web.pk}",
                                               "target": f"device:{e.d_dc.pk}", "category": "monitoring", "kind": "polls"},
                f"polls:device:{e.d_plant.pk}": {"id": f"polls:device:{e.d_plant.pk}", "source": f"server:{e.plant_srv.pk}",
                                                  "target": f"device:{e.d_plant.pk}", "category": "monitoring", "kind": "polls"},
            },
        )

    def test_health_is_what_the_other_endpoints_report(self):
        e = self.estate
        nodes = self.nodes(self.graph(include="containers,interfaces"))
        servers = {i["server"]["id"]: i["health"] for i in self.get(self.admin, "servers/").json()["items"]}
        for server_id, health in servers.items():
            self.assertEqual(nodes[f"server:{server_id}"]["health"], health)
        self.assertEqual(nodes[f"server:{e.down.pk}"]["health"], "critical")
        for item in self.get(self.admin, "targets/").json()["items"]:
            self.assertEqual(nodes[f"target:{item['target']['id']}"]["health"], item["health"])
        for item in self.get(self.admin, "devices/").json()["items"]:
            self.assertEqual(nodes[f"device:{item['device']['id']}"]["health"], item["health"])
        for item in self.get(self.admin, "containers/").json()["items"]:
            self.assertEqual(nodes[f"container:{item['container']['id']}"]["health"], item["status"])
        for item in self.get(self.admin, f"devices/{e.d_dc.pk}/").json()["interfaces"]:
            self.assertEqual(nodes[f"interface:{e.d_dc.pk}:{item['ifIndex']}"]["health"], item["health"])

    def test_containers_and_interfaces_only_when_asked(self):
        body = self.graph()
        self.assertFalse({"container", "interface"} & {n["kind"] for n in self.nodes(body).values()})
        self.assertNotIn("container", body["counts"])
        body = self.graph(include="containers")
        self.assertEqual(body["counts"]["container"], {"visible": 2, "returned": 2})
        self.assertNotIn("interface", body["counts"])
        body = self.graph(include="interfaces,containers")
        self.assertEqual(body["counts"]["interface"], {"visible": 3, "returned": 3})
        self.assertFalse(body["truncated"])


class TopologyLimitTests(TopologyTestCase):
    def test_a_limit_keeps_parents_and_takes_the_worst_first(self):
        e = self.estate
        body = self.graph(limit="3", include="containers")
        self.assertIntegrity(body)
        nodes = self.nodes(body)
        self.assertEqual(len(nodes), 3)
        # The worst: the offline server and the dead container, both under HQ, Acme: four nodes, so the server
        # (rank first, then the kind order) comes with its site and customer.
        self.assertEqual(set(nodes), {f"customer:{e.acme.pk}", f"site:{e.hq.pk}", f"server:{e.down.pk}"})
        self.assertTrue(body["truncated"])
        self.assertEqual(body["counts"]["server"], {"visible": 4, "returned": 1})
        self.assertEqual(body["elements"]["edges"], [])

    def test_every_limit_gives_a_whole_graph(self):
        full = self.graph(include="containers,interfaces")
        total = len(full["elements"]["nodes"])
        for limit in range(1, total + 2):
            with self.subTest(limit=limit):
                body = self.graph(limit=str(limit), include="containers,interfaces")
                self.assertIntegrity(body)
                self.assertLessEqual(len(body["elements"]["nodes"]), limit)
                self.assertEqual(body["truncated"], limit < total)
                for kind, numbers in body["counts"].items():
                    self.assertEqual(numbers["visible"], full["counts"][kind]["visible"])
                    self.assertEqual(numbers["returned"], sum(1 for n in body["elements"]["nodes"] if n["data"]["kind"] == kind))

    def test_invalid_parameters(self):
        for params in ({"include": "agents"}, {"include": "containers,containers"}, {"include": ""}, {"include": "containers,"},
                       {"limit": "0"}, {"limit": "5001"}, {"limit": "x"}, {"customer": "nope"}, {"depth": "2"}):
            with self.subTest(params):
                self.assertEqual(self.get(self.admin, "topology/", **params).status_code, 400)
        self.assertEqual(signed_in_client(self.admin).post(API + "topology/").status_code, 405)


class TopologyQueryTests(ConsoleDataTestCase):
    def count(self, client):
        client.get(API + "topology/?include=containers,interfaces")
        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(client.get(API + "topology/?include=containers,interfaces").status_code, 200)
        return len(queries)

    def grow(self, n, *, start):
        customer = Customer.objects.get_or_create(name="Acme")[0]
        site = Site.objects.get_or_create(customer=customer, name="HQ")[0]
        for i in range(start, start + n):
            server = make_server(f"srv-{i}", site=site, now=self.now)
            agent, _ = create_agent(server=server, name=f"agent-{i}")
            make_docker_host(server, now=self.now)
            make_container(server, "c", now=self.now)
            Estate.target(f"t-{i}", site, agent, self.now)
            device = Estate.device(f"d-{i}", site, agent, self.now)
            Interface.objects.create(device=device, if_index=1, name="Gi0/1", admin_status=1, oper_status=1)

    def test_the_number_of_queries_does_not_grow_with_the_estate(self):
        self.grow(2, start=0)
        users = {"all": make_user("all", all_customers=True), "acme": make_user("acme", customers=[Customer.objects.get(name="Acme")])}
        small = {who: self.count(signed_in_client(user)) for who, user in users.items()}
        self.grow(40, start=2)
        large = {who: self.count(signed_in_client(user)) for who, user in users.items()}
        self.assertEqual(small, large)

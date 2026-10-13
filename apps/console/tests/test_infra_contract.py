"""Response bodies against fixtures written from the UI's types (``frontend/src/api/types.ts``).

``ServerListItem``, ``ServerDetail`` and ``ServerContainer`` are the UI's own
contract; the fixtures list every key of each, so a renamed, dropped or extra
field fails here before it reaches the UI. The list endpoints add ``page``,
``counts`` and ``scopeTotal`` next to the UI's ``items``.
"""

from apps.agents.services import create_agent
from apps.console.tests.helpers import (
    ConsoleDataTestCase,
    fixed,
    load_contract,
    make_container,
    make_docker_host,
    make_server,
    make_user,
)
from apps.console.tests.test_session_api import matches
from apps.inventory.models import Customer, Site

WEB = fixed("5001")
SPARE = fixed("5002")


class InfrastructureContractTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        customer = Customer.objects.create(id=fixed("c001"), name="Acme")
        hq = Site.objects.create(id=fixed("a001"), customer=customer, name="HQ")
        web = make_server(
            "web-1", site=hq, now=self.now, id=WEB, cpu=12.5, memory=40.0, disk=83.0,
            ip_address="10.0.0.5", operating_system="Debian 12",
        )
        agent, _token = create_agent(server=web, name="web-1-agent")
        agent.agent_version = "1.2.3"
        agent.save()
        make_server("spare", now=self.now, id=SPARE, seen_ago=None, cpu=None)
        make_docker_host(web, now=self.now)
        make_container(web, "app", now=self.now, health="healthy", container_id="a" * 64, started_ago=60)
        make_container(web, "job", now=self.now, state="exited", image="busybox:1", container_id="b" * 64, started_ago=None)
        make_container(web, "db", now=self.now, health="unhealthy", image="postgres:16", container_id="c" * 64, started_ago=60)
        self.user = make_user("ops", all_customers=True)

    def test_the_server_list(self):
        matches(self.get(self.user, "servers/", sort="name").json(), load_contract("servers.json"))

    def test_the_server_detail(self):
        matches(self.get(self.user, f"servers/{WEB}/").json(), load_contract("server_detail.json"))

    def test_the_container_list(self):
        matches(self.get(self.user, "containers/", sort="name").json(), load_contract("containers.json"))

    def test_the_list_item_is_the_detail_item(self):
        listed = next(i for i in self.get(self.user, "servers/").json()["items"] if i["server"]["id"] == str(WEB))
        self.assertEqual(listed, self.get(self.user, f"servers/{WEB}/").json()["item"])

    def test_a_container_in_the_list_is_the_one_in_the_detail(self):
        detail = {c["container"]["id"]: c for c in self.get(self.user, f"servers/{WEB}/").json()["containers"]}
        for item in self.get(self.user, "containers/").json()["items"]:
            summary = {"container": item["container"], "status": item["status"]}
            self.assertEqual(summary, detail[item["container"]["id"]])

    def test_the_numbers_are_numbers_and_the_times_are_utc(self):
        item = self.get(self.user, f"servers/{WEB}/").json()["item"]["server"]
        telemetry = item["telemetry"]
        for key in ("cpuPercent", "memoryPercent", "diskPercent"):
            self.assertIsInstance(telemetry[key], float)
        for key in ("memoryTotalBytes", "diskTotalBytes", "uptimeSeconds"):
            self.assertIsInstance(telemetry[key], int)
        self.assertTrue(item["lastSeenAt"].endswith("Z") and telemetry["collectedAt"].endswith("Z"))

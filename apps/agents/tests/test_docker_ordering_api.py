"""Out-of-order Docker reports through the agent endpoint, and what the console then shows."""

import json
from datetime import timedelta

from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.console.tests.helpers import ConsoleDataTestCase, make_user
from apps.infrastructure.models import DockerContainer, DockerHostState, Server
from apps.inventory.models import Customer, Site


class DockerOrderingApiTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        self.acme = Customer.objects.create(name="Acme")
        self.globex = Customer.objects.create(name="Globex")
        self.acme_site = Site.objects.create(customer=self.acme, name="HQ")
        self.globex_site = Site.objects.create(customer=self.globex, name="Plant")
        self.web = Server.objects.create(name="web", hostname="web.internal", site=self.acme_site)
        self.db = Server.objects.create(name="db", hostname="db.internal", site=self.globex_site)
        _, self.web_token = create_agent(server=self.web, name="web-agent")
        _, self.db_token = create_agent(server=self.db, name="db-agent")
        self.url = reverse("agent-heartbeat")

    def ago(self, seconds):
        return (self.now - timedelta(seconds=seconds)).isoformat()

    def heartbeat(self, token, body):
        response = self.client.post(
            self.url, data=json.dumps(body), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def docker(self, *containers, collected_ago=0, **overrides):
        return {"docker": valid_docker(collected_at=self.ago(collected_ago), containers=list(containers), **overrides)}

    def listed(self, user, server):
        response = self.get(user, "containers/", server=str(server.pk), pageSize=200)
        self.assertEqual(response.status_code, 200, response.content)
        return {item["container"]["name"]: item["status"] for item in response.json()["items"]}

    def test_a_late_older_report_is_acknowledged_as_rejected_and_changes_nothing(self):
        up = valid_container(name="app", container_id="a" * 64)
        self.assertEqual(self.heartbeat(self.web_token, self.docker(up, collected_ago=0))["docker"], "accepted")
        before = list(DockerContainer.objects.values())
        host = DockerHostState.objects.values().get(server=self.web)
        answer = self.heartbeat(
            self.web_token,
            {**self.docker(valid_container(name="app", container_id="a" * 64, state="dead"), collected_ago=45), "telemetry": valid_telemetry()},
        )
        self.assertEqual(answer["docker"], "rejected")
        self.assertEqual(answer["docker_detail"], "report is not newer than the inventory already stored")
        self.assertEqual(answer["telemetry"], "accepted")  # the subsystems are independent
        self.assertEqual(list(DockerContainer.objects.values()), before)
        self.assertEqual(DockerHostState.objects.values().get(server=self.web), host)

    def test_a_rejected_report_still_counts_as_a_heartbeat(self):
        self.heartbeat(self.web_token, self.docker(valid_container(), collected_ago=0))
        late = self.now + timedelta(seconds=30)
        timezone.now.return_value = late
        self.heartbeat(self.web_token, self.docker(collected_ago=300))  # older than the stored report
        self.web.refresh_from_db()
        self.assertEqual(self.web.last_seen_at, late)  # liveness is not a subsystem
        host = DockerHostState.objects.get(server=self.web)
        self.assertEqual(host.received_at, self.now)  # the inventory was not refreshed by it

    def test_the_console_keeps_showing_the_newer_inventory(self):
        user = make_user("ops", all_customers=True)
        running = valid_container(name="app", container_id="a" * 64, state="running", health="healthy")
        self.heartbeat(self.web_token, self.docker(running, collected_ago=0))
        self.assertEqual(self.listed(user, self.web), {"app": "healthy"})
        stale = self.docker(valid_container(name="app", container_id="a" * 64, state="dead"), valid_container(name="ghost", container_id="b" * 64), collected_ago=90)
        self.assertEqual(self.heartbeat(self.web_token, stale)["docker"], "rejected")
        self.assertEqual(self.listed(user, self.web), {"app": "healthy"})

    def test_a_newer_report_still_removes_a_container_that_is_gone(self):
        user = make_user("ops", all_customers=True)
        both = self.docker(valid_container(name="app", container_id="a" * 64), valid_container(name="job", container_id="b" * 64), collected_ago=60)
        self.heartbeat(self.web_token, both)
        timezone.now.return_value = self.now + timedelta(seconds=30)
        answer = self.heartbeat(self.web_token, {"docker": valid_docker(collected_at=(self.now + timedelta(seconds=30)).isoformat(), containers=[valid_container(name="app", container_id="a" * 64)])})
        self.assertEqual(answer["docker"], "accepted")
        self.assertFalse(DockerContainer.objects.get(container_id="b" * 64).present)
        self.assertEqual(self.listed(user, self.web), {"app": "healthy"})

    def test_reports_are_ordered_per_server_and_never_across_tenants(self):
        self.heartbeat(self.web_token, self.docker(valid_container(name="web-app", container_id="a" * 64), collected_ago=0))
        # Another tenant's agent, with a timestamp older than the web server's report: its own inventory is empty, so it applies.
        answer = self.heartbeat(self.db_token, self.docker(valid_container(name="db-app", container_id="a" * 64), collected_ago=600))
        self.assertEqual(answer["docker"], "accepted")
        self.assertEqual(DockerContainer.objects.get(server=self.web).name, "web-app")
        self.assertEqual(DockerContainer.objects.get(server=self.db).name, "db-app")
        # ... and a late older report of the db agent leaves the web server's inventory (and the db's newer one) alone.
        self.assertEqual(self.heartbeat(self.db_token, self.docker(collected_ago=900))["docker"], "rejected")
        self.assertEqual(DockerContainer.objects.get(server=self.web).name, "web-app")
        self.assertEqual(DockerContainer.objects.get(server=self.db).name, "db-app")

    def test_a_restricted_console_user_only_sees_the_inventory_of_their_own_site(self):
        acme_user = make_user("acme", customers=[self.acme])
        globex_user = make_user("globex", customers=[self.globex])
        self.heartbeat(self.web_token, self.docker(valid_container(name="web-app", container_id="a" * 64), collected_ago=0))
        self.heartbeat(self.db_token, self.docker(valid_container(name="db-app", container_id="b" * 64), collected_ago=0))
        self.heartbeat(self.web_token, self.docker(collected_ago=100))  # rejected: older
        self.assertEqual(self.listed(acme_user, self.web), {"web-app": "healthy"})
        self.assertEqual(self.listed(acme_user, self.db), {})  # another tenant's server: as if it had no containers
        self.assertEqual(self.get(acme_user, f"servers/{self.db.pk}/").status_code, 404)
        self.assertEqual(self.listed(globex_user, self.db), {"db-app": "healthy"})
        self.assertEqual(self.listed(globex_user, self.web), {})
        self.assertEqual(self.get(globex_user, f"servers/{self.web.pk}/").status_code, 404)

    def test_the_existing_responses_are_unchanged(self):
        self.assertEqual(self.heartbeat(self.web_token, self.docker(valid_container()))["docker"], "accepted")
        invalid = self.heartbeat(self.web_token, {"docker": {"version": 99}})
        self.assertEqual(invalid["docker"], "rejected")
        self.assertIn("unsupported docker version", invalid["docker_detail"])
        self.assertNotIn("docker", self.heartbeat(self.web_token, {}))

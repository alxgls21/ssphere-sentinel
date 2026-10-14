"""What the server sees when the agent leaves its Docker report out of a heartbeat.

A report that cannot fit a request even alone (with the telemetry) is never cut
down, never split and never sent: the agent leaves it out of the heartbeat and
tells its own log (``agent/heartbeat.py``). The server then simply gets
heartbeats without a ``docker`` section, so the inventory it holds is not
touched at all; it keeps its last-known values, ages like any inventory that is
not refreshed, and the console shows its containers as ``unknown`` once it is
older than ``SENTINEL_OFFLINE_THRESHOLD``. A report that fits again applies
like any newer one.
"""

import json
from datetime import timedelta

from django.conf import settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.console.tests.helpers import ConsoleDataTestCase, make_user
from apps.infrastructure.models import DockerContainer, DockerHostState, Server
from apps.inventory.models import Customer, Site


class DockerOmissionApiTests(ConsoleDataTestCase):
    def setUp(self):
        super().setUp()
        site = Site.objects.create(customer=Customer.objects.create(name="Acme"), name="HQ")
        self.server = Server.objects.create(name="web", hostname="web.internal", site=site)
        _, self.token = create_agent(server=self.server, name="web-agent")
        self.url = reverse("agent-heartbeat")
        self.user = make_user("ops", all_customers=True)
        self.threshold = settings.SENTINEL_OFFLINE_THRESHOLD
        self.elapsed = 0

    def at(self, seconds):
        timezone.now.return_value = self.now + timedelta(seconds=seconds)
        return timezone.now.return_value

    def heartbeat(self, **sections):
        response = self.client.post(
            self.url, data=json.dumps(sections), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def report(self, *containers, at=0):
        return valid_docker(collected_at=(self.now + timedelta(seconds=at)).isoformat(), containers=list(containers))

    def listed(self):
        response = self.get(self.user, "containers/", server=str(self.server.pk), pageSize=200)
        self.assertEqual(response.status_code, 200, response.content)
        return {item["container"]["name"]: item["status"] for item in response.json()["items"]}

    def seed(self):
        app = valid_container(name="app", container_id="a" * 64, state="running", health="healthy")
        job = valid_container(name="job", container_id="b" * 64, state="running", health="healthy")
        self.assertEqual(self.heartbeat(docker=self.report(app, job))["docker"], "accepted")
        return app, job

    def omit_for(self, seconds, step=30):
        """Heartbeats with telemetry but no Docker report, every ``step`` seconds, for ``seconds`` more."""
        for _ in range(seconds // step):
            self.elapsed += step
            self.at(self.elapsed)
            answer = self.heartbeat(telemetry=valid_telemetry(collected_at=timezone.now().isoformat()))
            self.assertNotIn("docker", answer)

    def test_heartbeats_without_the_report_leave_the_inventory_as_it_was(self):
        self.seed()
        host = DockerHostState.objects.values().get()
        containers = list(DockerContainer.objects.order_by("container_id").values())
        self.omit_for(120)
        self.assertEqual(DockerHostState.objects.values().get(), host)
        self.assertEqual(list(DockerContainer.objects.order_by("container_id").values()), containers)
        self.server.refresh_from_db()
        self.assertEqual(self.server.last_seen_at, self.now + timedelta(seconds=120))  # the liveness went on

    def test_the_inventory_ages_in_the_console_and_keeps_its_last_known_values(self):
        self.seed()
        self.assertEqual(self.listed(), {"app": "healthy", "job": "healthy"})
        self.omit_for(self.threshold - self.threshold % 30)
        self.assertEqual(self.listed(), {"app": "healthy", "job": "healthy"})  # still within the threshold
        self.omit_for(60)
        self.assertEqual(self.listed(), {"app": "unknown", "job": "unknown"})
        self.assertEqual(set(DockerContainer.objects.values_list("state", flat=True)), {"running"})
        self.assertEqual(DockerContainer.objects.filter(present=True).count(), 2)

    def test_a_report_that_fits_again_makes_it_current_and_a_smaller_one_removes_what_is_gone(self):
        app, _ = self.seed()
        self.omit_for(self.threshold + 30)
        self.assertEqual(self.listed(), {"app": "unknown", "job": "unknown"})
        at = self.elapsed + 30
        self.at(at)
        answer = self.heartbeat(docker=self.report(app, at=at))
        self.assertEqual(answer["docker"], "accepted")
        self.assertEqual(self.listed(), {"app": "healthy"})
        self.assertFalse(DockerContainer.objects.get(container_id="b" * 64).present)
        self.assertEqual(DockerHostState.objects.get().collected_at, self.now + timedelta(seconds=at))

    def test_the_omission_does_not_count_as_docker_activity_for_the_ordering_of_the_next_report(self):
        app, _ = self.seed()
        stored = DockerHostState.objects.get().collected_at
        self.omit_for(60)
        older = self.heartbeat(docker=self.report(app, at=-30))
        self.assertEqual(older["docker"], "rejected")
        self.assertEqual(DockerHostState.objects.get().collected_at, stored)

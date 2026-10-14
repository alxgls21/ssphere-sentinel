"""A heartbeat that carries only an ``snmp`` section.

The agent sends one when its queued polls do not fit next to the telemetry,
Docker and network sections of a heartbeat (``agent/snmp_delivery.py``): the
other sections go in a request of their own and the polls follow in this one.
The view applies a section only if the request has it, so everything those
sections own has to stay exactly as the first request left it; the one thing
this request refreshes is the liveness that every heartbeat records.
"""

import json
import uuid
from datetime import timedelta
from io import StringIO

from django.core.management import call_command
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.agents.models import Agent
from apps.agents.services import create_agent
from apps.agents.tests.test_docker_api import valid_container, valid_docker
from apps.agents.tests.test_telemetry_api import valid_telemetry
from apps.infrastructure.models import (
    DockerContainer,
    DockerHostState,
    Server,
    ServerTelemetry,
    ServerTelemetrySample,
)
from apps.network.models import NetworkMeasurement, NetworkTarget
from apps.network.tests.test_api import valid_measurement
from apps.snmp.models import DevicePoll
from apps.snmp.tests.helpers import make_device, poll, report

LIVENESS = {"last_seen_at", "status", "updated_at"}


@override_settings(SENTINEL_DOCKER_ABSENT_CONTAINER_RETENTION_DAYS=30)
class SnmpOnlyHeartbeatTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.url = reverse("agent-heartbeat")
        self.server = Server.objects.create(name="edge-1", hostname="edge-1.local")
        self.agent, self.token = create_agent(server=self.server, name="edge-agent")
        self.device = make_device(self.agent)
        self.target = NetworkTarget.objects.create(
            name="dns", hostname_or_ip="1.1.1.1", protocol=NetworkTarget.Protocol.TCP, port=443, assigned_agent=self.agent
        )
        self.now = timezone.now()

    def post(self, body):
        response = self.client.post(
            self.url, data=json.dumps(body), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {self.token}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def ago(self, **delta):
        return (self.now - timedelta(**delta)).isoformat()

    def seed(self):
        """The heartbeat that carries everything but the polls."""
        answer = self.post(
            {
                "telemetry": valid_telemetry(),
                "docker": valid_docker(
                    containers=[
                        valid_container(container_id="a" * 64, name="web"),
                        valid_container(container_id="b" * 64, name="worker", state="exited"),
                    ]
                ),
                "network": {"version": 1, "measurements": [valid_measurement(target_id=str(self.target.id))]},
            }
        )
        self.assertEqual((answer["telemetry"], answer["docker"], answer["network"]), ("accepted",) * 3)

    def snapshot(self):
        """Everything the other sections own, and the rows of the server and the agent without their liveness."""

        def without_liveness(queryset):
            return [{key: value for key, value in row.items() if key not in LIVENESS} for row in queryset.values()]

        return {
            "server": without_liveness(Server.objects.filter(pk=self.server.pk)),
            "agent": without_liveness(Agent.objects.filter(pk=self.agent.pk)),
            "docker_host": list(DockerHostState.objects.values()),
            "containers": list(DockerContainer.objects.order_by("container_id").values()),
            "telemetry": list(ServerTelemetry.objects.values()),
            "samples": list(ServerTelemetrySample.objects.order_by("sampled_at").values("sampled_at", "cpu_percent")),
            "network": list(NetworkMeasurement.objects.order_by("measured_at").values()),
        }

    def test_the_polls_are_stored_and_nothing_the_other_sections_own_changes(self):
        self.seed()
        before = self.snapshot()
        answer = self.post({"snmp": report([poll(self.device)])})
        self.assertEqual((answer["snmp"], answer["snmp_created"]), ("accepted", 1))
        self.assertEqual(set(answer) & {"telemetry", "docker", "network", "detail", "docker_detail"}, set())
        self.assertEqual(DevicePoll.objects.count(), 1)
        self.assertEqual(self.snapshot(), before)

    def test_it_records_the_liveness_every_heartbeat_records(self):
        self.seed()
        stale = self.now - timedelta(hours=2)
        Agent.objects.filter(pk=self.agent.pk).update(last_seen_at=stale)
        Server.objects.filter(pk=self.server.pk).update(last_seen_at=stale, status=Server.Status.OFFLINE)
        self.post({"snmp": report([poll(self.device)])})
        self.agent.refresh_from_db()
        self.server.refresh_from_db()
        self.assertGreater(self.agent.last_seen_at, stale + timedelta(hours=1))
        self.assertEqual(self.server.status, Server.Status.ONLINE)

    def test_a_section_the_server_rejects_changes_nothing_else_either(self):
        self.seed()
        before = self.snapshot()
        answer = self.post({"snmp": report([poll(self.device, poll_id=uuid.uuid4(), device_id=str(uuid.uuid4()))])})
        self.assertEqual((answer["snmp"], answer["snmp_rejected"]), ("rejected", 1))
        self.assertEqual(DevicePoll.objects.count(), 0)
        self.assertEqual(self.snapshot(), before)

    def test_the_docker_inventory_is_neither_cleared_nor_marked_absent(self):
        self.seed()
        before = {row["container_id"]: row for row in DockerContainer.objects.values()}
        self.post({"snmp": report([poll(self.device)])})
        after = {row["container_id"]: row for row in DockerContainer.objects.values()}
        self.assertEqual(after, before)
        self.assertEqual({row["present"] for row in after.values()}, {True})

    def test_the_telemetry_is_not_overwritten_and_not_made_fresher(self):
        self.seed()
        telemetry = ServerTelemetry.objects.values().get()
        samples = ServerTelemetrySample.objects.count()
        self.post({"snmp": report([poll(self.device)])})
        self.assertEqual(ServerTelemetry.objects.values().get(), telemetry)
        self.assertEqual(ServerTelemetrySample.objects.count(), samples)

    def test_docker_ordering_is_decided_by_the_last_docker_report_alone(self):
        self.seed()
        stored = DockerHostState.objects.get().collected_at
        self.post({"snmp": report([poll(self.device)])})
        older = self.post({"docker": valid_docker(collected_at=(stored - timedelta(seconds=30)).isoformat())})
        duplicate = self.post({"docker": valid_docker(collected_at=stored.isoformat())})
        newer = self.post({"docker": valid_docker(collected_at=(stored + timedelta(seconds=30)).isoformat())})
        self.assertEqual((older["docker"], duplicate["docker"], newer["docker"]), ("rejected", "rejected", "accepted"))

    def test_it_does_not_count_as_docker_activity_for_the_recovery_of_a_clock_that_stepped_back(self):
        # The inventory has been silent for ten minutes, so a plausible older report is let through
        # (a clock that stepped back). The recovery looks at the last Docker report only: had this
        # request refreshed it, the older report below would be refused as a late one.
        self.seed()
        silent = timezone.now() - timedelta(minutes=10)
        DockerHostState.objects.update(received_at=silent)
        stored = DockerHostState.objects.get().collected_at
        self.post({"snmp": report([poll(self.device)])})
        self.assertEqual(DockerHostState.objects.get().received_at, silent)
        recovered = self.post({"docker": valid_docker(collected_at=(stored - timedelta(seconds=5)).isoformat())})
        self.assertEqual(recovered["docker"], "accepted")

    def test_the_retention_of_absent_containers_is_unaffected(self):
        self.seed()
        long_ago = timezone.now() - timedelta(days=45)
        DockerContainer.objects.filter(container_id="b" * 64).update(present=False, last_seen_at=long_ago)
        eligible = set(DockerContainer.objects.filter(present=False, last_seen_at__lt=long_ago + timedelta(days=1)).values_list("pk", flat=True))
        self.post({"snmp": report([poll(self.device)])})
        self.assertEqual(
            set(DockerContainer.objects.filter(present=False, last_seen_at__lt=long_ago + timedelta(days=1)).values_list("pk", flat=True)),
            eligible,
        )
        out = StringIO()
        call_command("purge_absent_docker_containers", stdout=out, stderr=out)
        self.assertIn("Deleted 1 absent container(s)", out.getvalue())
        self.assertEqual(list(DockerContainer.objects.values_list("container_id", flat=True)), ["a" * 64])

    def test_the_network_measurements_are_not_touched(self):
        self.seed()
        measurements = list(NetworkMeasurement.objects.values())
        self.post({"snmp": report([poll(self.device)])})
        self.assertEqual(list(NetworkMeasurement.objects.values()), measurements)

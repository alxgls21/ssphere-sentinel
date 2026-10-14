"""The agent's SNMP batches against the real server's request-size limit.

The agent's own queue, delivery and HTTP client send heartbeats over HTTP to a
live server, which enforces Django's ``DATA_UPLOAD_MAX_MEMORY_SIZE`` itself.
The batches are valid, and within the byte budget the agent applies to the
stored form of a report, but their request bodies (every non-ASCII character
as a ``\\u`` escape, the other sections of the heartbeat) are larger. The agent
fits them to ``MAX_REQUEST_BYTES``, counted in the bytes it sends, and a poll
that does not fit next to the other sections goes in a request of its own. See
``agent/tests/test_snmp_request_budget.py`` for the same scenarios against a
fake server and ``agent/tests/test_snmp_request_delivery.py`` for the arithmetic.
"""

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.test import LiveServerTestCase
from django.utils import timezone

from agent import http_client
from agent.config import Config
from agent.http_client import MAX_REQUEST_BYTES
from agent.tests.request_budget_helpers import (
    EMOJI,
    GREEK,
    Harness,
    agent_logs,
    docker_filling,
    docker_section,
    text_poll,
)
from apps.agents.models import Agent
from apps.agents.tests.test_docker_api import valid_container
from apps.infrastructure.models import DockerContainer, DockerHostState, ServerTelemetry
from apps.snmp.models import DevicePoll
from apps.snmp.tests.helpers import make_agent, make_device


class AgentRequestBudgetEndToEndTests(LiveServerTestCase):
    def setUp(self):
        self.agent_row, token = make_agent("budget-agent")
        self.devices = [
            make_device(self.agent_row, f"core-{index}", management_address=f"192.0.2.{index + 10}") for index in range(3)
        ]
        self.agent = Harness()
        self.addCleanup(self.agent.close)
        self.config = Config(sentinel_url=self.live_server_url, agent_token=token)
        self.logs = self.enterContext(agent_logs())

    def polls(self, interfaces):
        """One poll of long Greek text per device, a few minutes apart (the server accepts recent polls)."""
        now = timezone.now()
        return [
            text_poll(
                interfaces,
                GREEK,
                device_id=str(device.pk),
                measured_at=(now - timedelta(minutes=10 * (index + 1))).isoformat(),
            )
            for index, device in enumerate(self.devices)
        ]

    def assert_stored_and_online(self, ids, **sections):
        self.agent.drain(self.config, cycles=8, **sections)
        self.assertEqual((self.agent.errors, self.agent.queue.snmp_count()), ([], 0))
        self.assertEqual(
            sorted(str(poll_id) for poll_id in DevicePoll.objects.values_list("id", flat=True)), sorted(ids)
        )
        self.assertIsNotNone(Agent.objects.get(pk=self.agent_row.pk).last_seen_at)

    def test_the_same_kind_of_polls_in_a_smaller_batch_are_stored(self):
        # The control: the polls are valid for the server, and only the size of the request is at issue.
        polls = self.polls(100)
        self.assert_stored_and_online(self.agent.enqueue(*polls))
        self.assertEqual(self.agent.mono.now, 700, "one heartbeat was enough")

    def test_a_batch_within_the_agents_budget_but_not_the_servers_is_stored(self):
        polls = self.polls(436)  # 3 x 436 interfaces: 990 KB queued, 2.67 MB as sent
        self.assert_stored_and_online(self.agent.enqueue(*polls))

    def test_the_other_sections_of_the_heartbeat_do_not_make_it_too_large(self):
        polls = self.polls(400)  # 2.46 MB as sent: fits alone, not next to 800 containers
        docker = docker_section(800)
        docker["collected_at"] = timezone.now().isoformat()
        self.assert_stored_and_online(self.agent.enqueue(*polls), docker=lambda: docker)

    def test_a_poll_that_does_not_fit_next_to_the_docker_inventory_goes_in_a_request_of_its_own(self):
        # The most the server accepts of a Docker report (1,000 containers, the longest names and
        # images) leaves less room than this poll takes (about 1.8 MB as sent), which fits alone.
        containers = [
            {
                "container_id": uuid.uuid4().hex + uuid.uuid4().hex,
                "name": f"c{index}-".ljust(255, "n"),
                "image": "registry.example.com/".ljust(512, "i"),
                "state": "running",
                "health": "healthy",
                "created_at": "2026-10-01T10:00:00+00:00",
                "started_at": "2026-10-12T10:00:00+00:00",
            }
            for index in range(1000)
        ]
        docker = {**docker_section(0), "containers": containers, "collected_at": timezone.now().isoformat()}
        (poll,) = self.polls(450)[:1]
        poll["interfaces"] = [dict(entry, name=EMOJI * 128, descr=EMOJI * 128, alias=EMOJI * 64) for entry in poll["interfaces"]]
        sizes = []
        real_open = http_client._opener.open

        def recording(request, timeout=None):
            sizes.append(len(request.data))
            return real_open(request, timeout=timeout)

        with patch.object(http_client._opener, "open", side_effect=recording):
            self.assert_stored_and_online(self.agent.enqueue(poll), docker=lambda: docker)

        self.assertEqual(len(sizes), 2)
        self.assertLess(sizes[0], MAX_REQUEST_BYTES)
        self.assertGreater(sizes[0] + sizes[1], MAX_REQUEST_BYTES)  # together they would not have fitted
        self.assertLessEqual(max(sizes), MAX_REQUEST_BYTES)
        # The request of its own left the other sections as the first request made them.
        self.assertEqual(DockerContainer.objects.filter(present=True).count(), 1000)
        self.assertEqual(DockerContainer.objects.count(), 1000)
        self.assertEqual(DockerHostState.objects.get().collected_at.isoformat(), docker["collected_at"])
        self.assertEqual(ServerTelemetry.objects.count(), 1)

    def test_a_docker_report_too_large_to_send_is_left_out_and_the_stored_inventory_is_not_touched(self):
        now = timezone.now()
        app = valid_container(container_id="a" * 64, name="app")
        job = valid_container(container_id="b" * 64, name="job")
        first = {**docker_section(0), "containers": [app, job], "collected_at": (now - timedelta(minutes=5)).isoformat()}
        self.agent.cycle(self.config, docker=lambda: first)
        host = DockerHostState.objects.values().get()
        containers = list(DockerContainer.objects.order_by("container_id").values())
        self.assertEqual((host["collected_at"].isoformat(), len(containers)), (first["collected_at"], 2))

        too_large = docker_filling(MAX_REQUEST_BYTES + 1)  # what no request can carry: the server never sees it
        polls = self.polls(5)
        sizes = []
        real_open = http_client._opener.open

        def recording(request, timeout=None):
            sizes.append(len(request.data))
            return real_open(request, timeout=timeout)

        with patch.object(http_client._opener, "open", side_effect=recording):
            for poll in polls:
                self.agent.enqueue(poll)
                self.agent.cycle(self.config, docker=lambda: too_large)

        self.assertEqual(self.agent.errors, [])  # the heartbeats themselves succeeded
        self.assertEqual(len(sizes), 3)
        self.assertLessEqual(max(sizes), MAX_REQUEST_BYTES)
        self.assertEqual(len([m for m in self.logs if m.startswith("ERROR") and "Docker report" in m]), 3)
        self.assertEqual(DevicePoll.objects.count(), 3)  # the other sections went on
        self.assertEqual(DockerHostState.objects.values().get(), host)
        self.assertEqual(list(DockerContainer.objects.order_by("container_id").values()), containers)

        # The report fits again (one container fewer): it applies like any newer one.
        smaller = {**first, "containers": [app], "collected_at": now.isoformat()}
        self.agent.cycle(self.config, docker=lambda: smaller)
        self.assertEqual(self.agent.errors, [])
        self.assertEqual(DockerHostState.objects.get().collected_at, now)
        self.assertEqual(
            {row.container_id: row.present for row in DockerContainer.objects.all()}, {"a" * 64: True, "b" * 64: False}
        )

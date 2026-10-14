"""The size of the heartbeat that is actually sent, section by section.

No request is larger than ``MAX_REQUEST_BYTES``, measured in the bytes that go
out, and none is sent that would be. The telemetry and the Docker report (live
snapshots, never cut down) make the first request; the queued sections, the
network batch and then the SNMP polls, join it while it fits and otherwise go in
a request of their own. Nothing is dropped to make room for something else.
A section that does not fit a request even alone is the one thing that cannot
be sent: a Docker report is left out of the heartbeat (loudly), anything else
fails the heartbeat before it is sent, and nothing queued is touched.
"""

import json
import random
import unittest
import urllib.error
from unittest.mock import patch

from agent import heartbeat, http_client
from agent.config import Config
from agent.errors import RequestTooLargeError
from agent.http_client import MAX_REQUEST_BYTES, post_json, size_with_member
from agent.network_delivery import DeliveryBatch
from agent.snmp_delivery import SNMP_ONLY_REQUEST_BYTES, SnmpBatch
from agent.tests.request_budget_helpers import (
    DEL,
    EMOJI,
    GREEK,
    TELEMETRY,
    FakeSentinel,
    Harness,
    agent_logs,
    docker_filling,
    docker_section,
    pad_poll,
    short_poll,
    text_poll,
    wire_size,
)

CONFIG = Config(sentinel_url="https://sentinel.example.com", agent_token="not-a-real-token")


class LimitTestCase(unittest.TestCase):
    snmp = True
    network = False

    def setUp(self):
        self.agent = Harness(snmp=self.snmp, network=self.network)
        self.addCleanup(self.agent.close)
        self.server = FakeSentinel()
        self.enterContext(self.server.installed())
        self.logs = self.enterContext(agent_logs())

    def sections(self):
        """The sections each request carried."""
        return [set(json.loads(body)) for body in self.server.bodies]

    def logged(self, level, text=""):
        return [message for message in self.logs if message.startswith(level) and text in message]

    def assert_every_request_within_the_limit(self):
        for body in self.server.bodies:
            self.assertLessEqual(len(body), MAX_REQUEST_BYTES)
        self.assertEqual(self.server.refused, 0)

    def networked_docker(self, total, measurements=5):
        """Queue ``measurements`` and size the Docker report so that the telemetry, it and them make ``total`` bytes."""
        self.agent.enqueue_measurements(measurements)
        network = self.agent.network_delivery.prepare_batch().section()
        return docker_filling(total, network=network)


class DockerAtTheLimitTests(LimitTestCase):
    """A heartbeat of the telemetry and the Docker report: whole up to ``MAX_REQUEST_BYTES``, out above it."""

    def test_a_heartbeat_of_exactly_the_limit_keeps_the_docker_report(self):
        docker = docker_filling(MAX_REQUEST_BYTES)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual([len(body) for body in self.server.bodies], [MAX_REQUEST_BYTES])
        self.assertEqual(self.sections(), [{"telemetry", "docker"}])
        self.assertEqual(json.loads(self.server.bodies[0])["docker"], docker)
        self.assertEqual(self.logged("ERROR"), [])

    def test_one_byte_more_leaves_the_report_out_whole(self):
        docker = docker_filling(MAX_REQUEST_BYTES + 1)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.sections(), [{"telemetry"}])
        self.assertEqual(self.agent.errors, [])  # the heartbeat itself went on
        self.assertEqual(len(self.logged("ERROR", "The Docker report cannot be sent")), 1)
        self.assert_every_request_within_the_limit()

    def test_the_empty_snmp_section_does_not_take_room_from_it(self):
        # Without polls queued there is no section to reserve room for.
        docker = docker_filling(MAX_REQUEST_BYTES)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.sections(), [{"telemetry", "docker"}])


class DockerAtTheLimitWithoutSnmpTests(DockerAtTheLimitTests):
    """The same for an agent that does not poll SNMP: there is no section that could be reserved for."""

    snmp = False


class DockerAtTheLimitWithPollsTests(LimitTestCase):
    """The same, with SNMP polls queued: they take what the report leaves, or follow in a request of their own."""

    def test_polls_that_do_not_fit_next_to_it_follow_in_a_request_of_their_own(self):
        docker = docker_filling(MAX_REQUEST_BYTES)
        poll = short_poll(5)
        (poll_id,) = self.agent.enqueue(poll)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"snmp"}])
        self.assertEqual(len(self.server.bodies[0]), MAX_REQUEST_BYTES)
        self.assertEqual(self.server.stored, [poll_id])
        self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assert_every_request_within_the_limit()

    def test_one_byte_more_and_polls_queued_leaves_the_report_out_and_sends_the_polls(self):
        docker = docker_filling(MAX_REQUEST_BYTES + 1)
        (poll_id,) = self.agent.enqueue(short_poll(5))
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.server.stored, [poll_id])
        self.assertNotIn("docker", set().union(*self.sections()))
        self.assert_every_request_within_the_limit()


class CombinedSectionsTests(LimitTestCase):
    """The telemetry, the Docker report and the network batch that each fit but not together."""

    network = True

    def test_all_three_in_one_request_up_to_the_limit(self):
        docker = self.networked_docker(MAX_REQUEST_BYTES)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual([len(body) for body in self.server.bodies], [MAX_REQUEST_BYTES])
        self.assertEqual(self.sections(), [{"telemetry", "docker", "network"}])
        self.assertEqual(self.logged("WARNING"), [])

    def test_one_byte_more_and_the_network_batch_follows_in_a_request_of_its_own(self):
        docker = self.networked_docker(MAX_REQUEST_BYTES + 1)
        ids = [item["measurement_id"] for item in self.agent.network_delivery.prepare_batch().measurements]
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"network"}])
        self.assertEqual(json.loads(self.server.bodies[0])["docker"], docker)  # the report was not given up
        self.assertEqual(self.server.network_stored, ids)
        self.assertEqual(self.agent.queue.count(), 0)  # acknowledged
        self.assertEqual(self.logged("ERROR"), [])
        self.assertEqual(len(self.logged("WARNING", "request of their own")), 1)
        self.assertEqual(len(self.logged("WARNING")), 1)  # the first request did not touch a batch it did not carry
        self.assertEqual(self.agent.network_delivery.backoff_remaining, 0)
        self.assert_every_request_within_the_limit()

    def test_every_queued_section_progresses_in_every_heartbeat(self):
        docker = docker_filling(MAX_REQUEST_BYTES - 10)  # nothing else fits next to it
        self.agent.enqueue_measurements(5)
        poll_ids = self.agent.enqueue(short_poll(5))
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"network"}, {"snmp"}])
        self.assertEqual((self.agent.queue.count(), self.agent.queue.snmp_count()), (0, 0))
        self.assertEqual(self.server.stored, poll_ids)
        self.assert_every_request_within_the_limit()

    def test_repeated_heartbeats_starve_nothing(self):
        docker = docker_filling(MAX_REQUEST_BYTES - 10)
        for cycle in range(5):
            self.agent.enqueue_measurements(3)
            self.agent.enqueue(short_poll(5))
            self.agent.cycle(CONFIG, docker=lambda: docker)
            self.assertEqual((self.agent.queue.count(), self.agent.queue.snmp_count()), (0, 0), f"cycle {cycle}")
        self.assertEqual(len(self.server.network_stored), 15)
        self.assertEqual(len(self.server.stored), 5)
        for sections in (self.sections()[index : index + 3] for index in range(0, 15, 3)):
            self.assertEqual(sections, [{"telemetry", "docker"}, {"network"}, {"snmp"}])
        self.assert_every_request_within_the_limit()

    def test_the_three_causes_are_told_apart_in_the_log(self):
        # 1. A Docker report that does not fit even with the telemetry: an error, and it is out.
        self.agent.beat(CONFIG, docker=lambda: docker_filling(MAX_REQUEST_BYTES + 5))
        self.assertEqual(len(self.logged("ERROR", "The Docker report cannot be sent")), 1)
        self.assertEqual(self.logged("WARNING", "request of their own"), [])
        self.logs.clear()
        # 2. Sections that fit alone but not together: the queued one gets a request of its own (a warning).
        docker = self.networked_docker(MAX_REQUEST_BYTES + 1)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.logged("ERROR"), [])
        self.assertEqual(len(self.logged("WARNING", "network measurements")), 1)
        self.logs.clear()
        # 3. The polls make it too large: they get a request of their own (information, not an error).
        self.agent.enqueue(short_poll(5))
        self.agent.beat(CONFIG, docker=lambda: docker_filling(MAX_REQUEST_BYTES))
        self.assertEqual(self.logged("ERROR") + self.logged("WARNING"), [])
        self.assertEqual(len(self.logged("INFO", "SNMP polls do not fit")), 1)

    def test_a_failed_request_of_its_own_keeps_the_measurements_and_backs_off(self):
        docker = self.networked_docker(MAX_REQUEST_BYTES + 1)
        self.server.fail_when = lambda body: 502 if set(body) == {"network"} else None
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.agent.errors, ["server returned HTTP 502"])
        self.assertEqual(self.agent.queue.count(), 5)
        self.assertGreater(self.agent.network_delivery.backoff_remaining, 0)
        self.assertEqual(self.server.network_stored, [])


class IndependentSecondaryRequestsTests(LimitTestCase):
    """The network batch and the SNMP polls that each go in a request of their own do not depend on each other.

    Each has its own queue and its own backoff (``NetworkDelivery`` and ``SnmpDelivery`` share no state), so a
    request that fails costs the others nothing: every one is attempted, then the first failure is raised.
    """

    network = True
    NETWORK_FAILS = staticmethod(lambda status: lambda body: status if set(body) == {"network"} else None)
    SNMP_FAILS = staticmethod(lambda status: lambda body: status if set(body) == {"snmp"} else None)

    def setUp(self):
        super().setUp()
        self.docker = docker_filling(MAX_REQUEST_BYTES - 10)  # nothing else fits next to it

    def queue_both(self, measurements=5):
        measurement_ids = self.agent.enqueue_measurements(measurements)
        (poll_id,) = self.agent.enqueue(short_poll(5))
        return measurement_ids, poll_id

    def beat(self):
        self.agent.beat(CONFIG, docker=lambda: self.docker)

    def cycle(self, step=700):
        self.agent.beat(CONFIG, docker=lambda: self.docker)
        self.agent.mono.now += step
        self.agent.wall.now += step

    def test_a_network_failure_does_not_stop_the_snmp_request(self):
        measurement_ids, poll_id = self.queue_both()
        self.server.fail_when = self.NETWORK_FAILS(502)
        self.beat()
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"network"}, {"snmp"}])
        self.assertEqual(self.agent.errors, ["server returned HTTP 502"])
        self.assertEqual(self.server.stored, [poll_id])  # F: what was acknowledged stays acknowledged
        self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assertEqual((self.agent.queue.count(), self.server.network_stored), (5, []))
        self.assertGreater(self.agent.network_delivery.backoff_remaining, 0)
        self.assertEqual(self.agent.delivery.backoff_remaining, 0)  # no backoff is shared
        self.assert_every_request_within_the_limit()

    def test_an_snmp_failure_does_not_undo_the_network_delivery(self):
        measurement_ids, poll_id = self.queue_both()
        self.server.fail_when = self.SNMP_FAILS(503)
        self.beat()
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"network"}, {"snmp"}])
        self.assertEqual(self.agent.errors, ["server returned HTTP 503"])
        self.assertEqual(self.server.network_stored, measurement_ids)  # F
        self.assertEqual(self.agent.queue.count(), 0)
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))
        self.assertGreater(self.agent.delivery.backoff_remaining, 0)
        self.assertEqual(self.agent.network_delivery.backoff_remaining, 0)
        # What went through is not sent again: only the poll is retried.
        self.server.fail_when = None
        self.server.bodies.clear()
        self.agent.mono.now += 700
        self.beat()
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"snmp"}])
        self.assertEqual(self.agent.queue.snmp_count(), 0)

    def test_both_failing_independently_keeps_both_queues_and_raises_the_first_failure(self):
        measurement_ids, poll_id = self.queue_both()
        statuses = {frozenset({"network"}): 502, frozenset({"snmp"}): 503}
        self.server.fail_when = lambda body: statuses.get(frozenset(body))
        self.beat()
        self.assertEqual(self.sections(), [{"telemetry", "docker"}, {"network"}, {"snmp"}])
        self.assertEqual(self.agent.errors, ["server returned HTTP 502"])  # the first one is the error
        self.assertTrue(self.logged("WARNING", "Another request of this heartbeat failed too: server returned HTTP 503"))
        self.assertEqual((self.agent.queue.count(), self.agent.queue.snmp_count()), (5, 1))
        self.assertEqual(self.server.network_stored + self.server.stored, [])
        self.assertGreater(self.agent.network_delivery.backoff_remaining, 0)
        self.assertGreater(self.agent.delivery.backoff_remaining, 0)

    def test_a_network_that_keeps_failing_never_starves_the_snmp_polls(self):
        self.server.fail_when = self.NETWORK_FAILS(502)
        self.agent.enqueue_measurements(5)
        polls = [short_poll(5) for _ in range(8)]
        for poll in polls:
            self.agent.enqueue(poll)
            self.cycle()
            self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assertEqual(self.server.stored, [poll["poll_id"] for poll in polls])
        self.assertEqual(len(self.agent.errors), 8)
        self.assertEqual(self.agent.queue.count(), 5)  # nothing of it was acknowledged
        self.assertEqual(sum(1 for sections in self.sections() if sections == {"network"}), 8)
        self.assert_every_request_within_the_limit()
        # The network recovers: its measurements go out, once.
        self.server.fail_when = None
        self.cycle()
        self.assertEqual(self.agent.queue.count(), 0)
        self.assertEqual(len(self.server.network_stored), 5)

    def test_a_snmp_that_keeps_failing_never_starves_the_network_batch(self):
        self.server.fail_when = self.SNMP_FAILS(503)
        self.agent.enqueue(short_poll(5))
        delivered = []
        for _ in range(6):
            delivered += self.agent.enqueue_measurements(2)
            self.cycle()
        self.assertEqual(self.server.network_stored, delivered)
        self.assertEqual(self.agent.queue.count(), 0)
        self.assertEqual(self.agent.queue.snmp_count(), 1)

    def test_a_long_heartbeat_interval_does_not_starve_the_polls(self):
        # Backoff is capped at 600 s, so with heartbeats every 600 s or more it is over at each one.
        for step in (600, 900, 3600):
            with self.subTest(interval=step):
                agent = Harness(network=True)
                self.addCleanup(agent.close)
                self.agent = agent
                self.server.stored.clear()
                self.server.bodies.clear()
                self.server.fail_when = self.NETWORK_FAILS(502)
                agent.enqueue_measurements(3)
                polls = [short_poll(5) for _ in range(10)]
                for poll in polls:
                    agent.enqueue(poll)
                    self.cycle(step)
                    self.assertEqual(agent.queue.snmp_count(), 0)
                self.assertEqual(self.server.stored, [poll["poll_id"] for poll in polls])
                self.assertEqual(sum(1 for sections in self.sections() if sections == {"network"}), 10)

    def test_timeouts_and_connection_errors_do_not_prevent_the_other_request(self):
        failures = {
            "timeout": TimeoutError("timed out"),
            "connection": urllib.error.URLError(ConnectionRefusedError("refused")),
        }
        for name, failure in failures.items():
            with self.subTest(failing="network", failure=name):
                agent = Harness(network=True)
                self.addCleanup(agent.close)
                self.agent = agent
                self.server.stored.clear()
                self.server.bodies.clear()
                self.server.fail_when = lambda body, failure=failure: failure if set(body) == {"network"} else None
                _, poll_id = self.queue_both()
                self.beat()
                self.assertEqual(self.server.stored, [poll_id])
                self.assertEqual(len(agent.errors), 1)
                self.assertEqual(agent.queue.count(), 5)
                self.assertGreater(agent.network_delivery.backoff_remaining, 0)
                self.assertEqual(agent.delivery.backoff_remaining, 0)
            with self.subTest(failing="snmp", failure=name):
                agent = Harness(network=True)
                self.addCleanup(agent.close)
                self.agent = agent
                self.server.network_stored.clear()
                self.server.bodies.clear()
                self.server.fail_when = lambda body, failure=failure: failure if set(body) == {"snmp"} else None
                measurement_ids, _ = self.queue_both()
                self.beat()
                self.assertEqual(self.server.network_stored, measurement_ids)
                self.assertEqual(len(agent.errors), 1)
                self.assertEqual(agent.queue.snmp_count(), 1)
                self.assertGreater(agent.delivery.backoff_remaining, 0)
                self.assertEqual(agent.network_delivery.backoff_remaining, 0)

    def test_a_failed_first_request_attempts_neither_of_the_others(self):
        self.queue_both()
        self.server.fail_when = lambda body: 500
        self.beat()
        self.assertEqual(self.sections(), [{"telemetry", "docker"}])
        self.assertEqual((self.agent.queue.count(), self.agent.queue.snmp_count()), (5, 1))


class EmptyBaseTests(LimitTestCase):
    """Nothing but polls to send (the collectors failed): there is no object to add a member to, so no ``", "``."""

    @staticmethod
    def failing():
        raise RuntimeError("collector failed")

    def test_the_polls_make_the_whole_request_up_to_the_limit(self):
        for size, one_request in ((MAX_REQUEST_BYTES, True), (MAX_REQUEST_BYTES + 1, False)):
            with self.subTest(request_bytes=size):
                agent = Harness()
                self.addCleanup(agent.close)
                self.server.bodies.clear()
                self.server.stored.clear()
                self.logs.clear()
                poll = text_poll(1, GREEK)
                (poll_id,) = agent.enqueue(pad_poll(poll, size - SNMP_ONLY_REQUEST_BYTES))
                agent.drain(CONFIG, cycles=2, collect=self.failing, docker=self.failing)
                if one_request:
                    self.assertEqual([len(body) for body in self.server.bodies], [MAX_REQUEST_BYTES])
                    self.assertEqual(self.sections(), [{"snmp"}])
                    self.assertEqual(self.server.stored, [poll_id])
                else:  # more than a request can hold, even alone: given up, and said so
                    self.assertEqual(self.server.stored, [])
                    self.assertEqual(agent.queue.snmp_count(), 0)
                    self.assertTrue(self.logged("ERROR", poll_id))


class RepeatedOmissionTests(LimitTestCase):
    def test_a_report_that_stays_too_large_is_left_out_every_time_and_the_rest_goes_on(self):
        too_large = docker_filling(MAX_REQUEST_BYTES + 500_000)
        for _ in range(4):
            self.agent.enqueue(short_poll(5))
            self.agent.cycle(CONFIG, docker=lambda: too_large)
        self.assertEqual(self.sections(), [{"telemetry", "snmp"}] * 4)
        self.assertEqual(len(self.logged("ERROR", "The Docker report cannot be sent")), 4)
        self.assertEqual(len(self.server.stored), 4)
        self.assertEqual(self.agent.errors, [])
        self.assert_every_request_within_the_limit()

    def test_the_report_goes_out_again_as_soon_as_it_fits(self):
        too_large = docker_filling(MAX_REQUEST_BYTES + 1)
        smaller = docker_section(3)
        self.agent.cycle(CONFIG, docker=lambda: too_large)
        self.agent.cycle(CONFIG, docker=lambda: too_large)
        self.logs.clear()
        self.agent.cycle(CONFIG, docker=lambda: smaller)
        self.assertEqual(self.sections(), [{"telemetry"}, {"telemetry"}, {"telemetry", "docker"}])
        self.assertEqual(json.loads(self.server.bodies[-1])["docker"], smaller)
        self.assertEqual(self.logged("ERROR"), [])  # nothing is remembered about the omissions

    def test_the_report_is_judged_afresh_at_every_heartbeat(self):
        sizes = [MAX_REQUEST_BYTES + 1, MAX_REQUEST_BYTES, MAX_REQUEST_BYTES + 1, MAX_REQUEST_BYTES - 1]
        for total in sizes:
            docker = docker_filling(total)
            self.agent.cycle(CONFIG, docker=lambda: docker)
        self.assertEqual(
            [("docker" in section) for section in self.sections()], [False, True, False, True]
        )


class RequestGuardTests(LimitTestCase):
    """The last line: a body over ``MAX_REQUEST_BYTES`` is never sent, whatever built it."""

    def test_the_http_client_sends_exactly_the_limit_and_refuses_one_byte_more(self):
        shell = len(b'{"pad": ""}')
        at_the_limit = {"pad": "x" * (MAX_REQUEST_BYTES - shell)}
        post_json("https://sentinel.example.com/x/", payload=at_the_limit)
        self.assertEqual([len(body) for body in self.server.bodies], [MAX_REQUEST_BYTES])
        over = {"pad": "x" * (MAX_REQUEST_BYTES - shell + 1)}
        with self.assertRaises(RequestTooLargeError) as raised:
            post_json("https://sentinel.example.com/x/", payload=over)
        self.assertIn(str(MAX_REQUEST_BYTES + 1), str(raised.exception))
        self.assertEqual(len(self.server.bodies), 1)  # nothing was sent for it

    def test_an_oversized_telemetry_section_fails_the_heartbeat_before_anything_is_sent(self):
        self.agent.enqueue(short_poll(5))
        huge = {"blob": "x" * MAX_REQUEST_BYTES}
        self.agent.beat(CONFIG, collect=lambda: huge)
        self.assertEqual(self.server.bodies, [])
        (message,) = self.agent.errors
        for expected in ("over the limit", str(MAX_REQUEST_BYTES), "telemetry=", "nothing was sent"):
            self.assertIn(expected, message)

    def test_the_polls_are_untouched_and_nothing_backs_off_because_the_heartbeat_was_too_large(self):
        (poll_id,) = self.agent.enqueue(short_poll(5))
        huge = {"blob": "x" * MAX_REQUEST_BYTES}
        self.agent.beat(CONFIG, collect=lambda: huge)
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))
        self.assertEqual(self.agent.delivery.backoff_remaining, 0)
        self.agent.beat(CONFIG)  # the cause is gone: the next heartbeat delivers as usual
        self.assertEqual(self.server.stored, [poll_id])

    def test_leaving_the_docker_report_out_does_not_help_when_the_rest_is_too_large(self):
        huge = {"blob": "x" * MAX_REQUEST_BYTES}
        self.agent.beat(CONFIG, collect=lambda: huge, docker=lambda: docker_filling(MAX_REQUEST_BYTES))
        self.assertEqual(self.server.bodies, [])
        self.assertEqual(len(self.agent.errors), 1)
        self.assertIn("even without the Docker report", self.agent.errors[0])

    def test_the_request_of_a_telemetry_section_just_under_the_limit_is_sent_with_the_docker_report_out(self):
        padding = MAX_REQUEST_BYTES - wire_size({"telemetry": {"blob": ""}})
        almost = {"blob": "x" * padding}
        self.agent.beat(CONFIG, collect=lambda: almost, docker=lambda: docker_section(2))
        self.assertEqual([len(body) for body in self.server.bodies], [MAX_REQUEST_BYTES])
        self.assertEqual(self.sections(), [{"telemetry"}])
        self.assertEqual(len(self.logged("ERROR", "The Docker report cannot be sent")), 1)

    def test_a_network_section_that_cannot_fit_even_alone_fails_the_heartbeat_before_sending(self):
        huge = {"version": 1, "measurements": [{"measurement_id": "m1", "blob": "x" * MAX_REQUEST_BYTES}]}
        self.agent.beat(CONFIG, network=lambda: huge)
        self.assertEqual(len(self.agent.errors), 1)
        self.assertIn("the network section is", self.agent.errors[0])
        self.assertIn("nothing was sent", self.agent.errors[0])
        self.assertEqual(self.server.bodies, [])

    def test_a_size_that_the_planning_got_wrong_is_still_stopped_before_sending(self):
        # Defence in depth: the sections are measured exactly, but if that ever disagreed with the bytes
        # that are built, the check on the bytes themselves stops the request.
        agent = Harness(network=True)
        self.addCleanup(agent.close)
        docker = docker_filling(MAX_REQUEST_BYTES - 10)
        agent.enqueue_measurements(5)
        agent.enqueue(short_poll(5))
        with patch.object(heartbeat, "size_with_member", return_value=0):
            agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.server.bodies, [])
        self.assertEqual(len(agent.errors), 1)
        self.assertIn("nothing was sent", agent.errors[0])
        self.assertEqual((agent.queue.count(), agent.queue.snmp_count()), (5, 1))
        self.assertEqual((agent.network_delivery.backoff_remaining, agent.delivery.backoff_remaining), (0, 0))

    def test_a_request_of_its_own_with_polls_is_stopped_the_same_way(self):
        poll = text_poll(1, GREEK)
        poll["interfaces"][0]["name"] = DEL * 700_000  # 4.2 MB as sent
        (poll_id,) = self.agent.enqueue(poll)
        batch = SnmpBatch((poll,))
        with self.assertRaises(RequestTooLargeError):
            heartbeat._exchange(
                CONFIG,
                {"snmp": batch.section()},
                timeout=None,
                network_delivery=None,
                network_batch=DeliveryBatch(),
                snmp_delivery=self.agent.delivery,
                snmp_batch=batch,
            )
        self.assertEqual(self.server.bodies, [])
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))
        self.assertEqual(self.agent.delivery.backoff_remaining, 0)

    def test_http_failures_keep_their_backoff(self):
        # The guard is not an HTTP failure and must not change how one is handled.
        (poll_id,) = self.agent.enqueue(short_poll(5))
        self.server.fail_when = lambda body: 503
        self.agent.beat(CONFIG)
        self.assertEqual(self.agent.errors, ["server returned HTTP 503"])
        self.assertGreater(self.agent.delivery.backoff_remaining, 0)
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))


class SizeArithmeticTests(unittest.TestCase):
    """``size_with_member``: the size of an object with one more member, without serializing it again."""

    def test_it_is_exact_for_any_object_key_and_value(self):
        rng = random.Random(20261014)
        scripts = ("a", GREEK, "界", EMOJI, DEL, '"', "\\", "\n", "\x01")
        values = (None, True, 0, -1.5, 10**20, "", [], {}, [1, "b"], {"n": [None]})

        def text():
            return "".join(rng.choice(scripts) for _ in range(rng.randint(0, 12)))

        for _ in range(500):
            base = {text(): rng.choice(values) for _ in range(rng.randint(0, 4))}
            key, value = text() + "k", rng.choice(values + (text(), [text()], {text(): text()}))
            if key in base:
                continue
            expected = wire_size({**base, key: value})
            self.assertEqual(size_with_member(wire_size(base), bool(base), key, wire_size(value)), expected, (base, key, value))

    def test_it_is_exact_for_the_sections_of_a_heartbeat(self):
        main = {"telemetry": TELEMETRY, "docker": docker_section(3)}
        for key, section in (("network", {"version": 1, "measurements": []}), ("snmp", {"version": 1, "polls": [short_poll(2)]})):
            self.assertEqual(
                size_with_member(wire_size(main), True, key, wire_size(section)), wire_size({**main, key: section})
            )
        self.assertEqual(size_with_member(wire_size({}), False, "snmp", 5), wire_size({"snmp": "xxx"}))

    def test_the_limit_is_what_it_was_approved_as(self):
        self.assertEqual(MAX_REQUEST_BYTES, 2_500_000)
        self.assertIs(http_client.MAX_REQUEST_BYTES, MAX_REQUEST_BYTES)

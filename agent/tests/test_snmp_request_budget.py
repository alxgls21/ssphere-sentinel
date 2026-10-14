"""The SNMP byte budget against the request body that is really sent.

The queue measures a poll as compact UTF-8 JSON (``ensure_ascii=False``) and
the report budget sums those sizes; the HTTP client sends ``json.dumps`` with
its defaults: every non-ASCII character as a ``\\u`` escape (a Greek letter
costs 6 bytes instead of 2, an emoji 12 instead of 4) and a space after every
``,`` and ``:``. The other sections of the heartbeat are not counted at all.
The server refuses a body over Django's ``DATA_UPLOAD_MAX_MEMORY_SIZE``
(2.5 MiB) with HTTP 400, before it records even the liveness of the agent.

The scenarios stay inside the budget the agent applies today (a stored report
of at most ``STORED_BUDGET`` bytes) and are valid for the server.
"""

import unittest

from agent.config import Config
from agent.heartbeat import build_heartbeat_payload
from agent.tests.request_budget_helpers import (
    ASCII,
    CJK,
    CONTROL,
    DEL,
    EMOJI,
    GREEK,
    QUOTE,
    SERVER_LIMIT,
    STORED_BUDGET,
    TELEMETRY,
    FakeSentinel,
    Harness,
    agent_logs,
    docker_for_request,
    docker_section,
    short_poll,
    stored_size,
    text_poll,
    wire_size,
)

CONFIG = Config(sentinel_url="https://sentinel.example.com", agent_token="not-a-real-token")


class RequestBudgetTestCase(unittest.TestCase):
    def setUp(self):
        self.agent = Harness()
        self.addCleanup(self.agent.close)
        self.server = FakeSentinel()
        self.enterContext(self.server.installed())
        self.logs = self.enterContext(agent_logs())

    def assert_delivered(self, ids, *, cycles=8, **sections):
        """Every poll is stored exactly once, no request was refused, and none was over the server's limit."""
        sent = self.agent.drain(CONFIG, cycles=cycles, **sections)
        self.assertEqual(self.agent.queue.snmp_count(), 0, f"{sent} heartbeat(s) left polls queued: {self.agent.errors}")
        self.assertEqual(sorted(self.server.stored), sorted(ids))
        self.assertEqual((self.server.refused, self.agent.errors), (0, []))
        self.assertLessEqual(self.server.largest_body, SERVER_LIMIT)

    def assert_inside_the_agents_budget_but_not_the_servers(self, polls, *, other_bytes=0):
        """Guards the scenario itself: it fits what the agent budgets, and its request is over the limit."""
        self.assertLessEqual(sum(stored_size(poll) for poll in polls), STORED_BUDGET)
        body = build_heartbeat_payload(
            collect_fn=lambda: TELEMETRY,
            docker_fn=lambda: docker_section(0),
            snmp_fn=lambda: {"version": 1, "polls": polls},
        )
        self.assertGreater(wire_size(body) + other_bytes, SERVER_LIMIT)


class WhatTheBytesCostTests(RequestBudgetTestCase):
    """The two encodings, measured on the request that is really sent."""

    def request_size(self, **system):
        harness = Harness()
        self.addCleanup(harness.close)
        poll = short_poll(1)
        poll["system"] = system
        harness.enqueue(poll)
        harness.cycle(CONFIG)
        return stored_size(poll), len(self.server.bodies[-1])

    def test_a_character_costs_what_its_class_says_in_the_queue_and_on_the_wire(self):
        base_stored, base_wire = self.request_size(descr="")
        costs = {
            ASCII: (1, 1),
            QUOTE: (2, 2),  # escaped the same way in both encodings
            CONTROL: (6, 6),
            GREEK: (2, 6),
            CJK: (3, 6),
            EMOJI: (4, 12),
            DEL: (1, 6),  # json.dumps leaves DEL alone unless it is told to be ASCII
        }
        for char, (stored_each, wire_each) in costs.items():
            with self.subTest(char=repr(char)):
                stored, wire = self.request_size(descr=char * 1000)
                self.assertEqual((stored - base_stored) // 1000, stored_each)
                self.assertEqual((wire - base_wire) // 1000, wire_each)

    def test_an_ascii_poll_is_about_a_tenth_larger_on_the_wire_for_the_spaces_after_separators(self):
        poll = short_poll(40)
        stored, wire = self.request_size_of(poll)
        self.assertGreater(wire, stored * 1.05)
        self.assertLess(wire, stored * 1.20)

    def request_size_of(self, poll):
        """``(stored size of the poll, size of the request that carries it and nothing else)``."""
        harness = Harness()
        self.addCleanup(harness.close)
        harness.enqueue(poll)
        harness.cycle(CONFIG)
        request = len(self.server.bodies[-1])
        harness.queue.remove_snmp([poll["poll_id"]])
        harness.cycle(CONFIG)  # the same heartbeat without the section
        return stored_size(poll), request - len(self.server.bodies[-1])


class BatchesFitTheRequestTests(RequestBudgetTestCase):
    """A batch the agent budgets as under 1 MB must not make a request the server refuses."""

    def test_greek_text(self):
        polls = [text_poll(436, GREEK) for _ in range(3)]
        self.assert_inside_the_agents_budget_but_not_the_servers(polls)
        self.assert_delivered(self.agent.enqueue(*polls))

    def test_four_byte_text(self):
        polls = [text_poll(350, EMOJI) for _ in range(2)]
        self.assert_inside_the_agents_budget_but_not_the_servers(polls)
        self.assert_delivered(self.agent.enqueue(*polls))

    def test_the_other_sections_of_the_heartbeat_count_too(self):
        # The SNMP section alone fits the server's limit; the Docker section next to it does not leave room.
        polls = [text_poll(400, GREEK) for _ in range(3)]
        docker = docker_section(800)
        self.assert_inside_the_agents_budget_but_not_the_servers(polls, other_bytes=wire_size(docker))
        self.assertLess(wire_size({"snmp": {"version": 1, "polls": polls}}), SERVER_LIMIT)
        self.assert_delivered(self.agent.enqueue(*polls), docker=lambda: docker)

    def test_the_network_section_counts_too(self):
        polls = [text_poll(400, GREEK) for _ in range(3)]
        measurements = [
            {
                "measurement_id": f"00000000-0000-0000-0000-{index:012d}",
                "target_id": "00000000-0000-0000-0000-00000000ffff",
                "measured_at": "2026-10-12T14:05:00+00:00",
                "success": False,
                "packet_loss_percentage": 100.0,
                "probe_count": 4,
                "successful_probes": 0,
                "failure_reason": "timeout",
            }
            for index in range(100)
        ]
        network = {"version": 1, "measurements": measurements}
        docker = docker_section(550)
        self.assert_inside_the_agents_budget_but_not_the_servers(
            polls, other_bytes=wire_size(docker) + wire_size(network)
        )
        self.assert_delivered(self.agent.enqueue(*polls), docker=lambda: docker, network=lambda: network)

    def test_a_queue_of_many_devices_with_long_text_drains(self):
        # 30 devices, 3,000 interfaces: a first batch of 13 polls is 2.67 MB as sent.
        polls = [text_poll(100, GREEK) for _ in range(30)]
        self.assert_delivered(self.agent.enqueue(*polls), cycles=12)

    def test_a_request_one_byte_over_the_limit_is_never_sent(self):
        self.fill_with_other_sections(SERVER_LIMIT + 1)

    def test_a_request_of_exactly_the_limit_is_accepted(self):
        self.fill_with_other_sections(SERVER_LIMIT)

    def test_a_request_one_byte_under_the_limit_is_accepted(self):
        self.fill_with_other_sections(SERVER_LIMIT - 1)

    def fill_with_other_sections(self, total):
        """The Docker section is sized so that the heartbeat with the poll would be ``total`` bytes long.

        That is more than the agent allows a request (``MAX_REQUEST_BYTES``), so the Docker report is
        left out and the poll goes with the rest; the point is that nothing above the server's limit is sent.
        """
        poll = short_poll(5)
        docker = docker_for_request([poll], total)
        self.assert_delivered(self.agent.enqueue(poll), docker=lambda: docker)


class WhatDoesNotHurtTests(RequestBudgetTestCase):
    """Controls: batches whose request is well inside the limit, and escapes the two encodings treat alike."""

    def test_the_largest_ordinary_batch_goes_in_one_request(self):
        polls = [short_poll(40) for _ in range(50)]  # the most polls a report may hold
        self.assert_delivered(self.agent.enqueue(*polls), cycles=3)

    def test_one_poll_of_the_most_interfaces_with_long_text_goes_alone(self):
        poll = text_poll(512, GREEK, counters=True)
        self.assert_delivered(self.agent.enqueue(poll), cycles=1)

    def test_escaped_characters_and_long_strings_stay_inside_the_limit(self):
        polls = [text_poll(105, QUOTE + CONTROL + "\\\n\t") for _ in range(2)]
        self.assertLessEqual(sum(stored_size(poll) for poll in polls), STORED_BUDGET)
        self.assert_delivered(self.agent.enqueue(*polls), cycles=1)


class UnsendablePollTests(RequestBudgetTestCase):
    """A poll that cannot fit even in an otherwise empty request."""

    def unsendable(self):
        # Valid for the queue (700 KB stored, under the 768 KiB a poll may take) but 4.2 MB as sent.
        poll = text_poll(1, ASCII)
        poll["interfaces"][0]["name"] = DEL * 700_000
        self.assertLess(stored_size(poll), 768 * 1024)
        self.assertGreater(wire_size({"snmp": {"version": 1, "polls": [poll]}}), SERVER_LIMIT)
        return poll

    def test_it_does_not_hold_back_the_polls_queued_behind_it(self):
        bad = self.unsendable()
        good = [short_poll(10) for _ in range(2)]
        ids = self.agent.enqueue(bad, *good)
        self.agent.drain(CONFIG, cycles=8)
        self.assertEqual(sorted(self.server.stored), sorted(poll["poll_id"] for poll in good))
        self.assertEqual(self.agent.queue.snmp_count(), 0, "the unsendable poll was retried instead of being given up")
        self.assertEqual(self.server.refused, 0, "a request that cannot be accepted was sent")
        self.assertTrue(any(ids[0] in message for message in self.logs), "giving up on a poll must be logged")

    def test_it_is_not_retried_for_ever(self):
        self.agent.enqueue(self.unsendable())
        self.agent.drain(CONFIG, cycles=8)
        self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assertEqual(self.server.refused, 0)

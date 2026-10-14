"""How SNMP polls are fitted into requests, sent, kept or given up.

The request budget (``MAX_REQUEST_BYTES``) and the SNMP section budget
(``MAX_REPORT_BYTES``) are measured in the bytes of the request that is sent;
a poll that does not fit next to the other sections of the heartbeat goes in a
request of its own; a poll no request can carry is dropped, loudly, without
holding back the ones behind it; and a failed request never costs a poll.
"""

import json
import unittest
import urllib.error
from unittest.mock import patch

from agent import http_client
from agent.config import Config
from agent.heartbeat import send_heartbeat
from agent.http_client import MAX_REQUEST_BYTES, encode_json, encoded_size, post_json
from agent.measurement_queue import QueueError
from agent.snmp_delivery import EMPTY_SECTION_BYTES, SNMP_ONLY_REQUEST_BYTES, request_size_with_empty_section
from agent.snmp_payload import MAX_REPORT_BYTES
from agent.tests.request_budget_helpers import (
    ASCII,
    CJK,
    CONTROL,
    DEL,
    EMOJI,
    GREEK,
    QUOTE,
    SERVER_LIMIT,
    TELEMETRY,
    FakeSentinel,
    Harness,
    agent_logs,
    docker_for_request,
    docker_section,
    pad_poll,
    short_poll,
    text_poll,
    wire_size,
)

CONFIG = Config(sentinel_url="https://sentinel.example.com", agent_token="not-a-real-token")


class DeliveryTestCase(unittest.TestCase):
    def setUp(self):
        self.agent = Harness()
        self.addCleanup(self.agent.close)
        self.server = FakeSentinel()
        self.enterContext(self.server.installed())
        self.logs = self.enterContext(agent_logs())

    def requests(self):
        return [json.loads(body) for body in self.server.bodies]

    def polls_per_request(self):
        return [[poll["poll_id"] for poll in request.get("snmp", {}).get("polls", [])] for request in self.requests()]

    def docker_leaving(self, room):
        """A Docker section that leaves ``room`` bytes in a request for polls, next to the telemetry."""
        return docker_for_request([], MAX_REQUEST_BYTES - room)

    def assert_every_request_within_the_limit(self):
        for body in self.server.bodies:
            self.assertLessEqual(len(body), MAX_REQUEST_BYTES)
        self.assertEqual(self.server.refused, 0)


class SerializationTests(DeliveryTestCase):
    def test_the_wire_representation_is_the_standard_library_default(self):
        sample = {"name": "Θύρα 1 😀 日本", "values": [1, 2.5, None, True], "nested": {"a": "b"}}
        self.assertEqual(encode_json(sample), json.dumps(sample).encode("utf-8"))
        self.assertEqual(encode_json({"a": "Ω", "b": [1, 2]}), b'{"a": "\\u03a9", "b": [1, 2]}')
        self.assertEqual(encode_json({"e": "😀"}), b'{"e": "\\ud83d\\ude00"}')
        self.assertEqual(encoded_size(sample), len(encode_json(sample)))

    def test_what_is_measured_is_what_is_sent(self):
        payload = {"snmp": {"version": 1, "polls": [text_poll(3, GREEK), text_poll(2, EMOJI)]}}
        with patch.object(http_client._opener, "open", side_effect=self.server.open):
            post_json("https://sentinel.example.com/x/", payload=payload)
        self.assertEqual(self.server.bodies, [encode_json(payload)])
        self.assertEqual(len(self.server.bodies[0]), encoded_size(payload))

    def test_the_constants_are_what_an_empty_section_and_an_empty_request_take(self):
        self.assertEqual(EMPTY_SECTION_BYTES, len(b'{"version": 1, "polls": []}'))
        self.assertEqual(SNMP_ONLY_REQUEST_BYTES, len(b'{"snmp": {"version": 1, "polls": []}}'))
        others = {"telemetry": TELEMETRY, "docker": docker_section(2)}
        self.assertEqual(
            request_size_with_empty_section(encoded_size(others), True),
            len(json.dumps({**others, "snmp": {"version": 1, "polls": []}}).encode("utf-8")),
        )
        self.assertEqual(request_size_with_empty_section(encoded_size({}), False), SNMP_ONLY_REQUEST_BYTES)

    def test_the_polls_add_their_own_sizes_and_a_separator_to_the_request_whatever_the_script(self):
        others = {"telemetry": TELEMETRY, "docker": docker_section(5)}
        base = len(json.dumps({**others, "snmp": {"version": 1, "polls": []}}).encode("utf-8"))
        for char in (ASCII, GREEK, CJK, EMOJI, DEL, QUOTE + CONTROL + "\\\n"):
            for count in (1, 2, 3):
                with self.subTest(char=repr(char), polls=count):
                    polls = [text_poll(7, char) for _ in range(count)]
                    request = len(json.dumps({**others, "snmp": {"version": 1, "polls": polls}}).encode("utf-8"))
                    own = sum(len(json.dumps(poll).encode("utf-8")) for poll in polls)
                    self.assertEqual(request, base + own + 2 * (count - 1))

    def test_every_request_sent_is_exactly_as_large_as_the_delivery_measured_it(self):
        for char in (ASCII, GREEK, CJK, EMOJI, DEL):
            with self.subTest(char=repr(char)):
                harness = Harness()
                self.addCleanup(harness.close)
                harness.enqueue(*[text_poll(150, char) for _ in range(6)])
                self.server.bodies.clear()
                harness.drain(CONFIG, cycles=12)
                self.assertEqual(harness.queue.snmp_count(), 0)
                others = {"telemetry": TELEMETRY, "docker": docker_section(0)}
                base = request_size_with_empty_section(encoded_size(others), True)
                for body in self.server.bodies:
                    polls = json.loads(body)["snmp"]["polls"]
                    own = sum(encoded_size(poll) for poll in polls)
                    self.assertEqual(len(body), base + own + 2 * (len(polls) - 1))


class SectionBudgetTests(DeliveryTestCase):
    """``MAX_REPORT_BYTES``: the bytes of the ``snmp`` section as sent."""

    def polls_filling_the_section(self, extra):
        """Three polls whose section is ``MAX_REPORT_BYTES + extra`` bytes long, the last padded to fit."""
        first, second = text_poll(512, ASCII), text_poll(512, ASCII)
        used = EMPTY_SECTION_BYTES + wire_size(first) + wire_size(second) + 2 * 2
        third = pad_poll(text_poll(1, ASCII), MAX_REPORT_BYTES + extra - used)
        section = {"version": 1, "polls": [first, second, third]}
        self.assertEqual(encoded_size(section), MAX_REPORT_BYTES + extra)
        return first, second, third

    def test_a_section_of_exactly_the_budget_is_sent_whole(self):
        polls = self.polls_filling_the_section(0)
        self.agent.enqueue(*polls)
        self.assertEqual(len(self.agent.delivery.prepare_batch().polls), 3)

    def test_one_byte_more_leaves_the_last_poll_for_the_next_request(self):
        polls = self.polls_filling_the_section(1)
        self.agent.enqueue(*polls)
        self.assertEqual(len(self.agent.delivery.prepare_batch().polls), 2)
        self.agent.drain(CONFIG, cycles=4)
        self.assertEqual(self.polls_per_request()[:2], [[p["poll_id"] for p in polls[:2]], [polls[2]["poll_id"]]])

    def test_the_first_poll_may_exceed_the_section_budget_on_its_own(self):
        big = text_poll(512, GREEK, counters=True)  # 1.2 MB as sent
        self.assertGreater(wire_size(big), MAX_REPORT_BYTES)
        self.agent.enqueue(big, short_poll(5))
        batch = self.agent.delivery.prepare_batch()
        self.assertEqual([p["poll_id"] for p in batch.polls], [big["poll_id"]])


class RequestBudgetBoundaryTests(DeliveryTestCase):
    """``MAX_REQUEST_BYTES``: the whole request, to the byte."""

    def heartbeat_of(self, total):
        poll = short_poll(5)
        (poll_id,) = self.agent.enqueue(poll)
        self.agent.beat(CONFIG, docker=lambda: docker_for_request([poll], total))
        return poll_id

    def test_a_heartbeat_of_exactly_the_limit_carries_the_polls(self):
        poll_id = self.heartbeat_of(MAX_REQUEST_BYTES)
        self.assertEqual(len(self.server.bodies), 1)
        self.assertEqual(len(self.server.bodies[0]), MAX_REQUEST_BYTES)
        self.assertEqual(self.polls_per_request(), [[poll_id]])

    def test_one_byte_under_the_limit_carries_the_polls_too(self):
        poll_id = self.heartbeat_of(MAX_REQUEST_BYTES - 1)
        self.assertEqual((len(self.server.bodies), self.polls_per_request()), (1, [[poll_id]]))

    def test_one_byte_over_the_limit_sends_the_polls_in_a_request_of_their_own(self):
        poll_id = self.heartbeat_of(MAX_REQUEST_BYTES + 1)
        self.assertEqual(self.polls_per_request(), [[], [poll_id]])
        self.assertEqual([len(body) <= MAX_REQUEST_BYTES for body in self.server.bodies], [True, True])
        self.assertEqual(self.agent.queue.snmp_count(), 0)

    def test_a_poll_of_exactly_the_limit_goes_out_alone_and_one_byte_more_is_dropped(self):
        for size, sent in ((MAX_REQUEST_BYTES, True), (MAX_REQUEST_BYTES + 1, False)):
            with self.subTest(request_bytes=size):
                harness = Harness()
                self.addCleanup(harness.close)
                self.server.bodies.clear()
                self.server.stored.clear()
                (poll_id,) = harness.enqueue(pad_poll(text_poll(1, ASCII), size - SNMP_ONLY_REQUEST_BYTES))
                harness.drain(CONFIG, cycles=3)
                self.assertEqual((poll_id in self.server.stored, harness.queue.snmp_count()), (sent, 0))
                self.assertEqual(self.server.refused, 0)


class SnmpOnlyRequestTests(DeliveryTestCase):
    def test_a_poll_that_does_not_fit_next_to_the_other_sections_goes_in_a_request_of_its_own(self):
        poll = text_poll(300, GREEK)  # about 630 KB as sent
        docker = self.docker_leaving(500_000)
        (poll_id,) = self.agent.enqueue(poll)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(len(self.server.bodies), 2)
        self.assertEqual((self.server.sections(0), self.server.sections(1)), ({"telemetry", "docker"}, {"snmp"}))
        self.assertEqual(self.polls_per_request(), [[], [poll_id]])
        self.assertEqual((self.agent.errors, self.agent.queue.snmp_count()), ([], 0))
        self.assert_every_request_within_the_limit()

    def test_the_request_of_its_own_takes_what_fits_the_section_budget(self):
        polls = [text_poll(100, GREEK) for _ in range(8)]  # about 210 KB each as sent
        docker = self.docker_leaving(150_000)
        ids = self.agent.enqueue(*polls)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.agent.mono.now += 700
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.polls_per_request(), [[], ids[:4], [], ids[4:]])
        self.assert_every_request_within_the_limit()

    def test_the_polls_that_fit_go_with_the_heartbeat_and_the_rest_wait_for_the_next_one(self):
        small, large = short_poll(5), text_poll(300, GREEK)  # 2.5 KB and 630 KB as sent
        docker = self.docker_leaving(300_000)
        small_id, large_id = self.agent.enqueue(small, large)
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.polls_per_request(), [[small_id]])  # no second request for what did not fit
        self.agent.mono.now += 700
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.polls_per_request(), [[small_id], [], [large_id]])

    def test_one_request_is_enough_when_the_polls_fit(self):
        (poll_id,) = self.agent.enqueue(short_poll(5))
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(500_000))
        self.assertEqual(self.polls_per_request(), [[poll_id]])

    def test_nothing_queued_means_one_request_without_a_section(self):
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(10))
        self.assertEqual(self.polls_per_request(), [[]])
        self.assertEqual(self.server.sections(), {"telemetry", "docker"})

    def test_the_request_of_its_own_carries_nothing_but_the_section(self):
        self.agent.enqueue(text_poll(300, GREEK))
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(500_000))
        body = self.requests()[1]
        self.assertEqual(set(body), {"snmp"})
        self.assertEqual(set(body["snmp"]), {"version", "polls"})

    def test_when_the_first_request_fails_there_is_no_second_one_and_the_polls_stay(self):
        (poll_id,) = self.agent.enqueue(text_poll(300, GREEK))
        self.server.fail_when = lambda body: 500
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(500_000))
        self.assertEqual(len(self.server.bodies), 1)
        self.assertEqual(self.agent.errors, ["server returned HTTP 500"])
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))

    def test_when_the_second_request_fails_the_polls_stay_and_the_section_backs_off(self):
        poll = text_poll(300, GREEK)
        (poll_id,) = self.agent.enqueue(poll)
        docker = self.docker_leaving(500_000)
        self.server.fail_when = lambda body: 503 if set(body) == {"snmp"} else None
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.agent.errors, ["server returned HTTP 503"])
        self.assertEqual((self.agent.queue.snmp_count(), self.agent.queue.snmp_attempts(poll_id)), (1, 0))
        self.assertGreater(self.agent.delivery.backoff_remaining, 0)

        self.server.bodies.clear()
        self.agent.beat(CONFIG, docker=lambda: docker)  # still backing off: the heartbeat goes alone
        self.assertEqual(self.polls_per_request(), [[]])

        self.server.fail_when = None
        self.agent.mono.now += 700
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.polls_per_request()[-1], [poll_id])
        self.assertEqual(self.agent.queue.snmp_count(), 0)

    def test_a_poll_is_acknowledged_only_when_the_server_names_it_stored(self):
        (poll_id,) = self.agent.enqueue(text_poll(300, GREEK))
        docker = self.docker_leaving(500_000)
        self.server.acknowledge = False
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.agent.queue.snmp_count(), 1)  # sent, but never acknowledged
        self.assertEqual(self.agent.queue.snmp_attempts(poll_id), 1)
        self.server.acknowledge = True
        self.agent.mono.now += 700
        self.agent.wall.now += 700
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.agent.queue.snmp_count(), 0)


class OversizedPollTests(DeliveryTestCase):
    def unsendable(self, **ids):
        poll = text_poll(1, ASCII, **ids)
        poll["interfaces"][0]["name"] = DEL * 700_000  # 700 KB stored, 4.2 MB as sent
        return poll

    def test_it_is_logged_as_an_error_with_what_identifies_it_and_the_limits(self):
        bad = self.unsendable()
        self.agent.enqueue(bad)
        self.agent.beat(CONFIG)
        errors = [message for message in self.logs if message.startswith("ERROR")]
        self.assertEqual(len(errors), 1)
        message = errors[0]
        alone = encoded_size({"snmp": {"version": 1, "polls": [bad]}})
        for expected in (bad["poll_id"], bad["device_id"], str(alone), str(MAX_REQUEST_BYTES)):
            self.assertIn(expected, message)

    def test_only_that_poll_is_removed_and_the_others_are_sent_in_their_order(self):
        good = [short_poll(5) for _ in range(3)]
        bad = [self.unsendable(), self.unsendable()]
        ids = self.agent.enqueue(good[0], bad[0], good[1], bad[1], good[2])
        self.agent.drain(CONFIG, cycles=4)
        self.assertEqual(self.server.stored, [good[0]["poll_id"], good[1]["poll_id"], good[2]["poll_id"]])
        self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assertEqual(len([m for m in self.logs if m.startswith("ERROR")]), 2)
        self.assertEqual(self.server.refused, 0)
        self.assertEqual(ids[1] in self.server.stored, False)

    def test_it_never_holds_back_what_is_behind_it(self):
        good = short_poll(5)
        self.agent.enqueue(self.unsendable(), good)
        self.agent.beat(CONFIG)
        self.assertEqual(self.polls_per_request(), [[good["poll_id"]]])

    def test_it_is_reported_once_not_at_every_heartbeat(self):
        self.agent.enqueue(self.unsendable())
        for _ in range(4):
            self.agent.cycle(CONFIG)
        self.assertEqual(len([m for m in self.logs if m.startswith("ERROR")]), 1)

    def test_a_poll_that_fits_a_request_of_its_own_is_not_dropped(self):
        poll = text_poll(300, GREEK)
        self.agent.enqueue(poll)
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(500_000))
        self.assertEqual([m for m in self.logs if m.startswith("ERROR")], [])
        self.assertEqual(self.server.stored, [poll["poll_id"]])

    def test_failing_to_remove_it_is_a_warning_and_the_other_polls_still_go(self):
        good = short_poll(5)
        self.agent.enqueue(self.unsendable(), good)
        with patch.object(self.agent.queue, "remove_snmp", side_effect=QueueError("disk full")):
            self.agent.beat(CONFIG)
        self.assertTrue(any(m.startswith("WARNING") and "disk full" in m for m in self.logs))
        self.assertEqual(self.polls_per_request(), [[good["poll_id"]]])


class OtherSectionsTooLargeTests(DeliveryTestCase):
    def test_a_docker_report_over_the_limit_is_left_out_loudly_and_everything_else_goes(self):
        poll = short_poll(5)
        self.agent.enqueue(poll)
        self.agent.beat(CONFIG, docker=lambda: docker_for_request([poll], MAX_REQUEST_BYTES + 100_000))
        self.assertEqual(self.server.sections(), {"telemetry", "snmp"})
        self.assertEqual(self.server.stored, [poll["poll_id"]])
        self.assertEqual(self.agent.errors, [])
        self.assertEqual(len([m for m in self.logs if m.startswith("ERROR") and "Docker report" in m]), 1)
        self.assert_every_request_within_the_limit()

    def test_a_docker_report_within_the_limit_is_never_left_out(self):
        self.agent.beat(CONFIG, docker=lambda: self.docker_leaving(10))
        self.assertEqual(self.server.sections(), {"telemetry", "docker"})
        self.assertEqual([m for m in self.logs if m.startswith("ERROR")], [])


class HttpFailureTests(DeliveryTestCase):
    FAILURES = {
        "400": 400,
        "401": 401,
        "413": 413,
        "500": 500,
        "502": 502,
        "503": 503,
        "connection": urllib.error.URLError(ConnectionRefusedError("refused")),
        "timeout": TimeoutError("timed out"),
    }

    def test_no_failure_costs_a_poll_or_an_attempt_and_every_one_pauses_the_section(self):
        for name, failure in self.FAILURES.items():
            with self.subTest(failure=name):
                harness = Harness()
                self.addCleanup(harness.close)
                ids = harness.enqueue(*[short_poll(5) for _ in range(3)])
                self.server.fail_when = lambda body, failure=failure: failure
                harness.beat(CONFIG)
                self.assertEqual(len(harness.errors), 1)
                self.assertEqual(harness.queue.snmp_count(), 3)
                self.assertEqual([harness.queue.snmp_attempts(poll_id) for poll_id in ids], [0, 0, 0])
                self.assertGreater(harness.delivery.backoff_remaining, 0)
                self.server.fail_when = None
                harness.mono.now += 700
                harness.drain(CONFIG, cycles=3)
                self.assertEqual(harness.queue.snmp_count(), 0)

    def test_a_refusal_for_size_reports_the_size_of_the_request_that_was_sent(self):
        for status in (400, 413):
            with self.subTest(status=status):
                harness = Harness()
                self.addCleanup(harness.close)
                harness.enqueue(short_poll(5))
                self.server.bodies.clear()
                self.logs.clear()
                self.server.fail_when = lambda body, status=status: status
                harness.beat(CONFIG)
                sent = len(self.server.bodies[0])
                expected = f"HTTP {status} (request body {sent} bytes)"
                self.assertEqual(harness.errors, [f"server returned {expected}"])
                self.assertTrue(any(expected in message for message in self.logs), self.logs)

    def test_other_statuses_do_not_claim_a_size(self):
        self.agent.enqueue(short_poll(5))
        self.server.fail_when = lambda body: 500
        self.agent.beat(CONFIG)
        self.assertEqual(self.agent.errors, ["server returned HTTP 500"])
        self.assertFalse(any("request body" in message for message in self.logs))

    def test_the_size_in_the_message_is_that_of_the_request_of_its_own_when_that_is_the_one_refused(self):
        self.agent.enqueue(text_poll(300, GREEK))
        docker = docker_for_request([], MAX_REQUEST_BYTES - 500_000)
        self.server.fail_when = lambda body: 413 if set(body) == {"snmp"} else None
        self.agent.beat(CONFIG, docker=lambda: docker)
        self.assertEqual(self.agent.errors, [f"server returned HTTP 413 (request body {len(self.server.bodies[1])} bytes)"])
        self.assertEqual(self.agent.queue.snmp_count(), 1)

    def test_the_fake_server_enforces_the_limit_the_real_one_has(self):
        self.assertEqual(self.server.limit, SERVER_LIMIT)
        self.assertLess(MAX_REQUEST_BYTES, SERVER_LIMIT)


class OrderAndRepetitionTests(DeliveryTestCase):
    def test_polls_arrive_in_the_order_they_were_queued_whatever_their_size(self):
        sizes = (5, 300, 40, 95, 10, 250, 60, 95)
        polls = [text_poll(count, GREEK if count > 50 else ASCII) for count in sizes]
        ids = self.agent.enqueue(*polls)
        self.agent.drain(CONFIG, cycles=20, docker=lambda: self.docker_leaving(250_000))
        self.assertEqual(self.agent.queue.snmp_count(), 0)
        self.assertEqual(self.server.stored, ids)
        self.assert_every_request_within_the_limit()

    def test_every_poll_goes_out_once_and_the_requests_stay_within_the_limit_over_many_heartbeats(self):
        polls = [text_poll(300, GREEK) for _ in range(10)]
        ids = self.agent.enqueue(*polls)
        docker = self.docker_leaving(500_000)
        sent = []
        for _ in range(14):
            before = len(self.server.bodies)
            self.agent.cycle(CONFIG, docker=lambda: docker)
            self.assertLessEqual(len(self.server.bodies) - before, 2)
            sent.append(len(self.server.bodies) - before)
        self.assertEqual(self.agent.errors, [])
        self.assertEqual(self.server.stored, ids)
        delivered = [poll_id for request in self.polls_per_request() for poll_id in request]
        self.assertEqual(delivered, ids)  # none twice
        self.assertEqual(sent[:10], [2] * 10)  # one poll a request of its own, as long as there are some
        self.assertEqual(sent[10:], [1] * 4)  # then a heartbeat is a single request again
        self.assert_every_request_within_the_limit()

    def test_a_drained_queue_costs_no_more_requests(self):
        self.agent.enqueue(short_poll(5))
        for _ in range(5):
            self.agent.cycle(CONFIG)
        self.assertEqual(len(self.server.bodies), 5)
        self.assertEqual([len(ids) for ids in self.polls_per_request()], [1, 0, 0, 0, 0])

    def test_a_poll_is_not_resent_after_it_was_acknowledged(self):
        poll = short_poll(5)
        self.agent.enqueue(poll)
        send_heartbeat(
            CONFIG,
            collect_fn=lambda: TELEMETRY,
            docker_fn=lambda: docker_section(0),
            snmp_delivery=self.agent.delivery,
        )
        send_heartbeat(
            CONFIG,
            collect_fn=lambda: TELEMETRY,
            docker_fn=lambda: docker_section(0),
            snmp_delivery=self.agent.delivery,
        )
        self.assertEqual(self.polls_per_request(), [[poll["poll_id"]], []])


class ScriptTests(DeliveryTestCase):
    """Greek, Chinese and emoji text, delivered through requests at the limit."""

    def test_each_script_is_delivered_in_requests_within_the_limit(self):
        for char in (GREEK, CJK, EMOJI):
            with self.subTest(char=repr(char)):
                harness = Harness()
                self.addCleanup(harness.close)
                self.server.bodies.clear()
                self.server.stored.clear()
                ids = harness.enqueue(*[text_poll(400, char) for _ in range(3)])
                harness.drain(CONFIG, cycles=8, docker=lambda: docker_section(800))
                self.assertEqual(self.server.stored, ids)
                self.assertEqual(self.server.refused, 0)
                self.assert_every_request_within_the_limit()

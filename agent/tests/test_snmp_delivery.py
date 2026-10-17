import json
import unittest
import urllib.error
import uuid
from unittest.mock import patch

from agent.acknowledgement import SNMP, parse_acknowledgement
from agent.config import Config
from agent.heartbeat import build_heartbeat_payload, log_subsystem_status, send_heartbeat
from agent.http_client import HttpResponse
from agent.measurement_queue import MeasurementQueue
from agent.network_delivery import NetworkDelivery
from agent.snmp_delivery import SnmpDelivery
from agent.snmp_payload import MAX_INTERFACES_PER_REPORT, MAX_POLLS_PER_REPORT
from agent.tests.queue_helpers import Clock, measurement, poll

A, B, C, D = (f"00000000-0000-0000-0000-00000000000{i}" for i in range(1, 5))


def body(**fields):
    return json.dumps({"status": "ok", **fields})


class AcknowledgementTests(unittest.TestCase):
    def test_created_and_duplicate_are_stored(self):
        ack = parse_acknowledgement(
            body(
                snmp="accepted",
                snmp_results=[{"poll_id": A, "result": "created"}, {"poll_id": B, "result": "duplicate"}],
            ),
            [A, B],
            SNMP,
        )
        self.assertEqual((ack.stored, ack.unresolved, ack.is_batch_failure), ({A, B}, set(), False))

    def test_rejections_are_permanent_or_retryable(self):
        ack = parse_acknowledgement(
            body(
                snmp="partial",
                snmp_results=[
                    {"poll_id": A, "result": "created"},
                    {"poll_id": B, "result": "rejected", "reason": "reachable must be a boolean", "retryable": False},
                    {"poll_id": C, "result": "rejected", "reason": "device is disabled", "retryable": True},
                ],
            ),
            [A, B, C, D],
            SNMP,
        )
        self.assertEqual(ack.stored, {A})
        self.assertEqual(ack.permanent, {B: "reachable must be a boolean"})
        self.assertEqual(ack.retryable, {C: "device is disabled"})
        self.assertEqual(ack.unresolved, {D})

    def test_a_rejection_without_a_flag_is_kept(self):
        ack = parse_acknowledgement(
            body(snmp="rejected", snmp_results=[{"poll_id": A, "result": "rejected", "reason": "x"}]), [A], SNMP
        )
        self.assertEqual((ack.retryable, ack.permanent), ({A: "x"}, {}))

    def test_the_network_keys_are_not_mistaken_for_snmp(self):
        ack = parse_acknowledgement(
            body(network="accepted", network_results=[{"measurement_id": A, "result": "created"}]), [A], SNMP
        )
        self.assertTrue(ack.is_batch_failure)

    def test_the_wrong_id_key_acknowledges_nothing(self):
        ack = parse_acknowledgement(
            body(snmp="accepted", snmp_results=[{"measurement_id": A, "result": "created"}]), [A], SNMP
        )
        self.assertEqual((ack.stored, ack.unresolved), (set(), {A}))

    def test_unhashable_and_malformed_entries_are_ignored(self):
        ack = parse_acknowledgement(
            body(
                snmp="accepted",
                snmp_results=[{"poll_id": [1], "result": "created"}, "x", {"poll_id": A, "result": 5}, {"poll_id": B, "result": "created"}],
            ),
            [A, B],
            SNMP,
        )
        self.assertEqual((ack.stored, ack.unresolved), ({B}, {A}))

    def test_an_envelope_rejection_is_a_batch_failure_with_its_detail(self):
        ack = parse_acknowledgement(body(snmp="rejected", snmp_detail="unsupported snmp version"), [A], SNMP)
        self.assertEqual(ack.batch_failure, "snmp section rejected: unsupported snmp version")
        self.assertEqual(ack.stored, set())

    def test_an_old_server_without_snmp_support_is_a_batch_failure(self):
        ack = parse_acknowledgement(body(telemetry="accepted"), [A], SNMP)
        self.assertEqual(ack.batch_failure, "response has no snmp acknowledgement")

    def test_unknown_status_and_broken_bodies_are_batch_failures(self):
        for text in ("", "not json", "[]", body(snmp="maybe"), body(snmp="accepted", snmp_results="x")):
            with self.subTest(text):
                self.assertTrue(parse_acknowledgement(text, [A], SNMP).is_batch_failure)

    def test_nothing_sent_means_nothing_to_acknowledge(self):
        ack = parse_acknowledgement(body(), [], SNMP)
        self.assertEqual((ack.stored, ack.is_batch_failure), (frozenset(), False))


class MalformedResponseTests(unittest.TestCase):
    """A server (or whatever answers in its place) must never be able to raise out of the parser."""

    def test_non_string_statuses_are_batch_failures(self):
        for status in ([], {}, 5, True, None, [1, 2], {"a": 1}):
            for section, kwargs in (("snmp", {"section": SNMP}), ("network", {})):
                with self.subTest(status=status, section=section):
                    ack = parse_acknowledgement(json.dumps({section: status}), [A], **kwargs)
                    self.assertTrue(ack.is_batch_failure)

    def test_unhashable_ids_in_legacy_network_rejections_are_batch_failures(self):
        for ident in ([1], {"a": 1}, None, 5):
            with self.subTest(ident):
                ack = parse_acknowledgement(
                    json.dumps(
                        {"network": "partial", "network_rejections": [{"measurement_id": ident, "reason": "x"}], "network_accepted": 0}
                    ),
                    [A],
                )
                self.assertTrue(ack.is_batch_failure)

    def test_random_json_never_raises(self):
        import random

        rng = random.Random(1234)
        scalars = [None, True, False, 0, 1, -1, 2**70, 1.5, "", "accepted", "partial", "rejected", A, B, "x" * 50]

        def value(depth=0):
            kind = rng.random()
            if depth > 3 or kind < 0.45:
                return rng.choice(scalars)
            if kind < 0.7:
                return [value(depth + 1) for _ in range(rng.randint(0, 4))]
            keys = ["snmp", "network", "snmp_results", "network_results", "network_rejections", "poll_id", "measurement_id", "result", "reason", "retryable", "network_accepted", "network_created", "network_duplicates", "snmp_detail", "x"]
            return {rng.choice(keys): value(depth + 1) for _ in range(rng.randint(0, 6))}

        for _ in range(3000):
            text = json.dumps(value())
            for section_kwargs in ({}, {"section": SNMP}):
                ack = parse_acknowledgement(text, [A, B], **section_kwargs)
                # whatever the input, ids come out as a consistent partition of what was sent
                self.assertTrue(ack.stored | set(ack.permanent) | set(ack.retryable) | ack.unresolved <= {A, B} or ack.is_batch_failure)


class BackoffOverflowTests(unittest.TestCase):
    """After about a week of failures 2 ** n used to overflow a float and raise."""

    def test_both_deliveries_keep_backing_off_after_thousands_of_failures(self):
        from agent.measurement_queue import MeasurementQueue
        from agent.network_delivery import BATCH_BACKOFF_MAX_SECONDS, DeliveryBatch, NetworkDelivery
        from agent.snmp_delivery import SnmpBatch

        queue = MeasurementQueue(None)
        self.addCleanup(queue.close)
        cases = (
            (NetworkDelivery(queue), DeliveryBatch((measurement(),))),
            (SnmpDelivery(queue), SnmpBatch((poll(),))),
        )
        for delivery, batch in cases:
            with self.subTest(type(delivery).__name__), self.assertLogs("sentinel_agent", level="WARNING"):
                for _ in range(2500):
                    delivery.record_failure(batch, "server down")
                self.assertAlmostEqual(delivery.backoff_remaining, BATCH_BACKOFF_MAX_SECONDS, delta=2)


class DeliveryTestCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.mono = Clock(0.0)
        self.queue = MeasurementQueue(None, wall_fn=self.clock)
        self.delivery = SnmpDelivery(self.queue, time_fn=self.mono)

    def tearDown(self):
        self.queue.close()

    def enqueue(self, number=1, **kwargs):
        items = [poll(**kwargs) for _ in range(number)]
        for item in items:
            self.queue.enqueue_snmp(item)
        return items


class DeliveryTests(DeliveryTestCase):
    def test_nothing_pending_means_an_empty_batch(self):
        batch = self.delivery.prepare_batch()
        self.assertEqual(batch.polls, ())
        self.assertIsNone(self.delivery.acknowledge(batch, body()))

    def test_the_section_has_the_documented_envelope(self):
        (item,) = self.enqueue()
        section = self.delivery.prepare_batch().section()
        self.assertEqual(section["version"], 1)
        self.assertEqual([p["poll_id"] for p in section["polls"]], [item["poll_id"]])

    def test_batches_stay_within_the_servers_limits(self):
        self.enqueue(MAX_POLLS_PER_REPORT + 20, count=1)
        self.assertEqual(len(self.delivery.prepare_batch().polls), MAX_POLLS_PER_REPORT)
        self.queue.close()
        self.queue = MeasurementQueue(None, wall_fn=self.clock)
        self.delivery = SnmpDelivery(self.queue, time_fn=self.mono)
        self.enqueue(10, count=300)
        batch = self.delivery.prepare_batch()
        self.assertLessEqual(sum(len(p["interfaces"]) for p in batch.polls), MAX_INTERFACES_PER_REPORT)
        self.assertEqual(len(batch.polls), 6)

    def test_stored_and_permanently_rejected_polls_leave_the_queue_others_stay(self):
        first, second, third, fourth = self.enqueue(4)
        ids = [p["poll_id"] for p in (first, second, third, fourth)]
        batch = self.delivery.prepare_batch()
        response = body(
            snmp="partial",
            snmp_results=[
                {"poll_id": ids[0], "result": "created"},
                {"poll_id": ids[1], "result": "rejected", "reason": "bad", "retryable": False},
                {"poll_id": ids[2], "result": "rejected", "reason": "not assigned", "retryable": True},
            ],
        )
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self.delivery.acknowledge(batch, response)
        self.assertEqual(self.queue.snmp_count(), 2)
        self.assertEqual(self.queue.snmp_attempts(ids[2]), 1)  # retryable: backed off
        self.assertEqual(self.queue.snmp_attempts(ids[3]), 1)  # not acknowledged: retried
        text = "\n".join(logs.output)
        self.assertIn("permanently rejected", text)
        self.assertIn("will retry", text)

    def test_retried_polls_wait_for_their_backoff(self):
        (item,) = self.enqueue()
        batch = self.delivery.prepare_batch()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.delivery.acknowledge(batch, body(snmp="accepted", snmp_results=[]))
        self.assertEqual(self.delivery.prepare_batch().polls, ())
        self.clock.now += 31
        self.assertEqual(len(self.delivery.prepare_batch().polls), 1)

    def test_a_batch_failure_keeps_everything_and_backs_off_exponentially(self):
        self.enqueue(2)
        batch = self.delivery.prepare_batch()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            ack = self.delivery.acknowledge(batch, body(telemetry="accepted"))
        self.assertTrue(ack.is_batch_failure)
        self.assertEqual(self.queue.snmp_count(), 2)
        self.assertEqual(self.delivery.backoff_remaining, 30)
        self.assertEqual(self.delivery.prepare_batch().polls, ())  # paused
        self.mono.now += 31
        batch = self.delivery.prepare_batch()
        self.assertEqual(len(batch.polls), 2)
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.delivery.record_failure(batch, "HTTP 500")
        self.assertEqual(self.delivery.backoff_remaining, 60)

    def test_backoff_is_capped_and_a_success_resets_it(self):
        (item,) = self.enqueue()
        batch = self.delivery.prepare_batch()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            for _ in range(12):
                self.delivery.record_failure(batch, "down")
        self.assertEqual(self.delivery.backoff_remaining, 600)
        self.mono.now += 601
        self.delivery.acknowledge(
            batch, body(snmp="accepted", snmp_results=[{"poll_id": item["poll_id"], "result": "created"}])
        )
        self.assertEqual(self.delivery.backoff_remaining, 0)
        self.assertEqual(self.queue.snmp_count(), 0)

    def test_an_empty_batch_failure_does_not_back_off(self):
        self.delivery.record_failure(self.delivery.prepare_batch(), "HTTP 500")
        self.assertEqual(self.delivery.backoff_remaining, 0)

    def test_queue_errors_do_not_escape(self):
        self.enqueue()
        batch = self.delivery.prepare_batch()
        self.queue.close()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self.assertEqual(self.delivery.prepare_batch().polls, ())
            self.delivery.acknowledge(
                batch,
                body(snmp="accepted", snmp_results=[{"poll_id": batch.polls[0]["poll_id"], "result": "created"}]),
            )


CONFIG = Config(sentinel_url="https://sentinel.example", agent_token="agent-secret-token")


def beat(delivery=None, network=None, response=None, **kwargs):
    """Send one heartbeat with ``post_json`` patched; return (payload, headers)."""
    seen = {}

    def post(url, *, headers=None, payload=None, timeout=10.0):
        seen["payload"] = payload
        if isinstance(response, BaseException):
            raise response
        return response

    with patch("agent.heartbeat.post_json", side_effect=post):
        send_heartbeat(
            CONFIG,
            collect_fn=lambda: {"version": 1},
            docker_fn=lambda: {"version": 1},
            snmp_delivery=delivery,
            network_delivery=network,
            **kwargs,
        )
    return seen["payload"]


class HeartbeatIntegrationTests(DeliveryTestCase):
    def ok(self, items, **extra):
        return HttpResponse(
            200,
            body(
                snmp="accepted",
                snmp_results=[{"poll_id": item["poll_id"], "result": "created"} for item in items],
                **extra,
            ),
        )

    def test_without_snmp_the_heartbeat_has_no_snmp_section(self):
        self.enqueue()
        payload = beat(response=HttpResponse(200, body()))
        self.assertEqual(set(payload), {"telemetry", "docker"})
        self.assertEqual(self.queue.snmp_count(), 1)  # untouched

    def test_an_empty_queue_adds_no_section(self):
        payload = beat(self.delivery, response=HttpResponse(200, body()))
        self.assertNotIn("snmp", payload)

    def test_queued_polls_are_sent_and_acknowledged(self):
        items = self.enqueue(3)
        payload = beat(self.delivery, response=self.ok(items))
        self.assertEqual(payload["snmp"]["version"], 1)
        self.assertEqual([p["poll_id"] for p in payload["snmp"]["polls"]], [i["poll_id"] for i in items])
        self.assertEqual(self.queue.snmp_count(), 0)

    def test_the_token_and_credentials_are_not_in_the_body(self):
        items = self.enqueue()
        payload = beat(self.delivery, response=self.ok(items))
        self.assertNotIn("agent-secret-token", json.dumps(payload))

    def test_a_transport_error_keeps_the_polls_and_backs_off(self):
        self.enqueue(2)
        with self.assertLogs("sentinel_agent", level="WARNING"), self.assertRaises(urllib.error.URLError):
            beat(self.delivery, response=urllib.error.URLError("refused"))
        self.assertEqual(self.queue.snmp_count(), 2)
        self.assertGreater(self.delivery.backoff_remaining, 0)

    def test_an_http_error_keeps_the_polls_and_backs_off(self):
        from agent.errors import HeartbeatError

        self.enqueue()
        with self.assertLogs("sentinel_agent", level="WARNING"), self.assertRaises(HeartbeatError):
            beat(self.delivery, response=HttpResponse(500, "boom"))
        self.assertEqual(self.queue.snmp_count(), 1)
        self.assertGreater(self.delivery.backoff_remaining, 0)

    def test_while_backing_off_the_heartbeat_continues_without_the_section(self):
        self.enqueue()
        with self.assertLogs("sentinel_agent", level="WARNING"), self.assertRaises(Exception):
            beat(self.delivery, response=HttpResponse(503, ""))
        payload = beat(self.delivery, response=HttpResponse(200, body()))
        self.assertNotIn("snmp", payload)
        self.assertEqual(set(payload), {"telemetry", "docker"})

    def test_a_server_without_snmp_support_keeps_the_polls(self):
        self.enqueue()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            beat(self.delivery, response=HttpResponse(200, body(telemetry="accepted")))
        self.assertEqual(self.queue.snmp_count(), 1)
        self.assertGreater(self.delivery.backoff_remaining, 0)

    def test_snmp_and_network_are_delivered_and_acknowledged_independently(self):
        items = self.enqueue(2)
        network = NetworkDelivery(self.queue)
        measurements = [measurement(), measurement()]
        for item in measurements:
            self.queue.enqueue(item)
        response = HttpResponse(
            200,
            body(
                network="accepted",
                network_results=[{"measurement_id": m["measurement_id"], "result": "created"} for m in measurements],
                snmp="accepted",
                snmp_results=[{"poll_id": items[0]["poll_id"], "result": "created"}],
            ),
        )
        with self.assertLogs("sentinel_agent", level="WARNING"):
            payload = beat(self.delivery, network=network, response=response)
        self.assertEqual(len(payload["network"]["measurements"]), 2)
        self.assertEqual(len(payload["snmp"]["polls"]), 2)
        self.assertEqual(self.queue.count(), 0)  # network acknowledged in full
        self.assertEqual(self.queue.snmp_count(), 1)  # one SNMP poll not acknowledged: kept

    def test_a_failing_snmp_section_does_not_block_network_delivery(self):
        self.enqueue()
        network = NetworkDelivery(self.queue)
        item = measurement()
        self.queue.enqueue(item)
        response = HttpResponse(
            200,
            body(
                network="accepted",
                network_results=[{"measurement_id": item["measurement_id"], "result": "created"}],
                snmp="rejected",
                snmp_detail="unsupported snmp version",
            ),
        )
        with self.assertLogs("sentinel_agent", level="WARNING"):
            beat(self.delivery, network=network, response=response)
        self.assertEqual(self.queue.count(), 0)
        self.assertEqual(self.queue.snmp_count(), 1)

    def test_a_failing_snmp_collection_hook_does_not_break_the_heartbeat(self):
        def broken():
            raise RuntimeError("queue exploded")

        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            payload = build_heartbeat_payload(collect_fn=lambda: {"v": 1}, docker_fn=lambda: {"v": 1}, snmp_fn=broken)
        self.assertEqual(set(payload), {"telemetry", "docker"})
        self.assertIn("SNMP collection failed", "\n".join(logs.output))


class StatusLoggingTests(unittest.TestCase):
    def test_accepted_is_quiet_and_reported(self):
        self.assertEqual(log_subsystem_status(body(snmp="accepted")), {"snmp": "accepted"})

    def test_rejections_are_logged_without_control_characters_and_truncated(self):
        response = body(
            snmp="partial",
            snmp_accepted=1,
            snmp_rejected=7,
            snmp_detail="7 poll(s) rejected\nfirst: x",
            snmp_rejections=[{"poll_id": A, "reason": "bad\x1b[31m" + "x" * 500}] * 7,
        )
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            log_subsystem_status(response)
        text = "\n".join(logs.output)
        self.assertIn("accepted=1, rejected=7", text)
        self.assertNotIn("\x1b", text)
        self.assertIn("2 more SNMP poll rejection(s) not shown", text)
        self.assertEqual(sum("SNMP poll" in line and "rejected:" in line for line in logs.output), 5)

    def test_a_response_without_snmp_reports_nothing_about_it(self):
        self.assertNotIn("snmp", log_subsystem_status(body(telemetry="accepted")))


if __name__ == "__main__":
    unittest.main()

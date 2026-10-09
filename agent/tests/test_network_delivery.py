import json
import unittest
import urllib.error
from unittest.mock import patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse
from agent.measurement_queue import MeasurementQueue
from agent.network_delivery import BATCH_BACKOFF_BASE_SECONDS, NetworkDelivery
from agent.tests.test_measurement_queue import Clock, measurement


def results_body(*entries, status=None):
    if status is None:
        rejected = [e for e in entries if e["result"] == "rejected"]
        status = "accepted" if not rejected else ("rejected" if len(rejected) == len(entries) else "partial")
    return json.dumps({"status": "ok", "network": status, "network_results": list(entries)})


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="delivery-secret-token",
        )
        self.wall = Clock()
        self.mono = Clock(500.0)
        self.queue = MeasurementQueue(None, wall_fn=self.wall)
        self.delivery = NetworkDelivery(self.queue, time_fn=self.mono)
        self.sent_payloads = []
        self.responses = []

    def tearDown(self):
        self.queue.close()

    def _fake_post(self, url, *, headers=None, payload=None, timeout=10.0):
        self.sent_payloads.append(payload)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response

    def _heartbeat(self, response):
        self.responses.append(response)
        with patch("agent.heartbeat.post_json", side_effect=self._fake_post):
            send_heartbeat(
                self.config,
                collect_fn=lambda: {"version": 1},
                docker_fn=lambda: {"version": 1},
                network_delivery=self.delivery,
            )

    def _sent_ids(self, index=-1):
        network = self.sent_payloads[index].get("network")
        return [m["measurement_id"] for m in network["measurements"]] if network else []

    def _enqueue(self, count):
        items = [measurement() for _ in range(count)]
        for item in items:
            self.queue.enqueue(item)
        return [item["measurement_id"] for item in items]

    def test_successful_acknowledgement_removes_measurements(self):
        ids = self._enqueue(3)
        body = results_body(*({"measurement_id": i, "result": "created"} for i in ids))
        self._heartbeat(HttpResponse(200, body))
        self.assertEqual(self._sent_ids(), ids)
        self.assertEqual(self.queue.count(), 0)

    def test_duplicate_acknowledgement_removes_measurements(self):
        ids = self._enqueue(2)
        body = results_body(*({"measurement_id": i, "result": "duplicate"} for i in ids))
        self._heartbeat(HttpResponse(200, body))
        self.assertEqual(self.queue.count(), 0)

    def test_partial_acceptance(self):
        stored, permanent, transient, missing = self._enqueue(4)
        body = results_body(
            {"measurement_id": stored, "result": "created"},
            {"measurement_id": permanent, "result": "rejected", "reason": "target is disabled", "retryable": False},
            {"measurement_id": transient, "result": "rejected", "reason": "measurement could not be stored", "retryable": True},
        )
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self._heartbeat(HttpResponse(200, body))
        self.assertEqual(self.queue.pending_batch(10), [])  # kept rows are backing off
        self.assertEqual(self.queue.count(), 2)
        self.assertEqual(self.queue.attempts(transient), 1)
        self.assertEqual(self.queue.attempts(missing), 1)
        self.assertIsNone(self.queue.attempts(permanent))
        output = "\n".join(logs.output)
        self.assertIn("permanently rejected", output)
        self.assertIn("did not acknowledge 1", output)

    def test_permanent_rejection_is_not_retried(self):
        (measurement_id,) = self._enqueue(1)
        body = results_body(
            {"measurement_id": measurement_id, "result": "rejected", "reason": "unknown target_id", "retryable": False}
        )
        with self.assertLogs("sentinel_agent", level="WARNING"):
            self._heartbeat(HttpResponse(200, body))
        self.assertEqual(self.queue.count(), 0)
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertNotIn("network", self.sent_payloads[-1])

    def test_transient_rejection_is_retried_with_same_id(self):
        (measurement_id,) = self._enqueue(1)
        transient = results_body(
            {"measurement_id": measurement_id, "result": "rejected", "reason": "measurement could not be stored", "retryable": True}
        )
        self._heartbeat(HttpResponse(200, transient))
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertNotIn("network", self.sent_payloads[-1])  # backing off
        self.wall.now += 31
        ok = results_body({"measurement_id": measurement_id, "result": "created"})
        self._heartbeat(HttpResponse(200, ok))
        self.assertEqual(self._sent_ids(), [measurement_id])
        self.assertEqual(self.queue.count(), 0)

    def test_malformed_response_keeps_everything_and_backs_off(self):
        ids = self._enqueue(2)
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self._heartbeat(HttpResponse(200, "<html>proxy</html>"))
        self.assertEqual(self.queue.count(), 2)
        self.assertEqual(self.queue.attempts(ids[0]), 0)
        self.assertIn("kept queued", "\n".join(logs.output))
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertNotIn("network", self.sent_payloads[-1])
        self.mono.now += BATCH_BACKOFF_BASE_SECONDS
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertEqual(self._sent_ids(), ids)

    def test_response_without_network_ack_keeps_everything(self):
        self._enqueue(2)
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertEqual(self.queue.count(), 2)

    def test_http_failure_keeps_everything(self):
        ids = self._enqueue(2)
        with self.assertRaises(HeartbeatError):
            self._heartbeat(HttpResponse(503, "unavailable"))
        self.assertEqual(self.queue.count(), 2)
        self.assertEqual(self.queue.attempts(ids[0]), 0)

    def test_transport_failure_keeps_everything(self):
        self._enqueue(1)
        with patch(
            "agent.http_client.urllib.request.urlopen",
            side_effect=urllib.error.URLError("Connection refused"),
        ), self.assertRaises(HeartbeatError):
            send_heartbeat(
                self.config,
                collect_fn=lambda: {},
                docker_fn=lambda: {},
                network_delivery=self.delivery,
            )
        self.assertEqual(self.queue.count(), 1)

    def test_backoff_grows_and_is_bounded(self):
        self._enqueue(1)
        delays = []
        for _ in range(8):
            self.mono.now += 10_000
            with self.assertRaises(HeartbeatError):
                self._heartbeat(HttpResponse(500, ""))
            delays.append(self.delivery.backoff_remaining)
        self.assertEqual(delays[:3], [30.0, 60.0, 120.0])
        self.assertEqual(max(delays), 600.0)
        self.assertEqual(self.queue.count(), 1)

    def test_idempotent_retry_resends_identical_measurements(self):
        ids = self._enqueue(3)
        with self.assertRaises(HeartbeatError):
            self._heartbeat(HttpResponse(500, ""))
        first = self.sent_payloads[-1]["network"]["measurements"]
        self.mono.now += BATCH_BACKOFF_BASE_SECONDS
        body = results_body(
            {"measurement_id": ids[0], "result": "duplicate"},
            {"measurement_id": ids[1], "result": "created"},
            {"measurement_id": ids[2], "result": "created"},
        )
        self._heartbeat(HttpResponse(200, body))
        self.assertEqual(self.sent_payloads[-1]["network"]["measurements"], first)
        self.assertEqual(self.queue.count(), 0)

    def test_batches_are_capped_at_server_limit(self):
        self._enqueue(150)
        self._heartbeat(HttpResponse(200, '{"status":"ok"}'))
        self.assertEqual(len(self._sent_ids()), 100)

    def test_legacy_server_without_results_is_supported(self):
        self._enqueue(2)
        legacy = json.dumps(
            {"status": "ok", "network": "accepted", "network_created": 2, "network_duplicates": 0}
        )
        self._heartbeat(HttpResponse(200, legacy))
        self.assertEqual(self.queue.count(), 0)

    def test_token_never_logged(self):
        self._enqueue(1)
        with self.assertLogs("sentinel_agent", level="DEBUG") as logs:
            self._heartbeat(HttpResponse(200, "not json"))
        self.assertNotIn(self.config.agent_token, "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()

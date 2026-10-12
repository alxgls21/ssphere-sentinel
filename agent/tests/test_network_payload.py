import unittest
import uuid
from datetime import datetime
from unittest.mock import patch

from agent.config import Config
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse
from agent.network import build_measurement
from agent.network_config import NetworkTargetConfig
from agent.network_probe import ProbeResult


def make_target(**overrides) -> NetworkTargetConfig:
    values = {
        "id": uuid.uuid4(),
        "name": "t",
        "hostname_or_ip": "127.0.0.1",
        "protocol": "tcp",
        "port": 443,
        "enabled": True,
        "monitoring_interval_seconds": 60,
        "timeout_seconds": 1,
        "probe_count": 2,
    }
    values.update(overrides)
    return NetworkTargetConfig(**values)


class BuildMeasurementTests(unittest.TestCase):
    def test_measurement_matches_server_contract(self):
        target = make_target()
        result = ProbeResult(
            success=True,
            latency_ms=5.0,
            packet_loss_percentage=0.0,
            probe_count=2,
            successful_probes=2,
            failure_reason="",
        )
        measurement = build_measurement(target, result)
        self.assertEqual(measurement["target_id"], str(target.id))
        uuid.UUID(measurement["measurement_id"])
        self.assertIsNotNone(datetime.fromisoformat(measurement["measured_at"]).tzinfo)
        self.assertEqual(measurement["latency_ms"], 5.0)
        self.assertEqual(measurement["successful_probes"], 2)

    def test_every_probe_gets_a_new_measurement_id(self):
        target = make_target()
        result = ProbeResult(False, None, 100.0, 2, 0, "timeout")
        first = build_measurement(target, result)
        second = build_measurement(target, result)
        self.assertNotEqual(first["measurement_id"], second["measurement_id"])


class HeartbeatWithoutNetworkRuntimeTests(unittest.TestCase):
    @patch("agent.network_probe.probe_target")
    @patch("agent.heartbeat.post_json")
    def test_heartbeat_never_probes_or_sends_unqueued_measurements(self, mock_post, mock_probe):
        # Measurements are only sent from the persistent queue; a heartbeat
        # without a NetworkDelivery must not run probes inline.
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')
        config = Config(sentinel_url="https://sentinel.example.com", agent_token="t")
        send_heartbeat(config, collect_fn=lambda: {}, docker_fn=lambda: {})
        payload = mock_post.call_args.kwargs["payload"]
        self.assertNotIn("network", payload)
        mock_probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()

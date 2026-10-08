import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from agent.network_config import NetworkTargetConfig
from agent.network_probe import (
    FAILURE_PERMISSION_DENIED,
    FAILURE_TIMEOUT,
    FAILURE_UNSUPPORTED,
    ProbeAttempt,
    probe_icmp,
    probe_target,
    probe_tcp,
)


def _target(**overrides) -> NetworkTargetConfig:
    data = {
        "id": uuid4(),
        "name": "t",
        "hostname_or_ip": "127.0.0.1",
        "protocol": "tcp",
        "port": 9,
        "enabled": True,
        "monitoring_interval_seconds": 60,
        "timeout_seconds": 1,
        "probe_count": 4,
    }
    data.update(overrides)
    return NetworkTargetConfig(**data)


class NetworkProbeTests(unittest.TestCase):
    @patch("agent.network_probe.socket.create_connection")
    def test_tcp_success(self, mock_conn):
        mock_conn.return_value.__enter__.return_value = MagicMock()
        mock_conn.return_value.__exit__.return_value = False
        result = probe_tcp("127.0.0.1", 443, timeout_seconds=1)
        self.assertTrue(result.success)
        self.assertIsNotNone(result.latency_ms)
        self.assertEqual(result.failure_reason, "")

    @patch("agent.network_probe.socket.create_connection")
    def test_tcp_failure_timeout(self, mock_conn):
        import socket

        mock_conn.side_effect = socket.timeout()
        result = probe_tcp("127.0.0.1", 443, timeout_seconds=1)
        self.assertFalse(result.success)
        self.assertEqual(result.failure_reason, FAILURE_TIMEOUT)

    @patch("agent.network_probe.probe_tcp")
    def test_partial_packet_loss(self, mock_tcp):
        mock_tcp.side_effect = [
            ProbeAttempt(True, 10.0, ""),
            ProbeAttempt(False, None, FAILURE_TIMEOUT),
            ProbeAttempt(True, 20.0, ""),
            ProbeAttempt(False, None, FAILURE_TIMEOUT),
        ]
        result = probe_target(_target(probe_count=4))
        self.assertTrue(result.success)
        self.assertEqual(result.successful_probes, 2)
        self.assertEqual(result.packet_loss_percentage, 50.0)
        self.assertEqual(result.latency_ms, 15.0)

    @patch("agent.network_probe.which", return_value=None)
    def test_icmp_unavailable_without_ping(self, _which):
        result = probe_icmp("127.0.0.1", timeout_seconds=1)
        self.assertFalse(result.success)
        self.assertEqual(result.failure_reason, FAILURE_UNSUPPORTED)

    @patch("agent.network_probe.subprocess.run")
    @patch("agent.network_probe.which", return_value="/sbin/ping")
    def test_icmp_permission_denied(self, _which, mock_run):
        mock_run.return_value = MagicMock(
            returncode=2,
            stdout="",
            stderr="ping: sendto: Operation not permitted",
        )
        result = probe_icmp("127.0.0.1", timeout_seconds=1)
        self.assertFalse(result.success)
        self.assertEqual(result.failure_reason, FAILURE_PERMISSION_DENIED)

import errno
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from agent import network_probe
from agent.network_config import NetworkTargetConfig
from agent.network_probe import (
    FAILURE_HOST_UNREACHABLE,
    FAILURE_NETWORK_ERROR,
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
    def setUp(self):
        network_probe._icmp_warning_logged = False
        self.addCleanup(setattr, network_probe, "_icmp_warning_logged", False)

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

    @patch("agent.network_probe.socket.create_connection")
    def test_tcp_unreachable_is_classified_on_every_platform(self, mock_conn):
        for code in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EHOSTDOWN):
            with self.subTest(errno=errno.errorcode[code]):
                mock_conn.side_effect = OSError(code, os.strerror(code))
                result = probe_tcp("127.0.0.1", 443, timeout_seconds=1)
                self.assertEqual(result.failure_reason, FAILURE_HOST_UNREACHABLE)

    @patch("agent.network_probe.socket.create_connection")
    def test_tcp_other_os_errors_are_network_errors(self, mock_conn):
        mock_conn.side_effect = OSError(errno.ENOBUFS, "no buffer space")
        result = probe_tcp("127.0.0.1", 443, timeout_seconds=1)
        self.assertEqual(result.failure_reason, FAILURE_NETWORK_ERROR)

    @patch("agent.network_probe.subprocess.run")
    @patch("agent.network_probe.which", return_value="/usr/bin/ping")
    def test_icmp_not_permitted_is_explained_once(self, _which, mock_run):
        # iputils ping when neither an unprivileged ICMP socket nor CAP_NET_RAW
        # is available (hardened unit on Debian/Ubuntu defaults).
        mock_run.return_value = MagicMock(
            returncode=2,
            stdout="",
            stderr=(
                "ping: socktype: SOCK_RAW\n"
                "ping: socket: Operation not permitted\n"
                "ping: => missing cap_net_raw+p capability or setuid?\n"
            ),
        )
        with tempfile.NamedTemporaryFile("w", suffix="ping_group_range") as range_file:
            range_file.write("1\t0\n")
            range_file.flush()
            with patch.object(network_probe, "PING_GROUP_RANGE_FILE", range_file.name), \
                    self.assertLogs("sentinel_agent", level="WARNING") as logs:
                first = probe_icmp("192.0.2.1", timeout_seconds=1)
                second = probe_icmp("192.0.2.1", timeout_seconds=1)
        self.assertEqual(first.failure_reason, FAILURE_PERMISSION_DENIED)
        self.assertEqual(second.failure_reason, FAILURE_PERMISSION_DENIED)
        self.assertEqual(len(logs.output), 1)
        message = logs.output[0]
        self.assertIn("ICMP probes are not permitted (ping: socktype: SOCK_RAW ping: socket: Operation not permitted", message)
        self.assertIn("net.ipv4.ping_group_range is 1 0", message)
        reported_groups = message.split("agent groups: ", 1)[1].split(")", 1)[0].split(", ")
        self.assertIn(str(os.getegid()), reported_groups)
        self.assertIn("enable-unprivileged-icmp.sh", message)

    @patch("agent.network_probe.subprocess.run")
    @patch("agent.network_probe.which", return_value="/usr/bin/ping")
    def test_other_icmp_failures_are_not_reported_as_permission_problems(self, _which, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="1 packets transmitted, 0 received, 100% packet loss", stderr="")
        with patch.object(network_probe.logger, "warning") as warning:
            result = probe_icmp("192.0.2.1", timeout_seconds=1)
        self.assertEqual(result.failure_reason, FAILURE_TIMEOUT)
        warning.assert_not_called()

    @patch("agent.network_probe.subprocess.run")
    @patch("agent.network_probe.which", return_value="/sbin/ping")
    def test_ping_gets_c_locale_and_not_the_agent_environment(self, _which, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="time=1.5 ms", stderr="")
        environ = {"PATH": "/usr/bin:/bin", "SENTINEL_AGENT_TOKEN": "secret-token", "LANG": "de_DE.UTF-8"}
        with patch.dict("agent.network_probe.os.environ", environ, clear=True):
            result = probe_icmp("127.0.0.1", timeout_seconds=1)
        self.assertEqual(result.latency_ms, 1.5)
        child_env = mock_run.call_args.kwargs["env"]
        self.assertEqual(child_env, {"PATH": "/usr/bin:/bin", "LC_ALL": "C"})

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
        with self.assertLogs("sentinel_agent", level="WARNING"):
            result = probe_icmp("127.0.0.1", timeout_seconds=1)
        self.assertFalse(result.success)
        self.assertEqual(result.failure_reason, FAILURE_PERMISSION_DENIED)

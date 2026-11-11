"""ICMP probing and probe aggregation: argv per platform, output parsing, failure mapping.

The existing tests in test_network_probe.py cover TCP, permission-denied
handling, the C locale and a partial packet loss. Not covered:

* the ``ping`` argv on Linux and macOS (``-W`` is seconds on one and
  milliseconds on the other), and the subprocess timeout;
* latency parsing and its wall-clock fallback;
* how ping's text is mapped to a failure reason;
* what ``subprocess.run`` can raise;
* aggregation in ``probe_target`` (rounding of the loss, the priority of failure
  reasons, cancellation).

``test_RAW_*`` tests assert what the agent should report. They were written against
two defects, before the fixes; they pass against the current code and guard it:
  - Linux prints "100% packet loss" in the summary of an unreachable host as well,
    and the branch for "100% packet loss" came before "unreachable", so
    "Destination Host Unreachable" was reported as a timeout;
  - macOS prints "100.0% packet loss" and "Request timeout for icmp_seq 0", which
    matched none of the patterns, so a timed out probe was reported as "unknown".
"""

import threading
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from agent import network_probe
from agent.network_config import NetworkTargetConfig
from agent.network_probe import (
    FAILURE_CONNECTION_REFUSED,
    FAILURE_DNS_FAILURE,
    FAILURE_HOST_UNREACHABLE,
    FAILURE_NETWORK_ERROR,
    FAILURE_PERMISSION_DENIED,
    FAILURE_TIMEOUT,
    FAILURE_UNKNOWN,
    FAILURE_UNSUPPORTED,
    ProbeAttempt,
    ProbeCancelled,
    probe_icmp,
    probe_target,
)


def _target(**overrides) -> NetworkTargetConfig:
    data = {
        "id": uuid4(),
        "name": "t",
        "hostname_or_ip": "192.0.2.10",
        "protocol": "icmp",
        "port": None,
        "enabled": True,
        "monitoring_interval_seconds": 60,
        "timeout_seconds": 2,
        "probe_count": 4,
    }
    data.update(overrides)
    return NetworkTargetConfig(**data)


def _completed(returncode=0, stdout="", stderr=""):
    return MagicMock(returncode=returncode, stdout=stdout, stderr=stderr)


class IcmpTestCase(unittest.TestCase):
    def setUp(self):
        network_probe._icmp_warning_logged = False
        self.addCleanup(setattr, network_probe, "_icmp_warning_logged", False)
        self.addCleanup(patch.stopall)
        patch("agent.network_probe.which", return_value="/bin/ping").start()
        self.run_mock = patch("agent.network_probe.subprocess.run").start()
        self.system = patch("agent.network_probe.platform.system", return_value="Linux").start()

    def ping(self, output="", returncode=0, timeout=2):
        self.run_mock.return_value = _completed(returncode, output)
        return probe_icmp("192.0.2.10", timeout_seconds=timeout)


class ArgvTests(IcmpTestCase):
    def test_linux_waits_whole_seconds_with_a_floor_of_one(self):
        self.system.return_value = "Linux"
        self.ping(timeout=3)
        self.assertEqual(self.run_mock.call_args.args[0], ["/bin/ping", "-c", "1", "-W", "3", "192.0.2.10"])
        self.ping(timeout=0.4)
        self.assertEqual(self.run_mock.call_args.args[0][3:5], ["-W", "1"])

    def test_macos_waits_milliseconds(self):
        self.system.return_value = "Darwin"
        self.ping(timeout=2)
        self.assertEqual(self.run_mock.call_args.args[0], ["/bin/ping", "-c", "1", "-W", "2000", "192.0.2.10"])

    def test_the_process_is_given_two_seconds_more_than_ping_waits_and_no_shell(self):
        self.ping(timeout=5)
        kwargs = self.run_mock.call_args.kwargs
        self.assertEqual(kwargs["timeout"], 7)
        self.assertIs(kwargs["shell"], False)

    def test_the_host_is_validated_before_anything_runs(self):
        from agent.errors import ConfigError

        with self.assertRaises(ConfigError):
            probe_icmp("-c", timeout_seconds=1)
        self.run_mock.assert_not_called()


class SuccessTests(IcmpTestCase):
    def test_latency_comes_from_the_ping_output(self):
        attempt = self.ping("64 bytes from 192.0.2.10: icmp_seq=1 ttl=64 time=12.3 ms")
        self.assertTrue(attempt.success)
        self.assertEqual(attempt.latency_ms, 12.3)
        self.assertEqual(attempt.failure_reason, "")

    def test_a_sub_millisecond_marker_is_read(self):
        self.assertEqual(self.ping("reply: time<1 ms").latency_ms, 1.0)

    def test_without_a_time_the_wall_clock_is_used(self):
        attempt = self.ping("1 packets transmitted, 1 received")
        self.assertTrue(attempt.success)
        self.assertIsNotNone(attempt.latency_ms)
        self.assertGreaterEqual(attempt.latency_ms, 0.0)


class FailureMappingTests(IcmpTestCase):
    def test_known_failure_texts(self):
        cases = (
            ("ping: unknown host nosuch.example", FAILURE_DNS_FAILURE),
            ("ping: nosuch.example: Name or service not known", FAILURE_DNS_FAILURE),
            # The resolver did not answer (iputils), and what busybox says for a name it cannot resolve.
            ("ping: nosuch.example: Temporary failure in name resolution", FAILURE_DNS_FAILURE),
            ("ping: bad address 'nosuch.example'", FAILURE_DNS_FAILURE),
            ("ping: connect: Network is unreachable", FAILURE_HOST_UNREACHABLE),
            ("Request timed out.", FAILURE_TIMEOUT),
            ("1 packets transmitted, 0 received, 100% packet loss, time 0ms", FAILURE_TIMEOUT),
            ("something nobody has seen before", FAILURE_UNKNOWN),
            ("", FAILURE_UNKNOWN),
        )
        for text, reason in cases:
            with self.subTest(text=text):
                attempt = self.ping(text, returncode=1)
                self.assertFalse(attempt.success)
                self.assertIsNone(attempt.latency_ms)
                self.assertEqual(attempt.failure_reason, reason)

    def test_stderr_is_read_as_well_as_stdout(self):
        self.run_mock.return_value = _completed(2, "", "ping: unknown host x")
        self.assertEqual(
            probe_icmp("192.0.2.10", timeout_seconds=2).failure_reason, FAILURE_DNS_FAILURE
        )

    def test_RAW_linux_destination_host_unreachable_is_not_a_timeout(self):
        output = (
            "From 192.0.2.1 icmp_seq=1 Destination Host Unreachable\n"
            "--- 192.0.2.10 ping statistics ---\n"
            "1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms\n"
        )
        self.assertEqual(self.ping(output, returncode=1).failure_reason, FAILURE_HOST_UNREACHABLE)

    def test_RAW_macos_request_timeout_is_a_timeout(self):
        output = (
            "PING 192.0.2.10 (192.0.2.10): 56 data bytes\n"
            "Request timeout for icmp_seq 0\n"
            "--- 192.0.2.10 ping statistics ---\n"
            "1 packets transmitted, 0 packets received, 100.0% packet loss\n"
        )
        self.system.return_value = "Darwin"
        self.assertEqual(self.ping(output, returncode=2).failure_reason, FAILURE_TIMEOUT)


class SubprocessErrorTests(IcmpTestCase):
    def test_what_subprocess_can_raise(self):
        import subprocess

        cases = (
            (subprocess.TimeoutExpired("ping", 4), FAILURE_TIMEOUT),
            (PermissionError(), FAILURE_PERMISSION_DENIED),
            (FileNotFoundError(), FAILURE_UNSUPPORTED),
            (OSError("exec format error"), FAILURE_NETWORK_ERROR),
        )
        for error, reason in cases:
            with self.subTest(error=type(error).__name__):
                self.run_mock.side_effect = error
                attempt = probe_icmp("192.0.2.10", timeout_seconds=2)
                self.assertEqual((attempt.success, attempt.failure_reason), (False, reason))


class AggregationTests(unittest.TestCase):
    def _probe(self, attempts, **target_overrides):
        target = _target(probe_count=len(attempts), **target_overrides)
        with patch("agent.network_probe.probe_icmp", side_effect=list(attempts)) as mocked:
            result = probe_target(target)
        return result, mocked

    def test_latency_is_the_mean_of_the_successful_attempts_only(self):
        ok = lambda ms: ProbeAttempt(True, ms, "")  # noqa: E731
        lost = ProbeAttempt(False, None, FAILURE_TIMEOUT)
        result, mocked = self._probe([ok(10.0), lost, ok(20.0), ok(30.0)])
        self.assertEqual(mocked.call_count, 4)
        self.assertTrue(result.success)
        self.assertEqual(result.latency_ms, 20.0)
        self.assertEqual(result.packet_loss_percentage, 25.0)
        self.assertEqual((result.probe_count, result.successful_probes), (4, 3))
        self.assertEqual(result.failure_reason, "")

    def test_packet_loss_is_rounded_to_two_decimals(self):
        ok = ProbeAttempt(True, 5.0, "")
        lost = ProbeAttempt(False, None, FAILURE_TIMEOUT)
        result, _ = self._probe([ok, lost, lost])
        self.assertEqual(result.packet_loss_percentage, 66.67)
        result, _ = self._probe([ok, ok, lost])
        self.assertEqual(result.packet_loss_percentage, 33.33)

    def test_when_everything_fails_the_most_specific_reason_wins(self):
        def fail(reason):
            return ProbeAttempt(False, None, reason)

        cases = (
            ([FAILURE_TIMEOUT, FAILURE_DNS_FAILURE, FAILURE_UNKNOWN], FAILURE_DNS_FAILURE),
            ([FAILURE_UNKNOWN, FAILURE_TIMEOUT], FAILURE_TIMEOUT),
            ([FAILURE_TIMEOUT, FAILURE_CONNECTION_REFUSED], FAILURE_CONNECTION_REFUSED),
            ([FAILURE_NETWORK_ERROR, FAILURE_UNKNOWN], FAILURE_NETWORK_ERROR),
            ([FAILURE_TIMEOUT, FAILURE_PERMISSION_DENIED, FAILURE_UNSUPPORTED], FAILURE_PERMISSION_DENIED),
            (["a reason nobody listed"], FAILURE_UNKNOWN),
        )
        for reasons, expected in cases:
            with self.subTest(reasons=reasons):
                result, _ = self._probe([fail(reason) for reason in reasons])
                self.assertFalse(result.success)
                self.assertIsNone(result.latency_ms)
                self.assertEqual(result.packet_loss_percentage, 100.0)
                self.assertEqual(result.successful_probes, 0)
                self.assertEqual(result.failure_reason, expected)

    def test_a_stop_before_the_first_attempt_abandons_the_probe_without_probing(self):
        stop = threading.Event()
        stop.set()
        with patch("agent.network_probe.probe_icmp") as mocked:
            with self.assertRaises(ProbeCancelled):
                probe_target(_target(), stop_event=stop)
        mocked.assert_not_called()

    def test_a_stop_between_attempts_discards_the_partial_result(self):
        stop = threading.Event()

        def attempt(*_args, **_kwargs):
            stop.set()
            return ProbeAttempt(True, 1.0, "")

        with patch("agent.network_probe.probe_icmp", side_effect=attempt) as mocked:
            with self.assertRaises(ProbeCancelled):
                probe_target(_target(probe_count=5), stop_event=stop)
        self.assertEqual(mocked.call_count, 1)


if __name__ == "__main__":
    unittest.main()

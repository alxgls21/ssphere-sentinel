import io
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent.cli import main
from agent.http_client import HttpResponse
from agent.measurement_queue import MeasurementQueue
from agent.network_runtime import NetworkRuntime
from agent.snmp_fetch import SnmpUnavailableError, check_snmp_available
from agent.snmp_runtime import SnmpRuntime
from agent.tests.snmp_helpers import DEVICE_ID, SECRET, FakeFetcher, interface, raw_data, unreachable, v3

V3 = {
    "version": "3",
    "username": "sentinel",
    "auth_protocol": "SHA-256",
    "auth_password": SECRET + "-auth",
    "priv_protocol": "AES-128",
    "priv_password": SECRET + "-priv",
}


class RepeatingFetcher:
    """Every fetch succeeds with counters that keep growing."""

    def __init__(self):
        self.calls = 0
        self.lock = threading.Lock()

    def fetch(self, device, credential, plan, cancel=None):
        with self.lock:
            self.calls += 1
            n = self.calls
        return raw_data(
            {1: interface(1, in_octets64=1000 * n), 2: interface(2)},
            uptime=1_000_000 + n * 30_000,
            discover=plan.discover,
        )


class SnmpEnvironmentTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)
        self.queue_path = self.dir / "queue" / "queue.sqlite3"
        self.devices_file = self.dir / "devices.json"
        self.credentials_file = self.dir / "credentials.json"
        self.write_devices([self.device()])
        self.write_credentials({"core": V3})

    def tearDown(self):
        self._tmp.cleanup()

    def device(self, **overrides):
        values = {
            "id": str(DEVICE_ID),
            "name": "core-sw-1",
            "address": "192.0.2.10",
            "credential_profile": "core",
            "poll_interval_seconds": 30,
        }
        values.update(overrides)
        return values

    def write_devices(self, devices):
        self.devices_file.write_text(json.dumps({"devices": devices}))

    def write_credentials(self, profiles):
        self.credentials_file.write_text(json.dumps({"profiles": profiles}))
        os.chmod(self.credentials_file, 0o600)

    def environment(self, **overrides):
        env = {
            "SENTINEL_URL": "https://sentinel.example.com",
            "SENTINEL_AGENT_TOKEN": "cli-snmp-secret-token",
            "SENTINEL_SNMP_DEVICES_FILE": str(self.devices_file),
            "SENTINEL_SNMP_CREDENTIALS_FILE": str(self.credentials_file),
            "SENTINEL_QUEUE_PATH": str(self.queue_path),
        }
        env.update(overrides)
        return env


class FactoryTests(SnmpEnvironmentTestCase):
    def build(self, env=None, **kwargs):
        with patch("agent.snmp_runtime.check_snmp_available"):
            return SnmpRuntime.from_environment(self.environment() if env is None else env, **kwargs)

    def test_unconfigured_means_no_runtime_and_no_queue_file(self):
        runtime = SnmpRuntime.from_environment({"SENTINEL_QUEUE_PATH": str(self.queue_path)})
        self.assertIsNone(runtime)
        self.assertFalse(self.queue_path.exists())

    def test_configured_builds_one_poller_per_enabled_device(self):
        self.write_devices(
            [
                self.device(),
                self.device(id="11111111-1111-1111-1111-111111111111", name="b"),
                self.device(id="22222222-2222-2222-2222-222222222222", name="c", enabled=False),
            ]
        )
        runtime = self.build(fetcher=FakeFetcher())
        try:
            self.assertEqual([p.device.name for p in runtime.pollers], ["core-sw-1", "b"])
            self.assertEqual(runtime.scheduler.device_count, 2)
            self.assertTrue(runtime.queue.persistent)
        finally:
            runtime.stop()

    def test_a_configuration_error_disables_snmp_without_raising(self):
        self.credentials_file.chmod(0o644)  # world-readable: refused
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            runtime = self.build()
        self.assertIsNone(runtime)
        text = "\n".join(logs.output)
        self.assertIn("SNMP monitoring disabled", text)
        self.assertIn("must not be accessible to other users", text)
        self.assertNotIn(SECRET, text)

    def test_a_missing_library_disables_snmp_with_a_clear_message(self):
        with patch("agent.snmp_fetch._load_api", side_effect=ImportError("no pysnmp")):
            with self.assertLogs("sentinel_agent", level="WARNING") as logs:
                runtime = SnmpRuntime.from_environment(self.environment())
        self.assertIsNone(runtime)
        self.assertIn("pip install 'ssphere-sentinel-agent[snmp]'", "\n".join(logs.output))

    def test_a_missing_crypto_backend_is_reported_for_privacy_profiles(self):
        with (
            patch("agent.snmp_fetch._load_api", return_value=MagicMock()),
            patch.dict(sys.modules, {"cryptography.hazmat.decrepit.ciphers.modes": None}),
        ):
            with self.assertRaises(SnmpUnavailableError) as caught:
                check_snmp_available([v3()])
            self.assertIn("cryptography", str(caught.exception))
            check_snmp_available([v3(priv_protocol="", priv_password="")])  # auth-only needs no cipher

    def test_queued_polls_are_still_delivered_when_snmp_is_off(self):
        queue = MeasurementQueue.open(self.queue_path)
        queue.enqueue_snmp(
            {
                "poll_id": "00000000-0000-0000-0000-000000000001",
                "device_id": str(DEVICE_ID),
                "measured_at": "2026-10-12T14:00:00+00:00",
                "reachable": False,
                "error": "timeout",
            }
        )
        queue.close()
        env = {"SENTINEL_QUEUE_PATH": str(self.queue_path)}
        runtime = SnmpRuntime.from_environment(env)
        try:
            self.assertIsNotNone(runtime)
            self.assertEqual(runtime.scheduler.device_count, 0)
            self.assertEqual(len(runtime.delivery.prepare_batch().polls), 1)
        finally:
            runtime.stop()

    def test_an_existing_queue_without_snmp_polls_does_not_create_a_runtime(self):
        MeasurementQueue.open(self.queue_path).close()
        self.assertIsNone(SnmpRuntime.from_environment({"SENTINEL_QUEUE_PATH": str(self.queue_path)}))

    def test_the_network_queue_is_shared_and_not_closed_by_snmp(self):
        shared = MeasurementQueue(None)
        runtime = self.build(queue=shared, fetcher=FakeFetcher())
        self.assertIs(runtime.queue, shared)
        runtime.stop()
        self.assertEqual(shared.snmp_count(), 0)  # still open
        shared.close()

    def test_poll_once_queues_polls_and_the_owned_queue_closes_on_stop(self):
        runtime = self.build(fetcher=RepeatingFetcher())
        self.assertEqual(runtime.poll_once(), 1)
        self.assertEqual(runtime.queue.snmp_count(), 1)
        runtime.stop()
        with self.assertRaises(Exception):
            runtime.queue.snmp_count()

    def test_concurrency_setting_is_bounded_and_invalid_values_fall_back(self):
        runtime = self.build(self.environment(SENTINEL_SNMP_MAX_CONCURRENT_POLLS="6"), fetcher=FakeFetcher())
        self.assertEqual(runtime.scheduler.max_workers, 6)
        runtime.stop()
        with self.assertLogs("sentinel_agent", level="WARNING"):
            runtime = self.build(self.environment(SENTINEL_SNMP_MAX_CONCURRENT_POLLS="500"), fetcher=FakeFetcher())
        self.assertEqual(runtime.scheduler.max_workers, 4)
        runtime.stop()

    def test_a_failed_enqueue_is_logged_not_raised(self):
        runtime = self.build(fetcher=FakeFetcher())
        runtime.queue.close()
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            runtime.enqueue({"poll_id": "00000000-0000-0000-0000-000000000001", "device_id": str(DEVICE_ID)})
        self.assertIn("could not be queued", "\n".join(logs.output))


class CredentialWarningTests(SnmpEnvironmentTestCase):
    def warnings(self, profile, **device_overrides):
        self.write_credentials({"core": profile})
        self.write_devices([self.device(**device_overrides)])
        with patch("agent.snmp_runtime.check_snmp_available"), self.assertLogs("sentinel_agent", level="WARNING") as logs:
            logger_lines = logs
            runtime = SnmpRuntime.from_environment(self.environment(), fetcher=FakeFetcher())
            import logging

            logging.getLogger("sentinel_agent").warning("sentinel")  # assertLogs needs one record
        runtime.stop()
        return "\n".join(logger_lines.output)

    def test_secure_v3_profile_logs_nothing(self):
        self.assertNotIn("SNMP profile", self.warnings(V3))

    def test_weak_profiles_are_called_out_without_leaking_secrets(self):
        cases = {
            "clear text": {"version": "2c", "community": SECRET},
            "default community": {"version": "2c", "community": "public"},
            "without privacy": {k: v for k, v in V3.items() if not k.startswith("priv")},
            "SHA-1": {**V3, "auth_protocol": "SHA"},
        }
        for expected, profile in cases.items():
            with self.subTest(expected):
                text = self.warnings(profile)
                self.assertIn(expected, text)
                self.assertNotIn(SECRET, text)


class CliSnmpTests(SnmpEnvironmentTestCase):
    def setUp(self):
        super().setUp()
        self.posts = []
        self.fetcher = RepeatingFetcher()

    def run_cli(self, argv, post_fn, env=None):
        def recording(url, *, headers=None, payload=None, timeout=10.0):
            self.posts.append(payload)
            return post_fn(url, headers=headers, payload=payload, timeout=timeout)

        environ = env or self.environment()
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict("os.environ", environ, clear=False),
            patch("agent.config.os.environ", environ),
            patch("agent.heartbeat.post_json", side_effect=recording),
            patch("agent.heartbeat.collect_telemetry", return_value={"version": 1}),
            patch("agent.heartbeat.collect_docker", return_value={"version": 1}),
            patch("agent.snmp_runtime.check_snmp_available"),
            patch("agent.snmp_runtime.PysnmpFetcher", return_value=self.fetcher),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    @staticmethod
    def ack_all(url, *, headers=None, payload=None, timeout=10.0):
        polls = payload["snmp"]["polls"]
        return HttpResponse(
            200,
            json.dumps(
                {
                    "status": "ok",
                    "snmp": "accepted",
                    "snmp_results": [{"poll_id": p["poll_id"], "result": "created"} for p in polls],
                }
            ),
        )

    def queued(self):
        queue = MeasurementQueue.open(self.queue_path)
        try:
            return queue.snmp_count()
        finally:
            queue.close()

    def test_one_shot_heartbeat_polls_queues_and_delivers(self):
        code, out, err = self.run_cli(["heartbeat"], self.ack_all)
        self.assertEqual((code, out.strip()), (0, "Heartbeat successful."))
        (poll,) = self.posts[0]["snmp"]["polls"]
        self.assertEqual(poll["device_id"], str(DEVICE_ID))
        self.assertTrue(poll["interfaces_complete"])
        self.assertEqual(self.queued(), 0)
        self.assertNotIn("cli-snmp-secret-token", err)

    def test_a_failed_heartbeat_keeps_the_poll_and_the_next_run_resends_the_same_id(self):
        code, _out, err = self.run_cli(["heartbeat"], lambda *a, **k: HttpResponse(500, ""))
        self.assertEqual(code, 1)
        first_id = self.posts[0]["snmp"]["polls"][0]["poll_id"]
        self.assertEqual(self.queued(), 1)

        code, _out, _err = self.run_cli(["heartbeat"], self.ack_all)
        self.assertEqual(code, 0)
        resent = [p["poll_id"] for p in self.posts[-1]["snmp"]["polls"]]
        self.assertIn(first_id, resent)
        self.assertEqual(len(resent), 2)
        self.assertEqual(self.queued(), 0)

    def test_no_secret_reaches_the_queue_file_the_payload_or_the_log(self):
        code, _out, err = self.run_cli(["heartbeat"], lambda *a, **k: HttpResponse(500, ""))
        self.assertEqual(code, 1)
        self.assertNotIn(SECRET, json.dumps(self.posts))
        self.assertNotIn(SECRET, err)
        stored = b"".join(p.read_bytes() for p in self.queue_path.parent.iterdir())
        self.assertNotIn(SECRET.encode(), stored)

    def test_without_snmp_configuration_the_agent_behaves_exactly_as_before(self):
        env = {
            "SENTINEL_URL": "https://sentinel.example.com",
            "SENTINEL_AGENT_TOKEN": "cli-snmp-secret-token",
            "XDG_STATE_HOME": str(self.dir / "state"),
        }
        with patch.dict("os.environ", {"SENTINEL_SNMP_DEVICES_FILE": "", "SENTINEL_NETWORK_TARGETS_FILE": ""}, clear=False):
            code, out, err = self.run_cli(
                ["heartbeat"], lambda *a, **k: HttpResponse(200, '{"status":"ok"}'), env=env
            )
        self.assertEqual((code, out.strip()), (0, "Heartbeat successful."))
        self.assertEqual(set(self.posts[0]), {"telemetry", "docker"})
        self.assertNotIn("SNMP", err)
        self.assertFalse((self.dir / "state").exists())  # no queue file created
        self.assertEqual(self.fetcher.calls, 0)

    def test_a_broken_snmp_configuration_never_stops_heartbeats(self):
        self.devices_file.write_text("{not json")
        code, out, err = self.run_cli(["heartbeat"], lambda *a, **k: HttpResponse(200, '{"status":"ok"}'))
        self.assertEqual((code, out.strip()), (0, "Heartbeat successful."))
        self.assertNotIn("snmp", self.posts[0])
        self.assertIn("SNMP monitoring disabled", err)

    def test_an_unreachable_device_is_reported_not_fatal(self):
        self.fetcher = FakeFetcher(unreachable("timeout", "no response"))
        code, _out, _err = self.run_cli(["heartbeat"], self.ack_all)
        self.assertEqual(code, 0)
        (poll,) = self.posts[0]["snmp"]["polls"]
        self.assertEqual((poll["reachable"], poll["error"]), (False, "timeout"))

    def test_run_polls_in_the_background_delivers_and_shuts_down_gracefully(self):
        installed = {}

        def fake_signal(sig, handler):
            installed[sig] = handler
            return signal.SIG_DFL

        def post(url, *, headers=None, payload=None, timeout=10.0):
            if len(self.posts) >= 3:
                installed[signal.SIGTERM](signal.SIGTERM, None)
            if "snmp" in payload:
                return self.ack_all(url, payload=payload)
            return HttpResponse(200, '{"status":"ok"}')

        self.write_devices([self.device(poll_interval_seconds=30)])
        env = self.environment(SENTINEL_HEARTBEAT_INTERVAL="1")
        with patch("agent.runner.signal.signal", side_effect=fake_signal):
            started = time.monotonic()
            code, _out, err = self.run_cli(["run"], post, env=env)
            elapsed = time.monotonic() - started
        self.assertEqual(code, 0)
        self.assertIn("SNMP monitoring: 1 enabled device(s)", err)
        self.assertIn("Agent stopped", err)
        self.assertNotIn("Traceback", err)
        self.assertLess(elapsed, 6)
        delivered = [p for p in self.posts if "snmp" in p]
        self.assertTrue(delivered, "the first poll is made at start-up and delivered")
        for thread in threading.enumerate():
            if thread.name.startswith("sentinel-snmp"):
                thread.join(2)
        self.assertEqual([t.name for t in threading.enumerate() if t.name.startswith("sentinel-snmp")], [])


class SharedQueueTests(SnmpEnvironmentTestCase):
    def test_network_and_snmp_share_one_queue_file_and_one_connection(self):
        targets = self.dir / "targets.json"
        targets.write_text(
            json.dumps(
                {
                    "targets": [
                        {
                            "id": "11111111-1111-1111-1111-111111111111",
                            "name": "t",
                            "hostname_or_ip": "192.0.2.1",
                            "protocol": "tcp",
                            "port": 443,
                        }
                    ]
                }
            )
        )
        env = self.environment(SENTINEL_NETWORK_TARGETS_FILE=str(targets))
        network = NetworkRuntime.from_environment(env)
        with patch("agent.snmp_runtime.check_snmp_available"):
            snmp = SnmpRuntime.from_environment(env, queue=network.queue, fetcher=FakeFetcher())
        try:
            self.assertIs(snmp.queue, network.queue)
            self.assertIsNot(snmp.delivery, network.delivery)
        finally:
            snmp.stop()
            network.stop()


if __name__ == "__main__":
    unittest.main()

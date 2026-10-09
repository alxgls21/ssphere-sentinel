import io
import json
import os
import signal
import tempfile
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from functools import partial
from pathlib import Path
from unittest.mock import patch

from agent.cli import main
from agent.config import Config
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse
from agent.measurement_queue import MeasurementQueue
from agent.network_runtime import NetworkRuntime, load_runtime_config
from agent.runner import run_continuous
from agent.tests.test_probe_scheduler import OK, make_target

TARGET_ID = "11111111-1111-1111-1111-111111111111"


class FakeClockStop(threading.Event):
    """Stop event whose wait() advances a fake monotonic clock instantly."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock
        self.waits = []

    def wait(self, timeout=None):
        self.waits.append(timeout)
        self.clock["t"] += timeout or 0
        return self.is_set()


class HeartbeatScheduleTests(unittest.TestCase):
    def test_fixed_rate_schedule_skips_missed_slots(self):
        clock = {"t": 0.0}
        stop = FakeClockStop(clock)
        sent_at = []

        def send(_config):
            sent_at.append(clock["t"])
            if len(sent_at) == 1:
                clock["t"] += 25.0  # slow first heartbeat: 2.5 intervals

        config = Config(sentinel_url="https://s.example", agent_token="t", heartbeat_interval=10)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            with self.assertLogs("sentinel_agent", level="WARNING") as logs:
                run_continuous(
                    config,
                    send_fn=send,
                    stop_event=stop,
                    max_iterations=3,
                    install_signal_handlers=False,
                    time_fn=lambda: clock["t"],
                )
        self.assertEqual(sent_at, [0.0, 30.0, 40.0])
        self.assertEqual(stop.waits, [5.0, 10.0])
        self.assertIn("skipped 2 slot(s)", "\n".join(logs.output))

    def test_fast_heartbeats_keep_exact_interval(self):
        clock = {"t": 100.0}
        stop = FakeClockStop(clock)
        sent_at = []

        def send(_config):
            sent_at.append(clock["t"])
            clock["t"] += 0.4

        config = Config(sentinel_url="https://s.example", agent_token="t", heartbeat_interval=30)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            run_continuous(
                config,
                send_fn=send,
                stop_event=stop,
                max_iterations=4,
                install_signal_handlers=False,
                time_fn=lambda: clock["t"],
            )
        self.assertEqual(sent_at, [100.0, 130.0, 160.0, 190.0])


class RuntimeReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="runtime-secret-token",
            heartbeat_interval=0.1,
        )

    def _send_fn(self, runtime):
        return partial(
            send_heartbeat,
            collect_fn=lambda: {"version": 1},
            docker_fn=lambda: {"version": 1},
            network_delivery=runtime.delivery,
        )

    def test_heartbeat_timing_under_slow_failing_probes(self):
        def hanging_failure(_target):
            time.sleep(0.5)
            raise RuntimeError("probe timed out badly")

        runtime = NetworkRuntime(
            [make_target(0.05) for _ in range(3)],
            MeasurementQueue(None),
            max_concurrent_probes=2,
            probe_fn=hanging_failure,
        )
        beats = []

        def post(url, *, headers=None, payload=None, timeout=10.0):
            beats.append(time.monotonic())
            return HttpResponse(200, '{"status":"ok"}')

        runtime.start()
        try:
            with (
                patch("agent.heartbeat.post_json", side_effect=post),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                run_continuous(
                    self.config,
                    send_fn=self._send_fn(runtime),
                    max_iterations=6,
                    install_signal_handlers=False,
                )
        finally:
            runtime.stop(timeout=5)
        self.assertEqual(len(beats), 6)
        self.assertLess(beats[-1] - beats[0], 0.9)
        gaps = [later - earlier for earlier, later in zip(beats, beats[1:])]
        self.assertLess(max(gaps), 0.3)

    def test_heartbeat_failures_do_not_stop_collection_or_lose_data(self):
        runtime = NetworkRuntime(
            [make_target(0.05)], MeasurementQueue(None), probe_fn=lambda _t: OK
        )
        runtime.start()
        try:
            with patch(
                "agent.http_client.urllib.request.urlopen",
                side_effect=urllib.error.URLError("Connection refused"),
            ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                run_continuous(
                    self.config,
                    send_fn=self._send_fn(runtime),
                    max_iterations=4,
                    install_signal_handlers=False,
                )
            time.sleep(0.2)
            self.assertGreaterEqual(runtime.queue.count(), 3)
        finally:
            runtime.scheduler.stop(timeout=5)
        self.assertGreaterEqual(runtime.queue.count(), 3)
        runtime.queue.close()

    def test_queue_failure_does_not_crash_collection(self):
        runtime = NetworkRuntime([make_target(0.05)], MeasurementQueue(None), probe_fn=lambda _t: OK)
        runtime.queue.close()  # every queue operation now fails
        runtime.start()
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            time.sleep(0.2)
            batch = runtime.delivery.prepare_batch()
        runtime.scheduler.stop(timeout=5)
        self.assertEqual(batch.measurements, ())
        self.assertIn("could not be queued and is lost", "\n".join(logs.output))


class RuntimeConfigTests(unittest.TestCase):
    def test_defaults_and_invalid_values(self):
        with self.assertLogs("sentinel_agent", level="WARNING"):
            config = load_runtime_config(
                {
                    "XDG_STATE_HOME": "/srv/state",
                    "SENTINEL_QUEUE_MAX_MEASUREMENTS": "5",
                    "SENTINEL_NETWORK_MAX_CONCURRENT_PROBES": "abc",
                }
            )
        self.assertEqual(
            config.queue_path, Path("/srv/state/ssphere-sentinel/network-queue.sqlite3")
        )
        self.assertEqual(config.max_measurements, 10_000)
        self.assertEqual(config.max_concurrent_probes, 4)

    def test_relative_queue_path_uses_memory(self):
        with self.assertLogs("sentinel_agent", level="WARNING"):
            config = load_runtime_config({"SENTINEL_QUEUE_PATH": "queue.db"})
        self.assertIsNone(config.queue_path)


class CliIntegrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        os.chmod(self.dir, 0o700)
        self.queue_path = self.dir / "queue" / "network.sqlite3"
        self.targets_file = self.dir / "targets.json"
        self.targets_file.write_text(
            json.dumps(
                {
                    "targets": [
                        {
                            "id": TARGET_ID,
                            "name": "edge",
                            "hostname_or_ip": "192.0.2.1",
                            "protocol": "tcp",
                            "port": 443,
                            "monitoring_interval_seconds": 10,
                            "probe_count": 1,
                        }
                    ]
                }
            )
        )
        self.token = "cli-network-secret-token"
        self.env = {
            "SENTINEL_URL": "https://sentinel.example.com",
            "SENTINEL_AGENT_TOKEN": self.token,
            "SENTINEL_NETWORK_TARGETS_FILE": str(self.targets_file),
            "SENTINEL_QUEUE_PATH": str(self.queue_path),
        }
        self.posts = []

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, argv, responses, env=None):
        environ = env or self.env
        queued = list(responses)

        def fake_post(url, *, headers=None, payload=None, timeout=10.0):
            self.posts.append(payload)
            return queued.pop(0)

        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict("os.environ", environ, clear=False),
            patch("agent.config.os.environ", environ),
            patch("agent.heartbeat.post_json", side_effect=fake_post),
            patch("agent.heartbeat.collect_telemetry", return_value={"version": 1}),
            patch("agent.heartbeat.collect_docker", return_value={"version": 1}),
            patch("agent.probe_scheduler.probe_target", side_effect=lambda t, **_: OK),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def _ids(self, index):
        return [m["measurement_id"] for m in self.posts[index]["network"]["measurements"]]

    def test_one_shot_heartbeat_retries_same_ids_after_restart(self):
        code, _out, err = self._run(["heartbeat"], [HttpResponse(500, "")])
        self.assertEqual(code, 1)
        first_ids = self._ids(0)
        self.assertEqual(len(first_ids), 1)
        self.assertTrue(self.queue_path.exists())

        # Second process: resends the persisted measurement plus a new probe.
        def ack_all(url, *, headers=None, payload=None, timeout=10.0):
            ids = [m["measurement_id"] for m in payload["network"]["measurements"]]
            return HttpResponse(
                200,
                json.dumps(
                    {
                        "status": "ok",
                        "network": "accepted",
                        "network_results": [
                            {"measurement_id": mid, "result": "duplicate" if mid in first_ids else "created"}
                            for mid in ids
                        ],
                    }
                ),
            )

        code, out, _err = self._run_with_post(["heartbeat"], ack_all)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "Heartbeat successful.")
        resent = self._ids(-1)
        self.assertIn(first_ids[0], resent)
        self.assertEqual(len(resent), 2)
        self.assertEqual(self._queued_count(), 0)
        self.assertNotIn(self.token, err)
        stored = b"".join(p.read_bytes() for p in self.queue_path.parent.iterdir())
        self.assertNotIn(self.token.encode(), stored)

    def _queued_count(self):
        queue = MeasurementQueue.open(self.queue_path)
        try:
            return queue.count()
        finally:
            queue.close()

    def _run_with_post(self, argv, post_fn):
        def recording(url, *, headers=None, payload=None, timeout=10.0):
            self.posts.append(payload)
            return post_fn(url, headers=headers, payload=payload, timeout=timeout)

        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict("os.environ", self.env, clear=False),
            patch("agent.config.os.environ", self.env),
            patch("agent.heartbeat.post_json", side_effect=recording),
            patch("agent.heartbeat.collect_telemetry", return_value={"version": 1}),
            patch("agent.heartbeat.collect_docker", return_value={"version": 1}),
            patch("agent.probe_scheduler.probe_target", side_effect=lambda t, **_: OK),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_without_targets_or_backlog_no_queue_file_is_created(self):
        state = self.dir / "state"
        env = {
            "SENTINEL_URL": "https://sentinel.example.com",
            "SENTINEL_AGENT_TOKEN": self.token,
            "XDG_STATE_HOME": str(state),
        }
        with patch.dict("os.environ", {"SENTINEL_NETWORK_TARGETS_FILE": ""}, clear=False):
            code, _out, _err = self._run(
                ["heartbeat"], [HttpResponse(200, '{"status":"ok"}')], env=env
            )
        self.assertEqual(code, 0)
        self.assertNotIn("network", self.posts[0])
        self.assertFalse(state.exists())

    def test_run_shuts_down_gracefully_on_sigterm(self):
        installed = {}

        def fake_signal(sig, handler):
            installed[sig] = handler
            return signal.SIG_DFL

        def post_then_sigterm(url, *, headers=None, payload=None, timeout=10.0):
            if len(self.posts) >= 2:
                installed[signal.SIGTERM](signal.SIGTERM, None)
            return HttpResponse(200, '{"status":"ok"}')

        env = dict(self.env, SENTINEL_HEARTBEAT_INTERVAL="1")
        self.env = env
        with patch("agent.runner.signal.signal", side_effect=fake_signal):
            began = time.monotonic()
            code, _out, err = self._run_with_post(["run"], post_then_sigterm)
            elapsed = time.monotonic() - began
        self.assertEqual(code, 0)
        self.assertIn("Agent stopped.", err)
        self.assertNotIn("Traceback", err)
        self.assertLess(elapsed, 5)
        for thread in threading.enumerate():
            if thread.name.startswith("sentinel-probe"):
                thread.join(2)
        self.assertEqual(
            [t.name for t in threading.enumerate() if t.name.startswith("sentinel-probe")], []
        )
        self.assertGreaterEqual(self._queued_count(), 1)


if __name__ == "__main__":
    unittest.main()

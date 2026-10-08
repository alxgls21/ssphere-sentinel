import io
import signal
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import MagicMock, patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.http_client import HttpResponse
from agent.runner import run_continuous


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="runner-secret-token",
            heartbeat_interval=30,
        )

    def test_sends_heartbeat_immediately(self):
        send_fn = MagicMock()
        stop = threading.Event()

        def _send(_config):
            send_fn(_config)
            stop.set()

        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = run_continuous(
                self.config,
                send_fn=_send,
                stop_event=stop,
                install_signal_handlers=False,
            )

        self.assertEqual(code, 0)
        send_fn.assert_called_once_with(self.config)

    def test_repeated_heartbeat_behavior(self):
        send_fn = MagicMock()
        fast = Config(
            sentinel_url=self.config.sentinel_url,
            agent_token=self.config.agent_token,
            heartbeat_interval=0,
        )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = run_continuous(
                fast,
                send_fn=send_fn,
                max_iterations=3,
                install_signal_handlers=False,
            )

        self.assertEqual(code, 0)
        self.assertEqual(send_fn.call_count, 3)

    def test_uses_configured_heartbeat_interval(self):
        config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="token",
            heartbeat_interval=7,
        )
        send_fn = MagicMock()
        stop = threading.Event()
        wait_timeouts: list[float] = []

        original_wait = stop.wait

        def tracking_wait(timeout=None):
            wait_timeouts.append(timeout)
            stop.set()
            return original_wait(timeout=0)

        stop.wait = tracking_wait  # type: ignore[method-assign]

        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            run_continuous(
                config,
                send_fn=send_fn,
                stop_event=stop,
                install_signal_handlers=False,
            )

        self.assertEqual(wait_timeouts, [7])

    def test_heartbeat_failure_does_not_terminate_loop(self):
        calls = {"n": 0}
        fast = Config(
            sentinel_url=self.config.sentinel_url,
            agent_token=self.config.agent_token,
            heartbeat_interval=0,
        )

        def flaky(_config):
            calls["n"] += 1
            if calls["n"] == 1:
                raise HeartbeatError("server returned HTTP 500")

        stderr = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(stderr):
            code = run_continuous(
                fast,
                send_fn=flaky,
                max_iterations=2,
                install_signal_handlers=False,
            )

        self.assertEqual(code, 0)
        self.assertEqual(calls["n"], 2)
        self.assertIn("Heartbeat failed: server returned HTTP 500", stderr.getvalue())
        self.assertNotIn(self.config.agent_token, stderr.getvalue())

    def test_loop_survives_telemetry_collection_failure(self):
        from agent.heartbeat import send_heartbeat

        posts = []

        def fake_post(url, *, headers=None, payload=None, timeout=10.0):
            posts.append(payload)
            return HttpResponse(status=200, body='{"status":"ok"}')

        fast = Config(
            sentinel_url=self.config.sentinel_url,
            agent_token=self.config.agent_token,
            heartbeat_interval=0,
        )
        docker_payload = {
            "version": 1,
            "available": False,
            "status": "unavailable",
            "collected_at": "2026-10-07T12:00:00+00:00",
            "containers": [],
        }

        def boom():
            raise RuntimeError("collector failed")

        with (
            patch("agent.heartbeat.post_json", side_effect=fake_post),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            code = run_continuous(
                fast,
                send_fn=lambda cfg: send_heartbeat(
                    cfg,
                    collect_fn=boom,
                    docker_fn=lambda: docker_payload,
                    network_fn=lambda: {"version": 1, "measurements": []},
                ),
                max_iterations=2,
                install_signal_handlers=False,
            )

        self.assertEqual(code, 0)
        self.assertEqual(len(posts), 2)
        for payload in posts:
            self.assertNotIn("telemetry", payload)
            self.assertEqual(payload["docker"], docker_payload)

    def test_loop_survives_docker_collection_failure(self):
        from agent.heartbeat import send_heartbeat

        posts = []

        def fake_post(url, *, headers=None, payload=None, timeout=10.0):
            posts.append(payload)
            return HttpResponse(status=200, body='{"status":"ok"}')

        fast = Config(
            sentinel_url=self.config.sentinel_url,
            agent_token=self.config.agent_token,
            heartbeat_interval=0,
        )
        telemetry = {
            "version": 1,
            "collected_at": "2026-10-07T12:00:00+00:00",
            "cpu_percent": 1.0,
            "memory_total_bytes": 100,
            "memory_used_bytes": 10,
            "memory_percent": 10.0,
            "disk_total_bytes": 100,
            "disk_used_bytes": 10,
            "disk_percent": 10.0,
            "uptime_seconds": 1,
        }

        with (
            patch("agent.heartbeat.post_json", side_effect=fake_post),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            code = run_continuous(
                fast,
                send_fn=lambda cfg: send_heartbeat(
                    cfg,
                    collect_fn=lambda: telemetry,
                    docker_fn=lambda: (_ for _ in ()).throw(RuntimeError("docker")),
                    network_fn=lambda: {"version": 1, "measurements": []},
                ),
                max_iterations=2,
                install_signal_handlers=False,
            )

        self.assertEqual(code, 0)
        self.assertEqual(len(posts), 2)
        for payload in posts:
            self.assertEqual(payload["telemetry"], telemetry)
            self.assertNotIn("docker", payload)

    def test_signal_handler_stops_loop_gracefully(self):
        send_fn = MagicMock()
        installed = {}

        def fake_signal(sig, handler):
            installed[sig] = handler
            return signal.SIG_DFL

        def send_and_signal(_config):
            send_fn(_config)
            # Simulate SIGTERM after the first heartbeat.
            installed[signal.SIGTERM](signal.SIGTERM, None)

        stderr = io.StringIO()
        with (
            patch("agent.runner.signal.signal", side_effect=fake_signal),
            redirect_stdout(io.StringIO()),
            redirect_stderr(stderr),
        ):
            code = run_continuous(
                self.config,
                send_fn=send_and_signal,
                install_signal_handlers=True,
            )

        self.assertEqual(code, 0)
        self.assertEqual(send_fn.call_count, 1)
        self.assertIn("Agent stopped.", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

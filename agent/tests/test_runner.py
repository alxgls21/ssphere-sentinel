import io
import signal
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import MagicMock, patch

from agent.config import Config
from agent.errors import HeartbeatError
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

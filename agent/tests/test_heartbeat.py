import io
import logging
import unittest
from unittest.mock import patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import build_heartbeat_payload, send_heartbeat
from agent.http_client import HttpResponse, USER_AGENT


class HeartbeatTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="super-secret-agent-token",
        )
        self.sample_telemetry = {
            "version": 1,
            "collected_at": "2026-10-07T12:00:00+00:00",
            "cpu_percent": 10.0,
            "memory_total_bytes": 1000,
            "memory_used_bytes": 400,
            "memory_percent": 40.0,
            "disk_total_bytes": 2000,
            "disk_used_bytes": 500,
            "disk_percent": 25.0,
            "uptime_seconds": 99,
        }
        self.sample_docker = {
            "version": 1,
            "available": False,
            "status": "unavailable",
            "collected_at": "2026-10-07T12:00:00+00:00",
            "containers": [],
        }

    @patch("agent.heartbeat.post_json")
    def test_successful_heartbeat(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')

        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=lambda: self.sample_docker,
        )

        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        self.assertEqual(
            args[0],
            "https://sentinel.example.com/api/v1/agent/heartbeat/",
        )
        self.assertEqual(
            kwargs["headers"]["Authorization"],
            "Bearer super-secret-agent-token",
        )
        self.assertEqual(kwargs["payload"]["telemetry"], self.sample_telemetry)
        self.assertEqual(kwargs["payload"]["docker"], self.sample_docker)
        self.assertNotIn("super-secret-agent-token", args[0])

    @patch("agent.heartbeat.post_json")
    def test_telemetry_included_in_heartbeat_report_payload(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')
        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=lambda: self.sample_docker,
        )
        self.assertIn("telemetry", mock_post.call_args.kwargs["payload"])
        self.assertIn("docker", mock_post.call_args.kwargs["payload"])

    @patch("agent.heartbeat.post_json")
    def test_telemetry_collection_failure_falls_back_to_liveness_only(
        self, mock_post
    ):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')

        def boom():
            raise RuntimeError("psutil exploded")

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("sentinel_agent")
        logger.addHandler(handler)
        logger.setLevel(logging.WARNING)
        try:
            send_heartbeat(
                self.config,
                collect_fn=boom,
                docker_fn=lambda: self.sample_docker,
            )
        finally:
            logger.removeHandler(handler)

        payload = mock_post.call_args.kwargs["payload"]
        self.assertNotIn("telemetry", payload)
        self.assertEqual(payload["docker"], self.sample_docker)
        self.assertIn("Telemetry collection failed", stream.getvalue())
        self.assertNotIn(self.config.agent_token, stream.getvalue())

    @patch("agent.heartbeat.post_json")
    def test_docker_collection_failure_does_not_stop_heartbeat(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')

        def boom():
            raise RuntimeError("docker exploded")

        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=boom,
        )
        payload = mock_post.call_args.kwargs["payload"]
        self.assertEqual(payload["telemetry"], self.sample_telemetry)
        self.assertNotIn("docker", payload)

    def test_build_payload_omits_telemetry_on_failure(self):
        payload = build_heartbeat_payload(
            collect_fn=lambda: (_ for _ in ()).throw(RuntimeError("nope")),
            docker_fn=lambda: self.sample_docker,
        )
        self.assertNotIn("telemetry", payload)
        self.assertEqual(payload["docker"], self.sample_docker)

    @patch("agent.heartbeat.post_json")
    def test_unauthorized_response(self, mock_post):
        mock_post.return_value = HttpResponse(status=401, body='{"detail":"nope"}')

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(
                self.config,
                collect_fn=lambda: self.sample_telemetry,
                docker_fn=lambda: self.sample_docker,
            )

        self.assertEqual(str(ctx.exception), "server returned HTTP 401")
        self.assertNotIn(self.config.agent_token, str(ctx.exception))

    @patch("agent.heartbeat.post_json")
    def test_server_error_response(self, mock_post):
        mock_post.return_value = HttpResponse(status=500, body="error")

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(
                self.config,
                collect_fn=lambda: self.sample_telemetry,
                docker_fn=lambda: self.sample_docker,
            )

        self.assertEqual(str(ctx.exception), "server returned HTTP 500")

    @patch("agent.http_client.urllib.request.urlopen")
    def test_connection_failure(self, mock_urlopen):
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(
                self.config,
                collect_fn=lambda: self.sample_telemetry,
                docker_fn=lambda: self.sample_docker,
            )

        self.assertIn("connection failed", str(ctx.exception))
        self.assertNotIn(self.config.agent_token, str(ctx.exception))

    @patch("agent.http_client.urllib.request.urlopen")
    def test_timeout(self, mock_urlopen):
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError(TimeoutError("timed out"))

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(
                self.config,
                collect_fn=lambda: self.sample_telemetry,
                docker_fn=lambda: self.sample_docker,
            )

        self.assertEqual(str(ctx.exception), "request timed out")
        self.assertNotIn(self.config.agent_token, str(ctx.exception))

    @patch("agent.http_client.urllib.request.urlopen")
    def test_user_agent_header_is_sent(self, mock_urlopen):
        class FakeResponse:
            status = 200

            def read(self):
                return b'{"status":"ok"}'

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        mock_urlopen.return_value = FakeResponse()
        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=lambda: self.sample_docker,
        )

        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), USER_AGENT)

    @patch("agent.heartbeat.post_json")
    def test_token_never_logged(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("sentinel_agent")
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)

        try:
            send_heartbeat(
                self.config,
                collect_fn=lambda: self.sample_telemetry,
                docker_fn=lambda: self.sample_docker,
            )
        finally:
            logger.removeHandler(handler)

        self.assertNotIn(self.config.agent_token, stream.getvalue())

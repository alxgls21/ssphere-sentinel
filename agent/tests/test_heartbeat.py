import io
import json
import logging
import unittest
from unittest.mock import patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import build_heartbeat_payload, log_subsystem_status, send_heartbeat
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
        self.empty_network = {"version": 1, "measurements": []}

    @patch("agent.heartbeat.post_json")
    def test_successful_heartbeat(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')

        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=lambda: self.sample_docker,
            network_fn=lambda: self.empty_network,
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
        self.assertNotIn("network", kwargs["payload"])
        self.assertNotIn("super-secret-agent-token", args[0])

    @patch("agent.heartbeat.post_json")
    def test_telemetry_included_in_heartbeat_report_payload(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')
        send_heartbeat(
            self.config,
            collect_fn=lambda: self.sample_telemetry,
            docker_fn=lambda: self.sample_docker,
            network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
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
            network_fn=lambda: self.empty_network,
        )
        payload = mock_post.call_args.kwargs["payload"]
        self.assertEqual(payload["telemetry"], self.sample_telemetry)
        self.assertNotIn("docker", payload)

    def test_build_payload_omits_telemetry_on_failure(self):
        payload = build_heartbeat_payload(
            collect_fn=lambda: (_ for _ in ()).throw(RuntimeError("nope")),
            docker_fn=lambda: self.sample_docker,
            network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
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
            network_fn=lambda: self.empty_network,
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
                network_fn=lambda: self.empty_network,
            )
        finally:
            logger.removeHandler(handler)

        self.assertNotIn(self.config.agent_token, stream.getvalue())


class HeartbeatResponseHandlingTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="super-secret-agent-token",
        )
        self.stream = io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        self.logger = logging.getLogger("sentinel_agent")
        self.previous_level = self.logger.level
        self.logger.addHandler(self.handler)
        self.logger.setLevel(logging.INFO)

    def tearDown(self):
        self.logger.removeHandler(self.handler)
        self.logger.setLevel(self.previous_level)

    def _send(self, body, status=200):
        with patch("agent.heartbeat.post_json") as mock_post:
            mock_post.return_value = HttpResponse(status=status, body=body)
            send_heartbeat(
                self.config,
                collect_fn=lambda: {"version": 1},
                docker_fn=lambda: {"version": 1},
                network_fn=lambda: {"version": 1, "measurements": [{"x": 1}]},
            )
        return self.stream.getvalue()

    def test_all_accepted_logs_no_warnings(self):
        body = json.dumps(
            {
                "status": "ok",
                "telemetry": "accepted",
                "docker": "accepted",
                "network": "accepted",
                "network_accepted": 2,
                "network_rejected": 0,
            }
        )
        output = self._send(body)
        self.assertNotIn("WARNING", output)
        self.assertIn("Sentinel accepted telemetry", output)
        self.assertIn("accepted=2", output)
        self.assertEqual(
            log_subsystem_status(body),
            {"telemetry": "accepted", "docker": "accepted", "network": "accepted"},
        )

    def test_rejected_subsystems_are_logged_with_detail(self):
        body = json.dumps(
            {
                "status": "ok",
                "telemetry": "rejected",
                "detail": "cpu_percent must be a number",
                "docker": "rejected",
                "docker_detail": "status is invalid",
            }
        )
        output = self._send(body)
        self.assertIn(
            "WARNING: Sentinel rejected telemetry: cpu_percent must be a number", output
        )
        self.assertIn("WARNING: Sentinel rejected docker: status is invalid", output)

    def test_partial_network_is_not_treated_as_full_success(self):
        rejections = [
            {"measurement_id": f"id-{index}", "reason": "target is disabled"}
            for index in range(7)
        ]
        body = json.dumps(
            {
                "status": "ok",
                "network": "partial",
                "network_accepted": 3,
                "network_rejected": 7,
                "network_rejections": rejections,
                "network_detail": "7 measurement(s) rejected; first: target is disabled",
            }
        )
        output = self._send(body)
        self.assertIn(
            "WARNING: Sentinel partial network measurements (accepted=3, rejected=7)",
            output,
        )
        self.assertIn("Network measurement id-0 rejected: target is disabled", output)
        self.assertIn("Network measurement id-4 rejected", output)
        self.assertNotIn("id-5", output)
        self.assertIn("2 more network measurement rejection(s) not shown", output)

    def test_fully_rejected_network_is_logged(self):
        body = json.dumps(
            {
                "status": "ok",
                "network": "rejected",
                "network_detail": "unsupported network version (expected 1)",
            }
        )
        output = self._send(body)
        self.assertIn(
            "Sentinel rejected network measurements (accepted=unknown, rejected=unknown)",
            output,
        )
        self.assertIn("unsupported network version", output)

    def test_legacy_minimal_response_is_accepted_quietly(self):
        output = self._send('{"status":"ok"}')
        self.assertNotIn("WARNING", output)

    def test_non_json_success_body_logs_warning_without_failing(self):
        output = self._send("<html>proxy page</html>")
        self.assertIn("not valid JSON", output)
        self.assertNotIn("proxy page", output)

    def test_non_object_json_body_logs_warning(self):
        output = self._send("[1, 2]")
        self.assertIn("not a JSON object", output)

    def test_logged_server_text_is_truncated_and_sanitized(self):
        body = json.dumps(
            {
                "status": "ok",
                "telemetry": "rejected",
                "detail": "line1\nforged log line " + "x" * 500,
            }
        )
        output = self._send(body)
        self.assertNotIn("\nforged", output)
        self.assertIn("line1 forged log line", output)
        self.assertNotIn("x" * 201, output)
        self.assertIn("...", output)

    def test_token_and_payload_never_logged(self):
        body = json.dumps(
            {
                "status": "ok",
                "network": "partial",
                "network_accepted": 0,
                "network_rejected": 1,
                "network_rejections": [{"measurement_id": None, "reason": "bad"}],
            }
        )
        output = self._send(body)
        self.assertNotIn(self.config.agent_token, output)
        self.assertNotIn('"x": 1', output)

    def test_error_status_still_raises(self):
        with self.assertRaises(HeartbeatError):
            self._send('{"network": "accepted"}', status=500)
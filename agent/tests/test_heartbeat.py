import io
import logging
import unittest
from unittest.mock import patch

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import send_heartbeat
from agent.http_client import HttpResponse, USER_AGENT


class HeartbeatTests(unittest.TestCase):
    def setUp(self):
        self.config = Config(
            sentinel_url="https://sentinel.example.com",
            agent_token="super-secret-agent-token",
        )

    @patch("agent.heartbeat.post_json")
    def test_successful_heartbeat(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')

        send_heartbeat(self.config)

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
        self.assertNotIn("super-secret-agent-token", args[0])

    @patch("agent.heartbeat.post_json")
    def test_unauthorized_response(self, mock_post):
        mock_post.return_value = HttpResponse(status=401, body='{"detail":"nope"}')

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(self.config)

        self.assertEqual(str(ctx.exception), "server returned HTTP 401")
        self.assertNotIn(self.config.agent_token, str(ctx.exception))

    @patch("agent.heartbeat.post_json")
    def test_server_error_response(self, mock_post):
        mock_post.return_value = HttpResponse(status=500, body="error")

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(self.config)

        self.assertEqual(str(ctx.exception), "server returned HTTP 500")

    @patch("agent.http_client.urllib.request.urlopen")
    def test_connection_failure(self, mock_urlopen):
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(self.config)

        self.assertIn("connection failed", str(ctx.exception))
        self.assertNotIn(self.config.agent_token, str(ctx.exception))

    @patch("agent.http_client.urllib.request.urlopen")
    def test_timeout(self, mock_urlopen):
        import urllib.error

        mock_urlopen.side_effect = urllib.error.URLError(TimeoutError("timed out"))

        with self.assertRaises(HeartbeatError) as ctx:
            send_heartbeat(self.config)

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
        send_heartbeat(self.config)

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
            send_heartbeat(self.config)
        finally:
            logger.removeHandler(handler)

        self.assertNotIn(self.config.agent_token, stream.getvalue())


if __name__ == "__main__":
    unittest.main()

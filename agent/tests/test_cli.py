import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from agent.cli import main
from agent.errors import HeartbeatError
from agent.http_client import HttpResponse


class CliTests(unittest.TestCase):
    def _run(self, argv, environ):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.dict("os.environ", environ, clear=False),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            # Ensure required keys are exactly as provided for these tests.
            with patch("agent.config.os.environ", environ):
                code = main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    @patch("agent.heartbeat.post_json")
    def test_cli_heartbeat_success(self, mock_post):
        mock_post.return_value = HttpResponse(status=200, body='{"status":"ok"}')
        token = "cli-secret-token-value"
        code, out, err = self._run(
            ["heartbeat"],
            {
                "SENTINEL_URL": "https://sentinel.example.com",
                "SENTINEL_AGENT_TOKEN": token,
            },
        )

        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "Heartbeat successful.")
        self.assertNotIn(token, out)
        self.assertNotIn(token, err)

    @patch("agent.heartbeat.post_json")
    def test_cli_heartbeat_401(self, mock_post):
        mock_post.return_value = HttpResponse(status=401, body="unauthorized")
        token = "cli-secret-token-value"
        code, out, err = self._run(
            ["heartbeat"],
            {
                "SENTINEL_URL": "https://sentinel.example.com",
                "SENTINEL_AGENT_TOKEN": token,
            },
        )

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("Heartbeat failed: server returned HTTP 401", err)
        self.assertNotIn(token, err)

    def test_cli_missing_url(self):
        code, out, err = self._run(
            ["heartbeat"],
            {"SENTINEL_AGENT_TOKEN": "token-only"},
        )
        self.assertEqual(code, 1)
        self.assertIn("SENTINEL_URL is not set", err)
        self.assertNotIn("token-only", err)

    def test_cli_missing_token(self):
        code, out, err = self._run(
            ["heartbeat"],
            {"SENTINEL_URL": "https://sentinel.example.com"},
        )
        self.assertEqual(code, 1)
        self.assertIn("SENTINEL_AGENT_TOKEN is not set", err)

    @patch("agent.cli.send_heartbeat")
    def test_cli_redacts_token_if_present_in_error(self, mock_send):
        token = "should-never-appear"
        mock_send.side_effect = HeartbeatError(
            f"unexpected leak {token} in message"
        )
        code, out, err = self._run(
            ["heartbeat"],
            {
                "SENTINEL_URL": "https://sentinel.example.com",
                "SENTINEL_AGENT_TOKEN": token,
            },
        )
        self.assertEqual(code, 1)
        self.assertNotIn(token, err)
        self.assertIn("***", err)


if __name__ == "__main__":
    unittest.main()

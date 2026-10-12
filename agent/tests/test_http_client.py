"""Regression tests: the agent never follows redirects with its bearer token."""

import gc
import threading
import unittest
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent.config import Config
from agent.errors import HeartbeatError
from agent.heartbeat import send_heartbeat
from agent.http_client import post_json
from agent.measurement_queue import MeasurementQueue
from agent.network_delivery import NetworkDelivery


class _Recorder(BaseHTTPRequestHandler):
    """Redirects everything when ``server.location`` is set; else records requests."""

    def log_message(self, *_args):
        pass

    def _handle(self):
        if self.server.location:
            self.send_response(self.server.redirect_status)
            self.send_header("Location", self.server.location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.server.seen.append((self.command, self.headers.get("Authorization")))
        body = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = _handle


class RedirectTests(unittest.TestCase):
    def setUp(self):
        self.origin = self._serve()
        self.elsewhere = self._serve()
        port = self.elsewhere.server_address[1]
        self.origin.location = f"http://127.0.0.1:{port}/api/v1/agent/heartbeat/"

    def _serve(self) -> ThreadingHTTPServer:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        server.seen = []
        server.redirect_status = 302
        server.location = ""
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def shutdown():
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(shutdown)
        return server

    def _origin_url(self) -> str:
        return f"http://127.0.0.1:{self.origin.server_address[1]}"

    def test_redirects_are_returned_not_followed(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.origin.redirect_status = status
                response = post_json(
                    self._origin_url() + "/api/v1/agent/heartbeat/",
                    headers={"Authorization": "Bearer secret-token"},
                    payload={},
                    timeout=5,
                )
                self.assertEqual(response.status, status)
        # The token never reached the redirect target.
        self.assertEqual(self.elsewhere.seen, [])

    def test_error_responses_are_closed(self):
        self.origin.redirect_status = 401
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", ResourceWarning)
            response = post_json(self._origin_url() + "/x/", payload={}, timeout=5)
            gc.collect()
        self.assertEqual(response.status, 401)
        self.assertEqual([w for w in caught if issubclass(w.category, ResourceWarning)], [])

    def test_redirected_heartbeat_fails_and_keeps_measurements_queued(self):
        queue = MeasurementQueue(None)
        self.addCleanup(queue.close)
        queue.enqueue({"measurement_id": "00000000-0000-4000-8000-000000000001"})
        config = Config(sentinel_url=self._origin_url(), agent_token="secret-token")
        with self.assertRaisesRegex(HeartbeatError, "redirects are not followed"):
            send_heartbeat(
                config,
                timeout=5,
                collect_fn=lambda: {},
                docker_fn=lambda: {},
                network_delivery=NetworkDelivery(queue),
            )
        self.assertEqual(self.elsewhere.seen, [])
        self.assertEqual(queue.count(), 1)


if __name__ == "__main__":
    unittest.main()

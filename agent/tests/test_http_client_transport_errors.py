"""Transport failures of ``agent.http_client.post`` against a raw TCP server.

``post`` documents that it "raises HeartbeatError on transport failures and
timeouts". The existing tests mock ``urlopen`` for that. ``http.client`` raises
errors that are not ``OSError`` (``BadStatusLine``, ``IncompleteRead``,
``InvalidURL``), and a body that stalls or is cut off while an *error* response
is being read happens inside an ``except HTTPError`` handler, so none of those
reach the ``HeartbeatError`` conversion.

The ``test_RAW_*`` tests EXPECT TO FAIL against the current code (they assert the
documented contract). The other tests describe behaviour that already holds and
guard it.

NOT EXECUTED when written: expect to fix small details.
"""

import socket
import socketserver
import threading
import unittest

from agent.errors import HeartbeatError
from agent.http_client import post_json

TOKEN = "secret-token"


class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        try:
            self.request.recv(65536)  # the request is small: one read has all of it
        except OSError:
            return
        self.server.script(self.request, self.server.release)


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class TransportErrorTests(unittest.TestCase):
    def serve(self, script) -> str:
        server = _Server(("127.0.0.1", 0), _Handler)
        server.script = script
        server.release = threading.Event()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def shutdown():
            server.release.set()
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/api/v1/agent/heartbeat/"

    def post(self, url: str, timeout: float = 2.0):
        return post_json(url, headers={"Authorization": f"Bearer {TOKEN}"}, payload={}, timeout=timeout)

    def assertHeartbeatError(self, url: str, timeout: float = 2.0) -> HeartbeatError:
        with self.assertRaises(HeartbeatError) as ctx:
            self.post(url, timeout)
        self.assertNotIn(TOKEN, str(ctx.exception))
        return ctx.exception

    # -- already correct -------------------------------------------------------------

    def test_a_server_that_closes_without_answering_is_a_connection_failure(self):
        url = self.serve(lambda sock, _release: sock.close())
        self.assertIn("connection failed", str(self.assertHeartbeatError(url)))

    def test_a_refused_connection_is_a_connection_failure(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        url = f"http://127.0.0.1:{port}/x/"
        self.assertIn("connection failed", str(self.assertHeartbeatError(url)))

    def test_a_server_that_never_answers_is_a_timeout(self):
        url = self.serve(lambda _sock, release: release.wait(5))
        self.assertIn("timed out", str(self.assertHeartbeatError(url, timeout=0.5)))

    def test_a_success_body_that_stalls_is_a_timeout(self):
        # Already handled: the read happens inside the ``try`` that maps TimeoutError.
        def script(sock, release):
            sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort")
            release.wait(5)

        self.assertIn("timed out", str(self.assertHeartbeatError(self.serve(script), timeout=0.5)))

    # -- the documented contract, currently broken -----------------------------------

    def test_RAW_a_reply_that_is_not_http_is_a_heartbeat_error(self):
        url = self.serve(lambda sock, _release: sock.sendall(b"NOT HTTP AT ALL\r\n\r\n"))
        self.assertHeartbeatError(url)

    def test_RAW_a_success_body_cut_off_before_its_content_length_is_a_heartbeat_error(self):
        def script(sock, _release):
            sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort")
            sock.close()

        self.assertHeartbeatError(self.serve(script))

    def test_RAW_an_error_body_cut_off_before_its_content_length_is_not_a_raw_exception(self):
        def script(sock, _release):
            sock.sendall(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\nshort")
            sock.close()

        url = self.serve(script)
        # Either is acceptable: the status with whatever arrived, or a HeartbeatError.
        # A raw http.client.IncompleteRead is not.
        try:
            response = self.post(url)
        except HeartbeatError:
            return
        self.assertEqual(response.status, 500)

    def test_RAW_an_error_body_that_stalls_is_not_a_raw_exception(self):
        def script(sock, release):
            sock.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100\r\n\r\nshort")
            release.wait(5)

        url = self.serve(script)
        try:
            response = self.post(url, timeout=0.5)
        except HeartbeatError:
            return
        self.assertEqual(response.status, 503)


if __name__ == "__main__":
    unittest.main()

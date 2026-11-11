"""Transport failures of ``agent.http_client.post`` against a raw TCP server.

``post`` documents that it "raises HeartbeatError on transport failures and
timeouts". The other tests mock ``urlopen`` for that. ``http.client`` raises
errors that are not ``OSError`` (``BadStatusLine``, ``IncompleteRead``,
``InvalidURL``), and a body that stalls or is cut off while an *error* response
is being read happens inside an ``except HTTPError`` handler, so none of those
reached the ``HeartbeatError`` conversion when these tests were written.

The ``test_RAW_*`` tests assert the documented contract: they were written against
that defect, before the fix, and pass against the current code. The other tests
describe behaviour that held already. All of them guard it now.
"""

import socket
import socketserver
import threading
import time
import unittest
from unittest.mock import patch

from agent.errors import HeartbeatError
from agent.http_client import post_json

TOKEN = "secret-token"
RESPONSE_LIMIT = 1024 * 1024  # the response cap the owner approved (audit A3)


def _reply(data: bytes):
    """A server script that sends ``data`` and then closes the connection."""

    def script(sock, _release):
        try:
            sock.sendall(data)
            # Close like a real server: send FIN, then read what is still coming until the client closes.
            # Closing a socket that has unread data makes the kernel send a reset instead, which can
            # destroy the reply before the client has read all of it (flaky on macOS, a 1 MiB body).
            sock.shutdown(socket.SHUT_WR)
            sock.settimeout(1.0)
            while sock.recv(65536):
                pass
        except OSError:
            pass  # the client stopped reading

    return script


def _drip(prefix: bytes, dripped: bytes, step: float = 0.05):
    """A server script that sends ``prefix``, then ``dripped`` one byte every ``step`` seconds."""

    def script(sock, release):
        try:
            sock.sendall(prefix)
            for index in range(len(dripped)):
                if release.wait(step):
                    return
                sock.sendall(dripped[index : index + 1])
        except OSError:
            pass

    return script


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

    # -- the documented contract, broken when these were written ---------------------

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

    # -- text from the server in an error message (audit A2) --------------------------

    def test_a_status_line_that_is_not_http_reaches_the_error_printable_and_short(self):
        # BadStatusLine carries the raw line (up to 64 KiB; NUL, ESC and C1 controls included) into the
        # message that the run loop logs at every heartbeat and the one-shot CLI prints.
        line = b"\x1b[2J\x00<0>forged emergency\x85\x9b" + b"x" * 5_000 + b"\r\n"
        url = self.serve(lambda sock, _release: sock.sendall(line))
        message = str(self.assertHeartbeatError(url))
        self.assertTrue(message.isprintable(), repr(message[:300]))
        self.assertIn("BadStatusLine", message)
        self.assertIn("forged emergency", message)
        self.assertLess(len(message), 300)

    # -- response size and overall deadline (audit A3) --------------------------------

    def test_the_limits_are_what_was_approved(self):
        from agent import http_client

        self.assertEqual(getattr(http_client, "MAX_RESPONSE_BYTES", None), RESPONSE_LIMIT)
        self.assertEqual(getattr(http_client, "REQUEST_DEADLINE_SECONDS", None), 30)

    def test_a_body_over_the_limit_is_refused_whatever_its_framing_or_status(self):
        too_large = b"x" * (RESPONSE_LIMIT + 1)
        replies = {
            "content-length": b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(too_large) + too_large,
            "until close": b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + too_large,
            "chunked": b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n" % len(too_large)
            + too_large
            + b"\r\n0\r\n\r\n",
            "error status": b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: %d\r\n\r\n" % len(too_large)
            + too_large,
        }
        for label, reply in replies.items():
            with self.subTest(label):
                error = self.assertHeartbeatError(self.serve(_reply(reply)))
                self.assertIn(str(RESPONSE_LIMIT), str(error))

    def test_a_body_of_exactly_the_limit_is_read_whole(self):
        body = b"x" * RESPONSE_LIMIT
        url = self.serve(_reply(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body) + body))
        response = self.post(url)
        self.assertEqual((response.status, len(response.body)), (200, RESPONSE_LIMIT))

    def assertEndsAtTheDeadline(self, script) -> None:
        # Each byte comes well within the 2 s socket timeout, so only an overall deadline (1 s here)
        # can end the request before the server is done (about 2 to 4 s).
        url = self.serve(script)
        started = time.monotonic()
        with patch("agent.http_client.REQUEST_DEADLINE_SECONDS", 1.0, create=True):
            error = self.assertHeartbeatError(url, timeout=2.0)
        self.assertEqual(str(error), "request timed out")
        self.assertLess(time.monotonic() - started, 2.0)

    def test_headers_sent_a_byte_at_a_time_end_at_the_deadline(self):
        reply = b"HTTP/1.1 200 OK\r\nX-Padding: " + b"x" * 40 + b"\r\nContent-Length: 2\r\n\r\n{}"
        self.assertEndsAtTheDeadline(_drip(b"", reply))

    def test_a_body_sent_a_byte_at_a_time_ends_at_the_deadline(self):
        body = b'{"status": "ok", "padding": "' + b"x" * 40 + b'"}'
        self.assertEndsAtTheDeadline(
            _drip(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body), body)
        )

    def test_chunk_sizes_sent_a_byte_at_a_time_end_at_the_deadline(self):
        chunks = b"0" * 40 + b"2\r\n{}\r\n0\r\n\r\n"
        self.assertEndsAtTheDeadline(
            _drip(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", chunks)
        )

    def test_an_error_body_sent_a_byte_at_a_time_ends_at_the_deadline(self):
        body = b"x" * 60
        self.assertEndsAtTheDeadline(
            _drip(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: %d\r\n\r\n" % len(body), body)
        )

    # -- a header value that http.client refuses (audit A4) ---------------------------

    def test_a_header_value_that_cannot_be_sent_is_an_error_that_does_not_repeat_it(self):
        # http.client raises ValueError("Invalid header value b'Bearer ...'"), the token escaped inside.
        url = self.serve(lambda sock, _release: sock.close())
        for token in ("first-half\nsecond-half", "first-half€second-half"):  # line break; not Latin-1
            with self.subTest(token=repr(token)):
                with self.assertRaises(HeartbeatError) as ctx:
                    post_json(url, headers={"Authorization": f"Bearer {token}"}, payload={}, timeout=2.0)
                self.assertEqual(str(ctx.exception), "invalid request header")
                # Not chained either, so a traceback cannot show it.
                self.assertIsNone(ctx.exception.__cause__)
                self.assertTrue(ctx.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()

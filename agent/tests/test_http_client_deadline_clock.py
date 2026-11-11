"""Where the response deadline of ``agent.http_client.post`` starts counting.

The deadline (``REQUEST_DEADLINE_SECONDS``) is for the *response*: it counts from the moment the
response is asked for, once the request has been sent. Name resolution, connecting, the TLS
handshake and the upload of the body are not part of it, so a server that answers the instant it has
the whole request is never reported as "request timed out" because the request was slow to reach it
(a slow resolver; a 2.5 MB backlog batch on a slow uplink). The tests use a 1 s deadline for speed.
"""

import ast
import io
import json
import pathlib
import socket
import threading
import time
import tokenize
import unittest
from unittest.mock import patch

from agent import http_client
from agent.acknowledgement import parse_acknowledgement
from agent.errors import HeartbeatError
from agent.heartbeat import log_subsystem_status
from agent.http_client import post_json

REPLY = (
    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\n"
    b'Connection: close\r\n\r\n{"status": "ok"}'
)


class _InstantServer:
    """Reads the whole request (at ``rate`` bytes per second when given), then answers at once."""

    def __init__(self, rate: float = 0.0, chunk: int = 65536) -> None:
        self.rate, self.chunk = rate, chunk
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # A small receive buffer (inherited by the accepted socket) makes the upload really wait for the reader.
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.started = time.monotonic()
        self.received_at: float | None = None  # when the whole request body had arrived
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}/api/v1/agent/heartbeat/"

    def serve(self) -> None:
        conn, _ = self.sock.accept()
        with conn:
            conn.settimeout(10)
            try:
                head = b""
                while b"\r\n\r\n" not in head:
                    piece = conn.recv(self.chunk)
                    if not piece:
                        return
                    head += piece
                header, _, body = head.partition(b"\r\n\r\n")
                length = int(
                    next(
                        line.split(b":")[1]
                        for line in header.split(b"\r\n")
                        if line.lower().startswith(b"content-length:")
                    )
                )
                while len(body) < length:
                    piece = conn.recv(self.chunk)
                    if not piece:
                        return
                    body += piece
                    if self.rate:
                        time.sleep(len(piece) / self.rate)  # however much one recv returns, the pace is the same
                self.received_at = time.monotonic() - self.started
                conn.sendall(REPLY)
            except OSError:
                return

    def close(self) -> None:
        self.sock.close()
        self.thread.join(timeout=5)


class DeadlineClockTests(unittest.TestCase):
    def post(self, url: str, payload: dict) -> http_client.HttpResponse:
        return post_json(url, headers={"Authorization": "Bearer t"}, payload=payload, timeout=5.0)

    def test_time_spent_resolving_the_name_does_not_count_against_the_response_deadline(self):
        server = _InstantServer()
        self.addCleanup(server.close)
        real = socket.getaddrinfo

        def slow(*args, **kwargs):
            time.sleep(1.3)  # a slow resolver: name resolution has no timeout of its own
            return real(*args, **kwargs)

        with patch("agent.http_client.REQUEST_DEADLINE_SECONDS", 1.0), patch("socket.getaddrinfo", slow):
            response = self.post(server.url, {})
        self.assertEqual((response.status, response.body), (200, '{"status": "ok"}'))

    def test_a_slow_upload_does_not_count_against_the_response_deadline(self):
        # 2.4 MB read at 1.6 MB/s: the request takes about 1.5 s to arrive, longer than the 1 s deadline
        # (the small receive buffer makes the sender wait for the reader). In production this is a backlog
        # batch of up to 2.5 MB on a slow uplink.
        server = _InstantServer(rate=1_600_000, chunk=160 * 1024)
        self.addCleanup(server.close)
        with patch("agent.http_client.REQUEST_DEADLINE_SECONDS", 1.0):
            response = self.post(server.url, {"pad": "x" * 2_400_000})
        self.assertEqual((response.status, response.body), (200, '{"status": "ok"}'))
        self.assertGreater(server.received_at, 1.0)  # the upload really took longer than the deadline


class DeeplyNestedAnswerTests(unittest.TestCase):
    """A 2xx body nested thousands of levels deep makes ``json.loads`` raise RecursionError, not ValueError."""

    NESTED = "[" * 200_000

    def test_the_premise_holds(self):
        with self.assertRaises(RecursionError):
            json.loads(self.NESTED)

    def test_the_acknowledgement_of_such_an_answer_is_a_batch_failure(self):
        ack = parse_acknowledgement(self.NESTED, ["id-1"])
        self.assertEqual(ack.batch_failure, "response is not valid JSON")

    def test_logging_the_subsystem_status_of_such_an_answer_does_not_raise(self):
        with self.assertLogs("sentinel_agent", level="WARNING") as logs:
            self.assertEqual(log_subsystem_status(self.NESTED), {})
        self.assertTrue(any("not valid JSON" in line for line in logs.output))


def _newer_f_string_uses(source: str) -> list[str]:
    """What ``source`` does inside f-strings that only Python 3.12 and later accept (PEP 701).

    ``ast.parse(feature_version=(3, 11))`` does not refuse these, so they are looked for in the tokens:
    inside a ``{...}`` field, a quote of the f-string used again, a backslash, a comment and, in an
    f-string that is not triple-quoted, a line break.
    """
    found: list[str] = []
    quotes: list[str] = []  # the quotes of the f-strings being read, the innermost last
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        kind = tokenize.tok_name[token.type]
        if kind == "FSTRING_END":
            quotes.pop()
            continue
        literal = token.string.lstrip("rRbBuUfF")
        quote = literal[:3] if literal[:3] in ('"""', "'''") else literal[:1]
        # FSTRING_MIDDLE is the text (or the format) of an f-string; one level down it is in a field too.
        if quotes and (kind != "FSTRING_MIDDLE" or len(quotes) > 1):
            where = f"line {token.start[0]}"
            if kind in ("STRING", "FSTRING_START"):
                for outer in quotes:
                    if quote[0] == outer[0] and (len(outer) == 1 or len(quote) == 3):
                        found.append(f"{where}: the quote {outer} of an f-string is used again inside it")
            if "\\" in token.string:
                found.append(f"{where}: a backslash inside a field of an f-string")
            if kind == "COMMENT":
                found.append(f"{where}: a comment inside a field of an f-string")
            if kind == "NL" and any(len(outer) == 1 for outer in quotes):
                found.append(f"{where}: a line break inside a field of an f-string")
        if kind == "FSTRING_START":
            quotes.append(quote)
    return found


class Python311GrammarTests(unittest.TestCase):
    root = pathlib.Path(__file__).resolve().parents[1]

    def files(self) -> list[pathlib.Path]:
        # Only a build directory inside the package is skipped, not a checkout that lives under one.
        files = [p for p in self.root.rglob("*.py") if "build" not in p.relative_to(self.root).parts]
        self.assertGreater(len(files), 40)
        return files

    def test_every_agent_module_parses_with_the_3_11_grammar(self):
        # Best effort: ast.parse(feature_version=(3, 11)) refuses PEP 695 generics and ``type`` statements.
        # It accepts the PEP 701 f-strings that 3.12 added (the next test looks for those). Differences in
        # the libraries are not covered.
        for path in self.files():
            with self.subTest(path=str(path.relative_to(self.root))):
                ast.parse(path.read_text(encoding="utf-8"), filename=str(path), feature_version=(3, 11))
        with self.assertRaises(SyntaxError):  # the check does bite on 3.12 grammar
            ast.parse("type X = int", feature_version=(3, 11))

    @unittest.skipUnless(
        hasattr(tokenize, "FSTRING_START"), "Python 3.11 itself refuses these f-strings when it runs the tests"
    )
    def test_no_agent_module_uses_what_f_strings_accept_only_since_3_12(self):
        for path in self.files():
            with self.subTest(path=str(path.relative_to(self.root))):
                self.assertEqual(_newer_f_string_uses(path.read_text(encoding="utf-8")), [])
        newer = (
            'f"{"a"}"',  # the quote again
            "f'{d['k']}'",
            'f"{f"{x}"}"',
            'f"""{"""a"""}"""',
            "f\"{f'{\"a\"}'}\"",  # the quote of the outer one, two levels down
            "f\"{'\\n'.join(x)}\"",  # a backslash
            "f\"{f'a\\n'}\"",
            'f"""{x  # a comment\n}"""',
            'f"{x +\n 1}"',  # a line break
        )
        for source in newer:  # the check does bite
            with self.subTest(source=source):
                self.assertNotEqual(_newer_f_string_uses(source), [])
        accepted_by_3_11 = (
            "f\"{'a'}\"",
            "f'{d[\"k\"]!r:>{width}}'",
            'f"""{"a"} {\'b\'}"""',
            "f'''{x +\n 1}'''",
            'f"{x}\\n" "\\t"',
            "f\"{f'{x}'}\"",
            "'{\"a\"}' + \"{'\\n'}\"",  # not f-strings
        )
        for source in accepted_by_3_11:
            with self.subTest(source=source):
                self.assertEqual(_newer_f_string_uses(source), [])


if __name__ == "__main__":
    unittest.main()

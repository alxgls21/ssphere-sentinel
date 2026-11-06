"""Minimal HTTP client for the agent (stdlib only)."""

from __future__ import annotations

import functools
import http.client
import io
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping

from agent import __version__
from agent.errors import HeartbeatError, RequestTooLargeError, safe_text

DEFAULT_TIMEOUT_SECONDS = 10.0
USER_AGENT = f"SSphere-Sentinel-Agent/{__version__}"

# The most bytes of JSON the agent puts in one request body. Django refuses a
# body over ``DATA_UPLOAD_MAX_MEMORY_SIZE`` (2,621,440 by default, which
# Sentinel does not change) with HTTP 400 before it records anything, so every
# request is kept below it, measured in the bytes that are sent. A reverse proxy
# may refuse less: see docs/server-deployment.md.
MAX_REQUEST_BYTES = 2_500_000

# The most bytes of a response body the agent reads. Sentinel's answer to the largest request is a
# few KB; a longer body is not read further and the request fails.
MAX_RESPONSE_BYTES = 1024 * 1024
# How long the response to one request may take to arrive, status line, headers and body together,
# counted from the moment the response is asked for, that is once the request has been sent (name
# resolution, connecting, the TLS handshake and the upload of the body are not part of it: they have
# the per-operation ``timeout``). ``timeout`` bounds each socket operation only: without this a
# server that sends a byte now and then could hold a heartbeat (and the agent's stop) indefinitely.
REQUEST_DEADLINE_SECONDS = 30.0


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: str


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects.

    urllib would re-send the ``Authorization`` header to whatever host the
    ``Location`` names (even over plain HTTP) and silently turn the POST into
    a body-less GET. A 3xx is returned to the caller as a failed request.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _DeadlineReader(io.RawIOBase):
    """What a response reads from its socket, until the request's deadline.

    Every read of a response passes here: status line, headers, chunk sizes and body. Each one waits
    at most for the time that is left (and never longer than the socket's own timeout); once the
    deadline has passed none starts, and the request ends with ``TimeoutError`` like any timeout.
    """

    def __init__(self, stream: Any, sock: Any, deadline: float) -> None:
        super().__init__()
        self._stream = stream  # what the response opened on the socket; it keeps the socket open
        self._sock = sock
        self._timeout = sock.gettimeout()
        self._deadline = deadline

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        left = self._deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("request deadline passed")
        self._sock.settimeout(left if self._timeout is None else min(self._timeout, left))
        return self._stream.readinto1(buffer)

    def fileno(self) -> int:
        return self._stream.fileno()

    def close(self) -> None:
        if not self.closed:
            self._stream.close()
        super().close()


class _DeadlineResponse(http.client.HTTPResponse):
    """``HTTPResponse`` that reads through ``_DeadlineReader``."""

    def __init__(self, sock: Any, *args: Any, budget: float, **kwargs: Any) -> None:
        # Created when the response is asked for (``getresponse``), after the request was sent, so
        # ``budget`` seconds are counted from that moment.
        super().__init__(sock, *args, **kwargs)
        self.fp = io.BufferedReader(_DeadlineReader(self.fp, sock, time.monotonic() + budget))


class _DeadlineHandler:
    """Makes the connections of a request read their responses with ``_DeadlineResponse``."""

    def do_open(self, http_class: Any, req: Any, **http_conn_args: Any) -> Any:
        def connection(*args: Any, **kwargs: Any) -> Any:
            conn = http_class(*args, **kwargs)
            conn.response_class = functools.partial(_DeadlineResponse, budget=REQUEST_DEADLINE_SECONDS)
            return conn

        return super().do_open(connection, req, **http_conn_args)  # type: ignore[misc]


class _HTTPHandler(_DeadlineHandler, urllib.request.HTTPHandler):
    pass


class _HTTPSHandler(_DeadlineHandler, urllib.request.HTTPSHandler):
    pass


# Subclasses of the default HTTP and HTTPS handlers replace them; everything else stays the default.
_opener = urllib.request.build_opener(_NoRedirectHandler, _HTTPHandler, _HTTPSHandler)


def post(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> HttpResponse:
    """Send an HTTP POST and return status/body.

    Raises HeartbeatError on transport failures and timeouts. Non-2xx
    responses (including redirects, which are never followed) are returned
    to the caller for handling. A body over ``MAX_REQUEST_BYTES`` is never
    sent: every request passes this check, on the bytes that would go out.
    A response must arrive within ``REQUEST_DEADLINE_SECONDS`` of the moment
    the request has been sent and its body must not exceed
    ``MAX_RESPONSE_BYTES``; otherwise the request fails (HeartbeatError).
    """
    if body is not None and len(body) > MAX_REQUEST_BYTES:
        raise RequestTooLargeError(
            f"request body is {len(body)} bytes, over the limit of {MAX_REQUEST_BYTES} bytes; "
            "nothing was sent"
        )
    request_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(
        url,
        data=body if body is not None else b"",
        headers=request_headers,
        method="POST",
    )

    try:
        with _opener.open(request, timeout=timeout) as response:
            text = _read_body(response).decode("utf-8", errors="replace")
            return HttpResponse(status=response.status, body=text)
    except urllib.error.HTTPError as exc:
        # The error wraps the open response; close it so the socket is
        # released now rather than by the garbage collector.
        # An exception raised here skips the sibling ``except`` clauses below,
        # so a truncated or stalled error body is mapped here.
        try:
            raw = _read_body(exc)
        except TimeoutError as read_exc:
            raise HeartbeatError("request timed out") from read_exc
        except (OSError, http.client.HTTPException) as read_exc:
            raise _connection_failed(read_exc) from read_exc
        finally:
            exc.close()
        text = raw.decode("utf-8", errors="replace") if raw else ""
        return HttpResponse(status=exc.code, body=text)
    except TimeoutError as exc:
        raise HeartbeatError("request timed out") from exc
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, TimeoutError):
            raise HeartbeatError("request timed out") from exc
        # Never include request headers (may contain Authorization).
        message = str(reason) if reason is not None else str(exc)
        raise HeartbeatError(f"connection failed: {safe_text(message)}") from exc
    except (OSError, http.client.HTTPException) as exc:
        # HTTPException (BadStatusLine, IncompleteRead, InvalidURL, ...) is
        # not an OSError.
        raise _connection_failed(exc) from exc
    except ValueError:
        # http.client refuses a header value it cannot send (a line break, a character outside
        # Latin-1) with a message that repeats the value, token included. None of it is passed on,
        # and ``from None`` keeps it out of tracebacks too.
        raise HeartbeatError("invalid request header") from None


def _read_body(response: Any) -> bytes:
    """The body of ``response``, at most ``MAX_RESPONSE_BYTES``: a longer one is not read further."""
    body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise HeartbeatError(
            f"response body is larger than {MAX_RESPONSE_BYTES} bytes; not read further"
        )
    # read(n) returns a body cut short of its Content-Length as it is; read() raises IncompleteRead.
    response.read()
    return body


def _connection_failed(exc: BaseException) -> HeartbeatError:
    """``connection failed`` with the class of ``exc`` and its text, printable and short.

    The text can come from the server: ``BadStatusLine`` carries whatever line came instead of a
    status line (up to 64 KiB, control characters included), and the run loop logs the error.
    """
    return HeartbeatError(f"connection failed: {type(exc).__name__}: {safe_text(exc)}")


def encode_json(value: Any) -> bytes:
    """The JSON bytes of a request body.

    The one serialization a request is sent in and the one its size is measured
    in (``encoded_size``): the standard library defaults, so every non-ASCII
    character is a ``\\u`` escape (6 bytes for a Greek letter or a Chinese
    character, 12 for an emoji) and ``,`` and ``:`` are followed by a space.
    """
    return json.dumps(value).encode("utf-8")


def encoded_size(value: Any) -> int:
    """How many bytes ``value`` takes in a request body."""
    return len(encode_json(value))


def size_with_member(size: int, has_members: bool, key: str, value_size: int) -> int:
    """The size of a JSON object after it gets one more member.

    The object takes ``size`` bytes (``has_members`` unless it is ``{}``); the new
    member is ``key`` with a value that takes ``value_size`` bytes. Serialized
    JSON is the sum of its parts: the member adds its key, ``": "``, its value and,
    after another member, ``", "``. Exact, and it needs no serialization of the
    object again.
    """
    return size + (2 if has_members else 0) + encoded_size(key) + 2 + value_size


def post_json(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    payload: dict | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> HttpResponse:
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    body = encode_json(payload if payload is not None else {})
    return post(url, headers=request_headers, body=body, timeout=timeout)

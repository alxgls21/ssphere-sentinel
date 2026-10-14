"""Minimal HTTP client for the agent (stdlib only)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping

from agent import __version__
from agent.errors import HeartbeatError, RequestTooLargeError

DEFAULT_TIMEOUT_SECONDS = 10.0
USER_AGENT = f"SSphere-Sentinel-Agent/{__version__}"

# The most bytes of JSON the agent puts in one request body. Django refuses a
# body over ``DATA_UPLOAD_MAX_MEMORY_SIZE`` (2,621,440 by default, which
# Sentinel does not change) with HTTP 400 before it records anything, so every
# request is kept below it, measured in the bytes that are sent. A reverse proxy
# may refuse less: see docs/server-deployment.md.
MAX_REQUEST_BYTES = 2_500_000


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


_opener = urllib.request.build_opener(_NoRedirectHandler)


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
            raw = response.read()
            text = raw.decode("utf-8", errors="replace")
            return HttpResponse(status=response.status, body=text)
    except urllib.error.HTTPError as exc:
        # The error wraps the open response; close it so the socket is
        # released now rather than by the garbage collector.
        try:
            raw = exc.read()
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
        raise HeartbeatError(f"connection failed: {message}") from exc
    except OSError as exc:
        raise HeartbeatError(f"connection failed: {exc}") from exc


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

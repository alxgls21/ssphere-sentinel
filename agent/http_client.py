"""Minimal HTTP client for the agent (stdlib only)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Mapping

from agent import __version__
from agent.errors import HeartbeatError

DEFAULT_TIMEOUT_SECONDS = 10.0
USER_AGENT = f"SSphere-Sentinel-Agent/{__version__}"


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: str


def post(
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> HttpResponse:
    """Send an HTTP POST and return status/body.

    Raises HeartbeatError on transport failures and timeouts. Non-2xx
    responses are returned to the caller for handling.
    """
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
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            text = raw.decode("utf-8", errors="replace")
            return HttpResponse(status=response.status, body=text)
    except urllib.error.HTTPError as exc:
        raw = exc.read() if hasattr(exc, "read") else b""
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
    body = json.dumps(payload if payload is not None else {}).encode("utf-8")
    return post(url, headers=request_headers, body=body, timeout=timeout)

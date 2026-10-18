"""JSON plumbing shared by every console endpoint.

The console API answers JSON for everything under ``/api/v1/console/``,
errors included, with one error shape::

    {"error": {"code": "unauthenticated", "message": "Sign in to continue."}}

A request whose values are wrong also says which, field by field (never echoing
what was sent)::

    {"error": {"code": "validation_error", "message": "...", "fields": {"name": ["..."]}}}

Responses are never cached (they are per-user) and vary on the cookie. "Everything"
means everything that reaches a console view: the few responses Django's
middleware produces first (a rejected ``Host`` header, an HTTPS redirect, the
trailing-slash redirect) are Django's own and carry no data.
"""

from __future__ import annotations

import json
import logging
import time
from functools import wraps

from django.conf import settings
from django.core.exceptions import BadRequest, PermissionDenied, SuspiciousOperation
from django.http import Http404, HttpRequest, JsonResponse
from django.utils.cache import add_never_cache_headers, patch_vary_headers
from django.views.csrf import csrf_failure as default_csrf_failure

from apps.console.access import USE_CONSOLE, NotVisible, Visibility

logger = logging.getLogger("apps.console")

API_PREFIX = "/api/v1/console/"
# Set in the session by the console's own sign-in (value: epoch seconds). A
# session created anywhere else (the admin login, say) is not a console session.
CONSOLE_SESSION_KEY = "console_signed_in_at"
CLOCK_SKEW_SECONDS = 60


class ApiError(Exception):
    """An error that is answered as JSON with ``status``."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        headers: dict[str, str] | None = None,
        fields: dict[str, list[str]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}
        self.fields = fields


def validation_error(fields: dict[str, list[str]]) -> ApiError:
    return ApiError(400, "validation_error", "Some values are not valid.", fields=fields)


def error_response(
    status: int, code: str, message: str, headers: dict[str, str] | None = None, fields: dict | None = None
) -> JsonResponse:
    error = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    response = JsonResponse({"error": error}, status=status)
    for name, value in (headers or {}).items():
        response[name] = value
    return response


def harden(response):
    add_never_cache_headers(response)
    patch_vary_headers(response, ("Cookie",))
    return response


def has_console_session(request: HttpRequest) -> bool:
    """True if the session was created by the console sign-in and is within its lifetime.

    The lifetime is checked here as well as by the session's own expiry, so
    it holds even for a session whose cookie outlives it.
    """
    signed_in_at = request.session.get(CONSOLE_SESSION_KEY)
    if isinstance(signed_in_at, bool) or not isinstance(signed_in_at, int):
        return False
    # Integer arithmetic (a huge value must not overflow a float), with a minute
    # of allowance for clocks that differ slightly or step back.
    age = int(time.time()) - signed_in_at
    return -CLOCK_SKEW_SECONDS <= age <= settings.SENTINEL_CONSOLE_SESSION_SECONDS


def require_console_user(request: HttpRequest):
    """The signed-in user with console access, or an ``ApiError``.

    Only the console session is consulted. The ``Authorization`` header (agent
    tokens) is never read here, a session that did not come from the console
    sign-in does not count, and a console session is never accepted by the
    agent endpoints.
    """
    user = request.user
    if not user.is_authenticated or not user.is_active or not has_console_session(request):
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    if not user.has_perm(USE_CONSOLE):
        raise ApiError(403, "forbidden", "This account may not use the console.")
    return user


def console_api(*, methods: tuple[str, ...] = ("GET",), authenticated: bool = True):
    """Decorator for console views: method check, session auth, JSON errors, no caching.

    An authenticated view gets ``request.visibility`` (what the user may see).
    POST views stay subject to CSRF protection (they are never ``csrf_exempt``).
    """
    allowed = set(methods) | ({"HEAD"} if "GET" in methods else set())

    def decorator(view):
        @wraps(view)
        def wrapper(request: HttpRequest, *args, **kwargs):
            try:
                if request.method not in allowed:
                    raise ApiError(
                        405,
                        "method_not_allowed",
                        "Method not allowed.",
                        headers={"Allow": ", ".join(sorted(allowed))},
                    )
                if authenticated:
                    user = require_console_user(request)
                    request.visibility = Visibility.for_user(user)
                response = view(request, *args, **kwargs)
            except ApiError as exc:
                response = error_response(exc.status, exc.code, exc.message, exc.headers, exc.fields)
            except (NotVisible, Http404):
                # Hidden and non-existent look the same: ids cannot be probed.
                response = error_response(404, "not_found", "Not found.")
            except PermissionDenied:
                response = error_response(403, "forbidden", "You do not have permission to do this.")
            except (SuspiciousOperation, BadRequest) as exc:
                logger.warning("Console API rejected a request: %s (%s %s)", exc.__class__.__name__, request.method, request.path_info)
                response = error_response(400, "bad_request", "The request could not be understood.")
            except Exception:  # noqa: BLE001 - the API must answer JSON, never an HTML 500
                logger.exception("Console API error on %s %s", request.method, request.path)
                response = error_response(500, "internal_error", "The server could not complete the request.")
            return harden(response)

        return wrapper

    return decorator


def json_object(request: HttpRequest, *, max_bytes: int = 8192, empty: bool = False) -> dict:
    """The body of a write request: a JSON object (``{}`` for no body, if ``empty``), at most ``max_bytes``."""
    content_type = (request.content_type or "").lower()
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise ApiError(400, "invalid_request", "The Content-Length header is not valid.") from None
    if declared > max_bytes:
        raise ApiError(413, "payload_too_large", "The request is too large.")
    if empty:
        # No body at all, whatever it says it is, or an empty form (what some clients send
        # for a POST without data).
        if content_type == "multipart/form-data":
            if not request.POST and not request.FILES:
                return {}
        elif not request.body:
            return {}
    if content_type != "application/json":
        raise ApiError(415, "unsupported_media_type", "Send the body as application/json.")
    if len(request.body) > max_bytes:
        raise ApiError(413, "payload_too_large", "The request is too large.")
    try:
        data = json.loads(request.body)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_request", "The body must be a JSON object.")
    return data


def request_scope(request: HttpRequest):
    """The ``customer`` / ``site`` query parameters, validated against the user's grants.

    A hidden, unknown or malformed id is a 404 (:class:`NotVisible`, mapped by
    ``console_api``). Use it in every data view that accepts a scope.
    """
    return request.visibility.resolve_scope(request.GET.get("customer"), request.GET.get("site"))


def not_found(request: HttpRequest, *args, **kwargs) -> JsonResponse:
    """Unknown console URL, as JSON."""
    return harden(error_response(404, "not_found", "Not found."))


def csrf_failure(request: HttpRequest, reason: str = "", **kwargs):
    """CSRF rejections are JSON under the console prefix, Django's page elsewhere."""
    if request.path_info.startswith(API_PREFIX):
        return harden(
            error_response(403, "csrf_failed", "The request could not be verified. Reload and try again.")
        )
    return default_csrf_failure(request, reason=reason, **kwargs)

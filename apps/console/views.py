"""Console API endpoints: session, sign-in, sign-out and scope."""

from __future__ import annotations

import json
import logging
import time
import unicodedata

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.hashers import make_password
from django.conf import settings
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from apps.console import throttle
from apps.console.access import USE_CONSOLE
from apps.console.http import (
    CONSOLE_SESSION_KEY,
    ApiError,
    console_api,
    has_console_session,
    require_console_user,
)
from apps.console.serializers import scope_payload, session_payload

logger = logging.getLogger("apps.console")

MAX_BODY_BYTES = 4096
MAX_USERNAME_LENGTH = 150
MAX_PASSWORD_LENGTH = 1024


@console_api(authenticated=False)
@ensure_csrf_cookie
def session(request):
    """The session bootstrap: always 200, so the UI always gets its CSRF token.

    ``authenticated`` is true only for a console session of a user who may use
    the console. A session without console access answers ``authenticated:
    false`` with ``reason: "no_console_access"``; one that did not come from
    the console sign-in (the admin's, say) is simply anonymous here.
    """
    user = request.user
    if user.is_authenticated and user.is_active and has_console_session(request):
        if user.has_perm(USE_CONSOLE):
            return JsonResponse(session_payload(request, user))
        return JsonResponse(session_payload(request, reason="no_console_access"))
    return JsonResponse(session_payload(request))


@console_api(methods=("POST",), authenticated=False)
def sign_in(request):
    username, password = _credentials(request)
    User = get_user_model()
    account = User.objects.filter(**{User.USERNAME_FIELD: username}).first()
    user_pk = account.pk if account else None
    key = throttle.throttle_key(username, user_pk)

    locked = throttle.begin_attempt(key, timezone.now(), user_id=user_pk) is not None
    # Decided before any password is looked at: only an active account that may
    # use the console, and is not locked, has its password compared with the
    # stored hash. For every other case a hash is computed at the current cost
    # (the work ModelBackend does for an unknown name) and the attempt is
    # refused. Comparing would leak whether the password was right, through
    # timing and through the rehash of an out-of-date stored hash, for
    # accounts that can never sign in anyway (see apps.console.throttle).
    eligible = account is not None and account.is_active and account.has_perm(USE_CONSOLE)
    if locked or not eligible:
        make_password(password)
        user = None
    else:
        user = authenticate(request, username=username, password=password)
    if user is None or not user.has_perm(USE_CONSOLE):
        logger.warning("Console sign-in failed (account=%s, locked=%s)", key, locked)
        raise ApiError(
            401,
            "invalid_credentials",
            "Invalid user name or password, or the account is temporarily locked after repeated failures.",
        )

    request.session.flush()  # start from an empty session: nothing set before sign-in survives it
    login(request, user)  # new session key, new CSRF token
    request.session[CONSOLE_SESSION_KEY] = int(time.time())
    request.session.set_expiry(settings.SENTINEL_CONSOLE_SESSION_SECONDS)
    throttle.clear(key)
    logger.info("Console sign-in (user_id=%s)", user.pk)
    return JsonResponse(session_payload(request, user))


@console_api(methods=("POST",), authenticated=False)
def sign_out(request):
    logout(request)
    return JsonResponse(session_payload(request))


@console_api()
def scope(request):
    return JsonResponse(scope_payload(request.visibility))


def _credentials(request) -> tuple[str, str]:
    content_type = (request.content_type or "").lower()
    if content_type != "application/json":
        raise ApiError(415, "unsupported_media_type", "Send the credentials as application/json.")
    try:
        declared = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        raise ApiError(400, "invalid_request", "The Content-Length header is not valid.") from None
    if declared > MAX_BODY_BYTES:
        raise ApiError(413, "payload_too_large", "The request is too large.")
    body = request.body
    if len(body) > MAX_BODY_BYTES:
        raise ApiError(413, "payload_too_large", "The request is too large.")
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_request", "The body must be a JSON object.")
    username, password = data.get("username"), data.get("password")
    if not _acceptable_text(username) or not _acceptable_text(password):
        raise ApiError(400, "invalid_request", "username and password are required.")
    # The same normalization the admin login form applies to a user name.
    username = unicodedata.normalize("NFKC", username.strip())
    if not 1 <= len(username) <= MAX_USERNAME_LENGTH or not 1 <= len(password) <= MAX_PASSWORD_LENGTH:
        raise ApiError(400, "invalid_request", "username and password are required.")
    return username, password


def _acceptable_text(value) -> bool:
    """A string PostgreSQL and the password hashers can handle (no NUL, no lone surrogates)."""
    if not isinstance(value, str) or "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True

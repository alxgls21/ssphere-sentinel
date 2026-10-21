"""First-run setup: the first administrator, created from the console with a one-time code.

While the installation has no user at all, the web service makes a setup code at every start
(``manage.py setup_code``) and prints it in its log: only someone who can read the server's logs (who has Docker
on the server) can create the first administrator, even when the console is already on the internet. The code is
12 characters of a 32-letter alphabet (60 bits), stored as a hash; a new one replaces the old at every start.

    GET  /api/v1/console/setup/   {"required": bool}: whether the installation has no user yet
    POST /api/v1/console/setup/   {code, username, email, password}: the first administrator, signed in;
                                  200 with the session payload, as a sign-in answers

A POST is subject to CSRF (the token of ``/session/``) and to the sign-in throttle, under a key of its own:
SENTINEL_CONSOLE_LOGIN_MAX_ATTEMPTS wrong codes, then a lockout. The administrator is created in one transaction
that holds the code's row: of two requests at once, one creates it and the other finds no setup pending. Once any
user exists, the code is gone and a POST answers 404, like any path that does not exist.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
import unicodedata

from django.conf import settings
from django.contrib.auth import get_user_model, login
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from apps.console import throttle
from apps.console.http import CONSOLE_SESSION_KEY, ApiError, console_api, json_object, validation_error
from apps.console.models import SetupCode
from apps.console.serializers import session_payload

logger = logging.getLogger("apps.console")

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # no 0/O or 1/I to confuse
GROUPS, GROUP_LENGTH = 3, 4
THROTTLE_KEY = "setup"
MAX_BODY_BYTES = 4096
MAX_TEXT = 1024


def new_code() -> str:
    return "-".join(
        "".join(secrets.choice(ALPHABET) for _ in range(GROUP_LENGTH)) for _ in range(GROUPS)
    )


def code_hash(code: str) -> str:
    normalized = "".join(code.split()).replace("-", "").upper()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def required() -> bool:
    return not get_user_model().objects.exists()


def prepare() -> str | None:
    """A new setup code while there is no user (the old one no longer works), else none, and none stored."""
    with transaction.atomic():
        SetupCode.objects.select_for_update().all().delete()
        if not required():
            return None
        code = new_code()
        SetupCode.objects.create(code_hash=code_hash(code))
        return code


@console_api(methods=("GET", "POST"), authenticated=False)
@ensure_csrf_cookie
def setup(request):
    if request.method != "POST":
        return JsonResponse({"required": required()})
    data = json_object(request, max_bytes=MAX_BODY_BYTES)
    code, username, email, password = (data.get(name) for name in ("code", "username", "email", "password"))
    if not all(_text(value) for value in (code, username, password)) or not (email is None or _text(email)):
        raise ApiError(400, "invalid_request", "code, username and password are required; email is text.")
    username = unicodedata.normalize("NFKC", username.strip())
    email = (email or "").strip()

    if not SetupCode.objects.exists():
        raise ApiError(404, "not_found", "Not found.")
    if throttle.begin_attempt(THROTTLE_KEY, timezone.now()) is not None:
        raise ApiError(429, "too_many_attempts", "Too many wrong setup codes. Wait a while, then try again.")

    User = get_user_model()
    with transaction.atomic():
        stored = SetupCode.objects.select_for_update().first()
        if stored is None or User.objects.exists():
            raise ApiError(404, "not_found", "Not found.")
        if not hmac.compare_digest(stored.code_hash, code_hash(code)):
            logger.warning("Console setup: wrong setup code")
            raise ApiError(400, "invalid_code", "The setup code is not valid. The server's log has the current one.")
        user = User(username=username, email=email, is_staff=True, is_superuser=True)
        fields = _problems(user, password)
        if not fields:
            user.set_password(password)
            user.save()
            stored.delete()
    # The right code: whatever was wrong is the account's, and no longer counts as a guess.
    throttle.clear(THROTTLE_KEY)
    if fields:
        raise validation_error(fields)

    request.session.flush()
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session[CONSOLE_SESSION_KEY] = int(time.time())
    request.session.set_expiry(settings.SENTINEL_CONSOLE_SESSION_SECONDS)
    logger.info("Console setup: first administrator created (user_id=%s)", user.pk)
    return JsonResponse(session_payload(request, user))


def _problems(user, password: str) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    try:
        user.clean_fields(exclude=["password", "last_login", "date_joined"])
    except ValidationError as error:
        for name, messages in error.message_dict.items():
            if name in ("username", "email"):
                fields[name] = list(messages)
    if user.email:
        try:
            validate_email(user.email)
        except ValidationError as error:
            fields.setdefault("email", list(error.messages))
    try:
        validate_password(password, user)
    except ValidationError as error:
        fields["password"] = list(error.messages)
    return fields


def _text(value) -> bool:
    """A string PostgreSQL and the password hashers can handle, of a sane length."""
    if not isinstance(value, str) or "\x00" in value or not value.strip() or len(value) > MAX_TEXT:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True

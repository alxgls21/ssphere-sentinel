"""A console user's own email settings: ``GET/PUT /settings/notifications/me/``, and test emails:
``POST /settings/notifications/test-email/``, ``GET /settings/notifications/test-email/<id>/``.

Every console user manages their own preferences, and nobody else's (there is no id
in the path). The address is the account's own, never one sent in a request: it is
read-only here (an administrator sets it on the account).

Preferences::

    {"generatedAt",
     "preferences": {"enabled": bool, "minSeverity": critical | warning, "sendRecovery": bool,
                     "updatedAt": str | null},
     "account": {"email": str | null},
     "email": {"available": bool, "deliverable": bool},
     "testEmail": {"allowed": bool, "latest": TestEmail | null}}

``enabled`` false with ``updatedAt`` null: no subscription yet (the defaults are shown).
``email.available``: this server sends email (an SMTP server is set); ``deliverable``:
and the account has an address. Incident emails go to subscribers who may see the
incident's site, checked again just before each is sent.

``PUT`` with the CSRF token and a JSON object of exactly ``enabled``, ``minSeverity`` and
``sendRecovery``: the preferences become those (a change is recorded in the
configuration trail), emails on or off. 409 ``no_email_address`` to turn emails on
without an address on the account; an account without one keeps no preferences until
it has one (switching off is always accepted). Invalid values: 400 ``validation_error``
with ``fields``.

Test email: ``POST`` with the CSRF token and no body (or ``{}``) asks for one test email
to the account's own address, sent by the notifier (the web process never talks to the
SMTP server: it does not hold the password). It needs ``alerts.send_test_email`` (else
403). 409 ``email_disabled`` when this server sends no email, ``no_email_address``
without an address, ``test_email_pending`` while one is still pending or being sent;
429 ``rate_limited`` within a minute of the last one (``Retry-After`` says when). 202
otherwise, with ``Location`` and::

    {"generatedAt", "item": TestEmail, "notifier": {"state": NotifierStatus.state}}

TestEmail::

    {"id", "status": pending | sending | sent | failed | cancelled | expired,
     "failure": {"category", "label"} | null, "createdAt", "expiresAt", "finishedAt": str | null}

A request no notifier has taken within ten minutes expires (``notifier.state`` tells
whether one is running). The notifier checks the account again before sending: an
account that is inactive, has lost its address or console access is ``cancelled``
(``recipient_unavailable``), one that has lost the permission too (``not_permitted``).
It is sent once: a failure is the answer, by category (the SMTP categories of incident
emails), never the server's own message. ``GET`` reads one of the user's own requests
(another user's is a 404).
"""

from __future__ import annotations

import logging
import math
from uuid import UUID

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts import audit
from apps.alerts.models import ConfigurationSource, NotificationSubscription, TestEmailFailure, TestEmailRequest
from apps.alerts.notifications import (
    SEND_TEST_EMAIL,
    TEST_EMAIL_EVERY,
    TEST_EMAIL_EXPIRY,
    email_enabled,
    expire_test_emails,
)
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.params import QueryParams
from apps.console.serializers import iso
from apps.console.system import notifier_status_payload

logger = logging.getLogger("apps.console")

SEVERITIES = tuple(NotificationSubscription.MinSeverity.values)
PREFERENCES = ("enabled", "minSeverity", "sendRecovery")
DEFAULTS = {"enabled": False, "minSeverity": NotificationSubscription.MinSeverity.CRITICAL.value, "sendRecovery": False}


def _iso(value) -> str | None:
    return iso(value) if value is not None else None


def serialize_test_email(row: TestEmailRequest) -> dict:
    failure = None
    if row.failure:
        failure = {"category": row.failure, "label": TestEmailFailure(row.failure).label}
    return {
        "id": str(row.pk),
        "status": row.status,
        "failure": failure,
        "createdAt": iso(row.created_at),
        "expiresAt": iso(row.expires_at),
        "finishedAt": _iso(row.finished_at),
    }


def preferences_payload(request, now) -> dict:
    user = request.user
    subscription = NotificationSubscription.objects.filter(user=user).first()
    preferences = (
        {
            "enabled": subscription.enabled,
            "minSeverity": subscription.min_severity,
            "sendRecovery": subscription.send_recovery,
            "updatedAt": iso(subscription.updated_at),
        }
        if subscription is not None
        else {**DEFAULTS, "updatedAt": None}
    )
    expire_test_emails(now, user_id=user.pk)
    latest = TestEmailRequest.objects.filter(requested_by=user).order_by("-created_at", "-pk").first()
    available = email_enabled()
    return {
        "generatedAt": iso(now),
        "preferences": preferences,
        "account": {"email": user.email or None},
        "email": {"available": available, "deliverable": available and bool(user.email)},
        "testEmail": {
            "allowed": user.has_perm(SEND_TEST_EMAIL),
            "latest": serialize_test_email(latest) if latest is not None else None,
        },
    }


def parse_preferences(data: dict) -> dict:
    errors: dict[str, list[str]] = {}
    for name in sorted(set(data) - set(PREFERENCES)):
        errors[name] = ["Unknown field."]
    for name in PREFERENCES:
        if name not in data:
            errors[name] = ["Required."]
    for name in ("enabled", "sendRecovery"):
        if name in data and not isinstance(data[name], bool):
            errors[name] = ["Expected true or false."]
    if "minSeverity" in data and data["minSeverity"] not in SEVERITIES:
        errors["minSeverity"] = [f"Expected one of {', '.join(SEVERITIES)}."]
    if errors:
        raise validation_error(errors)
    return {"enabled": data["enabled"], "min_severity": data["minSeverity"], "send_recovery": data["sendRecovery"]}


@console_api(methods=("GET", "PUT"))
def my_preferences(request):
    now = timezone.now()
    QueryParams(request, ())
    if request.method == "PUT":
        save_preferences(request, parse_preferences(json_object(request)))
    return JsonResponse(preferences_payload(request, now))


def save_preferences(request, values: dict) -> None:
    user = request.user
    try:
        with transaction.atomic():
            subscription = NotificationSubscription.objects.select_for_update().filter(user=user).first()
            if subscription is None and not user.email and not values["enabled"]:
                return  # nothing to switch off; preferences need an address to be kept
            if values["enabled"] and not user.email:
                raise ApiError(
                    409, "no_email_address", "This account has no email address. Ask an administrator to add one."
                )
            before = audit.subscription_values(subscription)
            if subscription is None:
                subscription = NotificationSubscription(user=user)
            for field, value in values.items():
                setattr(subscription, field, value)
            if user.email:
                subscription.save()  # validated by the model: an address and console access
            else:
                # Switching emails off on an account without an address: nothing to validate it against.
                NotificationSubscription.objects.filter(pk=subscription.pk).update(**values, updated_at=timezone.now())
                subscription.refresh_from_db()
            audit.subscription_saved(user, subscription, before, source=ConfigurationSource.CONSOLE)
    except ValidationError as error:
        raise validation_error({"nonField": error.messages}) from None
    except IntegrityError:
        # Created meanwhile by another request of the same user: theirs stands.
        raise ApiError(409, "conflict", "Your preferences were changed at the same time. Reload them and try again.") from None


@console_api(methods=("POST",))
def request_test_email(request):
    now = timezone.now()
    user = request.user
    if not user.has_perm(SEND_TEST_EMAIL):
        raise ApiError(403, "forbidden", "This account may not send test emails.")
    QueryParams(request, ())
    data = json_object(request, empty=True)
    if data:
        raise validation_error({name: ["Unknown field: a test email goes to your own address."] for name in sorted(data)})
    if not email_enabled():
        raise ApiError(409, "email_disabled", "This server does not send email: no SMTP server is configured.")
    if not user.email:
        raise ApiError(409, "no_email_address", "This account has no email address. Ask an administrator to add one.")
    with transaction.atomic():
        # One request at a time per user: the checks below and the insert see the same rows.
        list(get_user_model().objects.select_for_update().filter(pk=user.pk).values_list("pk", flat=True))
        expire_test_emails(now, user_id=user.pk)
        if TestEmailRequest.objects.filter(requested_by=user, status__in=TestEmailRequest.OPEN).exists():
            raise ApiError(409, "test_email_pending", "A test email you asked for is still waiting to be sent.")
        latest = (
            TestEmailRequest.objects.filter(requested_by=user).order_by("-created_at").values_list("created_at", flat=True).first()
        )
        if latest is not None and now - latest < TEST_EMAIL_EVERY:
            wait = max(1, math.ceil((latest + TEST_EMAIL_EVERY - now).total_seconds()))
            raise ApiError(
                429, "rate_limited", "One test email a minute: try again shortly.", headers={"Retry-After": str(wait)}
            )
        row = TestEmailRequest.objects.create(
            requested_by=user,
            requested_by_name=user.get_username(),
            created_at=now,
            expires_at=now + TEST_EMAIL_EXPIRY,
        )
        audit.test_email_requested(user, row)
    logger.info("Test email requested (request=%s, user_id=%s)", row.pk, user.pk)
    response = JsonResponse(
        {
            "generatedAt": iso(now),
            "item": serialize_test_email(row),
            "notifier": {"state": notifier_status_payload(now)["state"]},
        },
        status=202,
    )
    response["Location"] = f"{request.path}{row.pk}/"
    return response


@console_api()
def test_email_status(request, request_id: UUID):
    now = timezone.now()
    QueryParams(request, ())
    expire_test_emails(now, user_id=request.user.pk)
    row = TestEmailRequest.objects.filter(pk=request_id, requested_by=request.user).first()
    if row is None:
        raise ApiError(404, "not_found", "Not found.")
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "item": serialize_test_email(row),
            "notifier": {"state": notifier_status_payload(now)["state"]},
        }
    )

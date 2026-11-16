"""Incident email settings: a console user's own, ``GET/PUT /settings/notifications/me/``, another
account's, ``GET/PUT /users/<id>/notifications/``, and test emails:
``POST /settings/notifications/test-email/``, ``GET /settings/notifications/test-email/<id>/``.

Every console user manages their own preferences (``/me/``: no id in the path); an administrator
(``apps.console.permissions.may_manage_users``, else 403) also those of any account. The address
is the account's own, never one sent in a request: it is read-only here (an administrator sets it
on the account).

Preferences::

    {"generatedAt",
     "preferences": {"enabled": bool, "minSeverity": critical | warning, "sendRecovery": bool,
                     "updatedAt": str | null, "changedBy": ChangedBy | null},
     "account": {"email": str | null},
     "email": {"available": bool, "deliverable": bool},
     "testEmail": {"allowed": bool, "latest": TestEmail | null}}       (/me/ only)

    ChangedBy: {"at", "username": str, "self": bool, "source": console | admin}   (a closed list)

``enabled`` false with ``updatedAt`` null: no subscription yet (the defaults are shown).
``changedBy``: the latest change of the preferences (from the configuration trail), by the
account itself (``self``) or by an administrator, in the console or the admin; ``username`` is
the name the one who changed them had then: never empty, and kept when that account is gone (then
``self`` is false). Null before any recorded change.
``email.available``: this server sends email (an SMTP server is set); ``deliverable``:
and the account has an address. Incident emails go to subscribers who may see the
incident's site, checked again just before each is sent.

``/users/<id>/notifications/`` answers the same without ``testEmail`` (a test email goes only
to the account that asks for it), with ``"user": {"id", "username", "displayName", "active"}``,
``"receiving": bool``: emails on, and the account can receive them, and
``"receivingBlockedBy": no_email_address | account_inactive | no_console_access | null``: why the
account cannot receive emails, whether they are on or not (the first of these, in this order, as
the 409 of turning them on says), null when it can. An unknown id is a 404.

``PUT`` with the CSRF token and a JSON object of exactly ``enabled``, ``minSeverity`` and
``sendRecovery``: the preferences become those (a change is recorded in the
configuration trail; an administrator's, also in the console's audit trail), emails on or
off. To turn emails on, the account must have an address (409 ``no_email_address``), be
active (409 ``account_inactive``) and may use the console (409 ``no_console_access``).
Switching off is always accepted; an account that could not receive emails keeps no new
preferences until it can. Invalid values: 400 ``validation_error`` with ``fields``. Two
changes at once: one stands, the other is a 409 ``conflict``; otherwise the latest wins.

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
from apps.alerts.models import (
    ConfigurationAction,
    ConfigurationEvent,
    ConfigurationSource,
    ConfigurationTarget,
    NotificationSubscription,
    TestEmailFailure,
    TestEmailRequest,
)
from apps.alerts.notifications import (
    SEND_TEST_EMAIL,
    TEST_EMAIL_EVERY,
    TEST_EMAIL_EXPIRY,
    email_enabled,
    expire_test_emails,
)
from apps.console import audit as console_audit
from apps.console.access import USE_CONSOLE
from apps.console.http import ApiError, console_api, json_object, validation_error
from apps.console.params import QueryParams
from apps.console.permissions import may_manage_users, require
from apps.console.serializers import iso, iso_or_none
from apps.console.system import notifier_status_payload

logger = logging.getLogger("apps.console")

SEVERITIES = tuple(NotificationSubscription.MinSeverity.values)
PREFERENCES = ("enabled", "minSeverity", "sendRecovery")
DEFAULTS = {"enabled": False, "minSeverity": NotificationSubscription.MinSeverity.CRITICAL.value, "sendRecovery": False}


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
        "finishedAt": iso_or_none(row.finished_at),
    }


def changed_by(subscription: NotificationSubscription | None) -> dict | None:
    """The latest recorded change of ``subscription``: when, by whom, from where."""
    if subscription is None:
        return None
    event = (
        ConfigurationEvent.objects.filter(
            target_type=ConfigurationTarget.SUBSCRIPTION,
            target_id=str(subscription.pk),
            action=ConfigurationAction.SUBSCRIPTION_CHANGED,
            source__in=(ConfigurationSource.CONSOLE, ConfigurationSource.ADMIN),
        )
        .order_by("-at", "-id")
        .values("at", "actor_id", "actor_name", "source")
        .first()
    )
    if event is None:
        return None
    return {
        "at": iso(event["at"]),
        "username": event["actor_name"],
        "self": event["actor_id"] is not None and event["actor_id"] == subscription.user_id,
        "source": event["source"],
    }


def account_preferences(user, now) -> dict:
    """What every view of an account's preferences answers."""
    subscription = NotificationSubscription.objects.filter(user=user).first()
    preferences = (
        {
            "enabled": subscription.enabled,
            "minSeverity": subscription.min_severity,
            "sendRecovery": subscription.send_recovery,
            "updatedAt": iso(subscription.updated_at),
            "changedBy": changed_by(subscription),
        }
        if subscription is not None
        else {**DEFAULTS, "updatedAt": None, "changedBy": None}
    )
    available = email_enabled()
    return {
        "generatedAt": iso(now),
        "preferences": preferences,
        "account": {"email": user.email or None},
        "email": {"available": available, "deliverable": available and bool(user.email)},
    }


def preferences_payload(request, now) -> dict:
    user = request.user
    payload = account_preferences(user, now)
    expire_test_emails(now, user_id=user.pk)
    latest = TestEmailRequest.objects.filter(requested_by=user).order_by("-created_at", "-pk").first()
    return {
        **payload,
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
        save_preferences(request.user, request.user.pk, parse_preferences(json_object(request)))
    return JsonResponse(preferences_payload(request, now))


@console_api(methods=("GET", "PUT"))
def user_preferences(request, user_id: int):
    now = timezone.now()
    require(may_manage_users(request.user, request.visibility), "This account may not manage users.")
    QueryParams(request, ())
    if not get_user_model().objects.filter(pk=user_id).exists():
        raise ApiError(404, "not_found", "Not found.")
    if request.method == "PUT":
        save_preferences(request.user, user_id, parse_preferences(json_object(request)), administrator=True)
    user = get_user_model().objects.filter(pk=user_id).first()
    if user is None:  # deleted meanwhile
        raise ApiError(404, "not_found", "Not found.")
    payload = account_preferences(user, now)
    return JsonResponse(
        {
            **payload,
            "user": {
                "id": user.pk,
                "username": user.get_username(),
                "displayName": user.get_full_name() or user.get_username(),
                "active": user.is_active,
            },
            "receiving": payload["preferences"]["enabled"] and blocked_by(user) is None,
            "receivingBlockedBy": blocked_by(user),
        }
    )


def blocked_by(user) -> str | None:
    """Why incident emails cannot go to ``user`` (the code of the 409 to turn them on), or None."""
    if not user.email:
        return "no_email_address"
    if not user.is_active:
        return "account_inactive"
    if not user.has_perm(USE_CONSOLE):
        return "no_console_access"
    return None


def may_receive(user) -> bool:
    """Whether incident emails can go to ``user`` at all: active, an address, console access."""
    return blocked_by(user) is None


def save_preferences(actor, user_id: int, values: dict, *, administrator: bool = False) -> None:
    """Set the preferences of the account ``user_id`` (the actor's own unless ``administrator``)."""
    try:
        with transaction.atomic():
            # The account as it is now, held while its preferences change (as a change of the account holds it).
            user = get_user_model().objects.select_for_update().filter(pk=user_id).first()
            if user is None:
                raise ApiError(404, "not_found", "Not found.")
            subscription = NotificationSubscription.objects.select_for_update().filter(user=user).first()
            blocked = blocked_by(user)
            if values["enabled"] and blocked is not None:
                advice = "Add one to the account first." if administrator else "Ask an administrator to add one."
                raise ApiError(409, blocked, {
                    "no_email_address": f"This account has no email address. {advice}",
                    "account_inactive": "This account is deactivated, so it receives no emails.",
                    "no_console_access": "This account may not use the console, so it receives no emails.",
                }[blocked])
            elif subscription is None and not may_receive(user):
                return  # nothing to switch off; preferences are kept for an account that can receive emails
            before = audit.subscription_values(subscription)
            if subscription is None or values["enabled"]:
                if subscription is None:
                    subscription = NotificationSubscription(user=user)
                for field, value in values.items():
                    setattr(subscription, field, value)
                subscription.save()  # validated by the model: an address and console access
            else:
                # Switching emails off: always accepted, whatever the account has lost since.
                NotificationSubscription.objects.filter(pk=subscription.pk).update(**values, updated_at=timezone.now())
                subscription.refresh_from_db()
            event = audit.subscription_saved(actor, subscription, before, source=ConfigurationSource.CONSOLE)
            if administrator and event is not None:
                console_audit.record(
                    actor,
                    action="user_notifications_changed",
                    target_type=console_audit.USER,
                    target_id=user.pk,
                    target_name=user.get_username(),
                    changed=event.changes,
                )
    except ValidationError as error:
        raise validation_error({"nonField": error.messages}) from None
    except IntegrityError:
        # Created meanwhile by another request: that one stands.
        raise ApiError(409, "conflict", "The preferences were changed at the same time. Reload them and try again.") from None
    if administrator:
        logger.info("User notifications changed (user=%s, by_user_id=%s)", user_id, actor.pk)


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

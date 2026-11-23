"""The incident emails, read: ``GET /notifications/``, the delivery log of the email outbox (``Notification``).

Who: administrators (superusers: ``viewDeliveryLog`` in the session's capabilities), else 403: the
log names every customer's incidents and every recipient.

An item, one email about one step of one incident to one console user::

    {"id": int, "kind": opened | recovered,
     "status": pending | sending | sent | failed | cancelled,
     "failure": {"category", "label"} | null,
     "recipient": {"id": int | null, "username"},
     "incident": {"id", "ruleName", "entityKind", "entityLabel", "severity"},
     "attempts": int, "createdAt", "lastAttemptAt": str | null, "nextAttemptAt": str | null,
     "sentAt": str | null}

``failure`` is a category and its label (``DeliveryFailure``), never what the SMTP server said.
A ``pending`` email with a failure failed its last attempt and is tried again at
``nextAttemptAt`` (null unless pending); ``failed`` is final; ``cancelled`` was not sent, on
purpose, and ``failure`` says why (the recipient is inactive, has no address or console
access, may no longer see the incident, or no longer asks for it; or it was not sent in
time). ``recipient`` is the account by the name it had: ``id`` is null once the account is
gone. No address: the email does not record which one it went to, and the account's address
now may not be the one it had (an administrator reads it on the account).

The list is ``{"generatedAt", "items", "page": {number, size, total, pages},
"counts": {status: int}, "scopeTotal", "retentionDays"}``, newest first by default, with:

    q              words, every one in the recipient's name, the rule's name or the object's name
    status         all | pending | sending | sent | failed | cancelled
    kind           all | opened | recovered
    incident       an incident's id
    recipient      an account's id (a whole number)
    sort, dir      created | status | recipient; asc | desc
    page, pageSize as for every list

Unknown or repeated parameters are a 400. ``counts`` are over every filter but ``status``;
``scopeTotal`` is every email kept. Emails are kept ``SENTINEL_NOTIFICATION_RETENTION_DAYS``
(``retentionDays``, ``purge_notifications``), and go with their incident when it is purged.
Test emails are not here: each account sees its own (``/settings/notifications/me/``), and the
system status counts them.
"""

from __future__ import annotations

from django.conf import settings
from django.db.models import Count, F
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts.models import DeliveryFailure, Notification, NotificationKind
from apps.console.http import console_api
from apps.console.listing import apply_search, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import may_view_delivery_log, require
from apps.console.serializers import iso, iso_or_none

STATUSES = tuple(Notification.Status.values)
STATUS_FILTERS = ("all", *STATUSES)
KIND_FILTERS = ("all", *NotificationKind.values)
SORT_KEYS = ("created", "status", "recipient")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"created": "desc", "status": "asc", "recipient": "asc"}
LIST_PARAMS = ("q", "status", "kind", "incident", "recipient", "sort", "dir", *PAGE_PARAMS)
SEARCH_FIELDS = ("recipient_name", "incident__rule__name", "incident__entity_label")
FIELDS = (
    "id",
    "kind",
    "status",
    "failure",
    "recipient_id",
    "recipient_name",
    "incident_id",
    "incident__rule__name",
    "incident__entity_kind",
    "incident__entity_label",
    "incident__severity",
    "attempts",
    "created_at",
    "last_attempt_at",
    "next_attempt_at",
    "sent_at",
)


def serialize(row: dict) -> dict:
    failure = row["failure"]
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "failure": {"category": failure, "label": DeliveryFailure(failure).label} if failure else None,
        "recipient": {"id": row["recipient_id"], "username": row["recipient_name"]},
        "incident": {
            "id": str(row["incident_id"]),
            "ruleName": row["incident__rule__name"],
            "entityKind": row["incident__entity_kind"],
            "entityLabel": row["incident__entity_label"],
            "severity": row["incident__severity"],
        },
        "attempts": row["attempts"],
        "createdAt": iso(row["created_at"]),
        "lastAttemptAt": iso_or_none(row["last_attempt_at"]),
        "nextAttemptAt": iso(row["next_attempt_at"]) if row["status"] == Notification.Status.PENDING else None,
        "sentAt": iso_or_none(row["sent_at"]),
    }


def ordering(sort: str, direction: str) -> list:
    descending = direction == "desc"
    newest = ["-created_at", "-id"]
    if sort == "created":
        return newest if descending else ["created_at", "id"]
    if sort == "recipient":
        return [name_order("recipient_name", descending=descending), *newest]
    return [F("status").desc() if descending else F("status").asc(), *newest]


@console_api()
def notification_log(request):
    now = timezone.now()
    require(may_view_delivery_log(request.user, request.visibility), "This account may not see the email log.")
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    kind = params.choice("kind", KIND_FILTERS, "all")
    incident = params.uuid("incident")
    recipient = params.integer("recipient", minimum=1, maximum=2**31 - 1, default=0)
    sort = params.choice("sort", SORT_KEYS, "created")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    every = Notification.objects.all()
    matching = apply_search(every, words, SEARCH_FIELDS)
    if kind != "all":
        matching = matching.filter(kind=kind)
    if incident is not None:
        matching = matching.filter(incident_id=incident)
    if recipient:
        matching = matching.filter(recipient_id=recipient)
    counts = dict.fromkeys(STATUSES, 0)
    for row in matching.order_by().values("status").annotate(n=Count("pk")):
        counts[row["status"]] = row["n"]
    total = sum(counts.values()) if status == "all" else counts[status]
    items: list[dict] = []
    if page.offset < total:
        rows = matching if status == "all" else matching.filter(status=status)
        rows = rows.order_by(*ordering(sort, direction)).values(*FIELDS)[page.offset : page.offset + page.size]
        items = [serialize(row) for row in rows]
    body = page_envelope(now, items, page, total=total, counts=counts, scope_total=every.count())
    body["retentionDays"] = settings.SENTINEL_NOTIFICATION_RETENTION_DAYS
    return JsonResponse(body)

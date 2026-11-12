"""The audit trail, read: ``GET /audit-log/`` (``apps.console.audit`` writes it).

Who: ``console.view_auditentry`` with global visibility (the entries name every customer's
objects); administrators hold it (``apps.console.permissions``). Otherwise 403.

An entry::

    {"id": int, "at", "actor": {"id": int | null, "username": str}, "action", "actionLabel",
     "targetType", "targetTypeLabel", "targetId", "targetName", "changes": {field: {"before", "after"}}}

``actor.id`` is null once the account is gone (the name stays). ``changes`` holds the fields
that changed, by the names the console API gives them, and never a password, a hash, a token or
a credential (``apps.console.audit``).

The list is ``{"generatedAt", "items", "page": {number, size, total, pages}, "scopeTotal",
"actions": [{"value", "label"}], "targetTypes": [{"value", "label"}]}``, newest first, with:

    q              words, every one in the actor's name, the object's name or its id
    actor          the id of an account (a whole number)
    action         one of ``actions``
    targetType     one of ``targetTypes``
    targetId       an object's id, as recorded (with ``targetType`` to be exact)
    page, pageSize as for every list

Unknown or repeated parameters are a 400. ``scopeTotal`` is every entry; ``page.total`` what
matches. Rows older than ``SENTINEL_AUDIT_RETENTION_DAYS`` are removed by ``purge_audit_entries``.
"""

from __future__ import annotations

from django.http import JsonResponse
from django.utils import timezone

from apps.console.audit import ACTIONS, TARGET_TYPES
from apps.console.http import console_api
from apps.console.listing import apply_search
from apps.console.models import AuditEntry
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.permissions import may_view_audit_log, require
from apps.console.serializers import iso

LIST_PARAMS = ("q", "actor", "action", "targetType", "targetId", *PAGE_PARAMS)
SEARCH_FIELDS = ("actor_name", "target_name", "target_id")
MAX_TARGET_ID_LENGTH = AuditEntry._meta.get_field("target_id").max_length
FIELDS = ("id", "at", "actor_id", "actor_name", "action", "target_type", "target_id", "target_name", "changes")


def serialize(row: dict) -> dict:
    return {
        "id": row["id"],
        "at": iso(row["at"]),
        "actor": {"id": row["actor_id"], "username": row["actor_name"]},
        "action": row["action"],
        "actionLabel": ACTIONS.get(row["action"], row["action"]),
        "targetType": row["target_type"],
        "targetTypeLabel": TARGET_TYPES.get(row["target_type"], row["target_type"]),
        "targetId": row["target_id"],
        "targetName": row["target_name"],
        "changes": row["changes"],
    }


@console_api()
def audit_log(request):
    now = timezone.now()
    require(may_view_audit_log(request.user, request.visibility), "This account may not see the audit log.")
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    actor = params.integer("actor", minimum=1, maximum=2**31 - 1, default=0)
    action = params.choice("action", ("", *ACTIONS), "")
    target_type = params.choice("targetType", ("", *TARGET_TYPES), "")
    target_id = params.text("targetId", limit=MAX_TARGET_ID_LENGTH)
    page = PageRequest.from_params(params)

    every = AuditEntry.objects.all()
    matching = apply_search(every, words, SEARCH_FIELDS)
    if actor:
        matching = matching.filter(actor_id=actor)
    if action:
        matching = matching.filter(action=action)
    if target_type:
        matching = matching.filter(target_type=target_type)
    if target_id is not None:
        matching = matching.filter(target_id=target_id)
    total = matching.count()
    narrowed = bool(words) or bool(actor) or bool(action) or bool(target_type) or target_id is not None
    scope_total = every.count() if narrowed else total
    items: list[dict] = []
    if page.offset < total:
        rows = matching.order_by("-at", "-id").values(*FIELDS)[page.offset : page.offset + page.size]
        items = [serialize(row) for row in rows]
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "items": items,
            "page": page.payload(total),
            "scopeTotal": scope_total,
            "actions": [{"value": value, "label": label} for value, label in ACTIONS.items()],
            "targetTypes": [{"value": value, "label": label} for value, label in TARGET_TYPES.items()],
        }
    )

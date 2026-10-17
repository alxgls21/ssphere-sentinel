"""Incidents: ``GET /incidents/`` (list), ``GET /incidents/<id>/`` (detail with its timeline),
``POST /incidents/<id>/acknowledge/``, and the alert engine's state, ``GET /alerts/engine-status/``.

What the alert engine (``apps.alerts``) recorded, read as it is: nothing here judges
health again or makes an incident up.

List::

    {"generatedAt", "items": [IncidentListItem], "page": {number, size, total, pages},
     "counts": {active, acknowledged, recovered, closed}, "scopeTotal": int}

``counts`` is per status over the requested scope, search, severity and kind (not the
status filter), so the status chips stay true; ``scopeTotal`` is the number of
incidents in the scope itself.

IncidentListItem::

    {"id", "status": active | acknowledged | recovered | closed,
     "severity": critical | warning,
     "condition": {"health": critical | warning | unknown, "reason": str | null},
     "entity": {"kind": server | container | target | device | interface, "ref", "label"},
     "rule": {"id", "name"},
     "siteId": str | null, "siteName"?, "customerName"?,
     "startedAt", "openedAt", "acknowledgedAt": str | null, "acknowledgedBy": str | null,
     "recoveredAt": str | null, "closedAt": str | null, "closeReason": str | null,
     "canAcknowledge": bool}

``condition`` is the rule's condition when the incident opened. ``startedAt`` is when
the condition began, ``openedAt`` when it had held for the rule's activation time;
``recoveredAt`` when the recovery that was confirmed began, ``closedAt`` when the
incident ended, by a recovery or not (``closeReason``: entity_removed,
entity_disabled, entity_moved, out_of_scope, rule_disabled, rule_changed).
``entity.ref`` is the id the other console endpoints take (``<server>:<Docker id>``
for a container, ``<device>:<ifIndex>`` for an interface), ``entity.label`` the
object's name when the incident opened. ``canAcknowledge``: this user may
acknowledge it now. ``siteName`` and ``customerName`` are left out for an incident
of an object that was on no site.

Query parameters (anything else, or a repeated one, is a 400):

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    q                words, every one must appear in the object's name or reference,
                     the rule's name, or the site or customer name
    status           all | open (active or acknowledged) | active | acknowledged |
                     ended (recovered or closed) | recovered | closed
    severity         all | critical | warning
    kind             all | server | container | target | device | interface
    sort, dir        opened | started | severity | status | name; asc | desc
    page, pageSize   from 1 (at most 10000); 1-200 (default 50)

Sorting: ``opened`` (the default) and ``started`` desc are the newest first;
``severity`` desc is critical first; ``status`` desc is the most pressing first
(active, acknowledged, recovered, closed); ``name`` is the object's name
(case-insensitive byte order). Ties are broken by the newest opened, then id.

Detail::

    {"generatedAt", "item": IncidentListItem,
     "rule": {"id", "name", "description", "enabled"},
     "entityVisible": bool,
     "timeline": [{"at", "kind", "health": str | null, "reason": str | null, "actor": str | null}]}

``entityVisible``: the object still exists where this user may see it (its own page
opens). The incident only ever shows what was true on its site when it happened.
The timeline is the incident's events in order: opened, acknowledged,
recovery_started, recovery_interrupted, recovered, closed; ``actor`` is the user
name of whoever acknowledged.

Acknowledge: ``POST /incidents/<id>/acknowledge/``, with the CSRF token and no body,
marks an active incident as seen; it stays open. It needs the console, the incident
visible (else 404, as if it did not exist) and ``alerts.acknowledge_incident`` (else
403). The answer is the detail. Acknowledged already: the same answer and nothing
changes, whoever acknowledged first stays the one recorded. Ended: 409
``incident_ended``. An incident cannot be resolved by hand: it ends when the engine
confirms a recovery, or when monitoring of it ends.

Engine status::

    {"generatedAt", "state": running | failed | stale | never_started,
     "stale": bool, "staleAfterSeconds": int, "intervalSeconds": int | null,
     "startedAt": str | null, "lastSuccessAt": str | null, "lastAttemptAt": str | null,
     "lastCycleMs": int | null, "lastError": {"at", "category": database | internal} | null,
     "monitoringSince": str | null}

    running        its latest attempt succeeded, and is recent
    failed         its latest attempt failed, and is recent: it runs, and fails
    stale          no attempt for longer than ``staleAfterSeconds`` (three of its
                   intervals, at least the offline threshold): stopped or stuck
    never_started  it has never attempted a cycle

``monitoringSince`` is null while the engine finds the agents' heartbeats missing
all at once (and does not count silences). The error is its category only, never
its message.

Access: every query starts from ``request.visibility.filter(...)`` on the incident's
site, the site its object was on when it opened (an incident of an object on no site
is visible to users who may see every customer only). The engine's state concerns
no customer: every console user may read it. Explicit columns only.
"""

from __future__ import annotations

import logging
from datetime import datetime
from uuid import UUID

from django.db.models import Case, Count, F, IntegerField, OuterRef, Subquery, Value, When
from django.http import JsonResponse
from django.utils import timezone

from apps.alerts.conditions import EntityKind, Severity
from apps.alerts.engine import DEFAULT_INTERVAL
from apps.alerts.models import AlertEngineHeartbeat, ErrorCategory, Incident, IncidentEvent
from apps.console.access import Scope, Visibility
from apps.console.http import ApiError, console_api
from apps.console.listing import apply_search, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import iso
from apps.infrastructure.liveness import offline_threshold_seconds
from apps.infrastructure.models import DockerContainer, Server
from apps.inventory.models import Device
from apps.network.models import NetworkTarget
from apps.snmp.models import Interface

logger = logging.getLogger("apps.console")

ACKNOWLEDGE = "alerts.acknowledge_incident"
Status = Incident.Status
STATUSES = (Status.ACTIVE, Status.ACKNOWLEDGED, Status.RECOVERED, Status.CLOSED)
STATUS_FILTERS = {
    "all": STATUSES,
    "open": Incident.OPEN,
    "active": (Status.ACTIVE,),
    "acknowledged": (Status.ACKNOWLEDGED,),
    "ended": Incident.ENDED,
    "recovered": (Status.RECOVERED,),
    "closed": (Status.CLOSED,),
}
SEVERITY_FILTERS = ("all", *Severity.values)
KIND_FILTERS = ("all", *EntityKind.values)
SORT_KEYS = ("opened", "started", "severity", "status", "name")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"opened": "desc", "started": "desc", "severity": "desc", "status": "desc", "name": "asc"}
LIST_PARAMS = ("q", "status", "severity", "kind", "sort", "dir", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = ("entity_label", "entity_ref", "rule__name", "site__name", "site__customer__name")
# The only columns ever read for an incident.
FIELDS = (
    "id",
    "status",
    "severity",
    "condition_health",
    "condition_reason",
    "entity_kind",
    "entity_ref",
    "entity_label",
    "rule_id",
    "rule__name",
    "site_id",
    "site__name",
    "site__customer__name",
    "started_at",
    "opened_at",
    "acknowledged_at",
    "acknowledged_by_name",
    "recovered_at",
    "closed_at",
    "close_reason",
)
DETAIL_FIELDS = (*FIELDS, "rule__description", "rule__enabled")


def _rank(field: str, order: tuple[str, ...]) -> Case:
    return Case(
        *(When(**{field: value}, then=Value(rank)) for rank, value in enumerate(order)),
        default=Value(len(order)),
        output_field=IntegerField(),
    )


def visible_incidents(visibility: Visibility, scope: Scope | None = None):
    """Incidents the user may see: the start of every incident query."""
    return visibility.filter(Incident.objects.all(), site_path="site", scope=scope)


def with_columns(queryset):
    """The annotations the list and the detail read: who acknowledged, by the name recorded then."""
    acknowledged = IncidentEvent.objects.filter(incident=OuterRef("pk"), kind=IncidentEvent.Kind.ACKNOWLEDGED)
    return queryset.annotate(acknowledged_by_name=Subquery(acknowledged.values("actor_name")[:1]))


def ordering(sort: str, direction: str) -> tuple[dict, list]:
    """The ORDER BY of a list, and the annotations it needs."""
    ascending = direction == "asc"
    tie = [F("opened_at").desc(), "pk"]
    if sort == "opened":
        return {}, [F("opened_at").asc() if ascending else F("opened_at").desc(), "pk"]
    if sort == "started":
        return {}, [F("started_at").asc() if ascending else F("started_at").desc(), *tie]
    if sort == "name":
        return {}, [name_order("entity_label", descending=not ascending), *tie]
    # Rank 0 is the most pressing: "desc" (most pressing first) is ascending by rank.
    rank = _rank("severity", tuple(Severity.values)) if sort == "severity" else _rank("status", STATUSES)
    return {"_rank": rank}, [F("_rank").desc() if ascending else F("_rank").asc(), *tie]


def _iso(value: datetime | None) -> str | None:
    return iso(value) if value is not None else None


def serialize(row: dict, *, may_acknowledge: bool) -> dict:
    """One ``IncidentListItem`` from a row of ``FIELDS``."""
    item = {
        "id": str(row["id"]),
        "status": row["status"],
        "severity": row["severity"],
        "condition": {"health": row["condition_health"], "reason": row["condition_reason"] or None},
        "entity": {"kind": row["entity_kind"], "ref": row["entity_ref"], "label": row["entity_label"]},
        "rule": {"id": str(row["rule_id"]), "name": row["rule__name"]},
        "siteId": str(row["site_id"]) if row["site_id"] is not None else None,
        "startedAt": iso(row["started_at"]),
        "openedAt": iso(row["opened_at"]),
        "acknowledgedAt": _iso(row["acknowledged_at"]),
        "acknowledgedBy": (row["acknowledged_by_name"] or None) if row["acknowledged_at"] is not None else None,
        "recoveredAt": _iso(row["recovered_at"]),
        "closedAt": _iso(row["closed_at"]),
        "closeReason": row["close_reason"] or None,
        "canAcknowledge": may_acknowledge and row["status"] == Status.ACTIVE,
    }
    if row["site__customer__name"] is not None:
        item["customerName"] = row["site__customer__name"]
    if row["site__name"] is not None:
        item["siteName"] = row["site__name"]
    return item


def status_counts(queryset) -> dict[str, int]:
    counts = dict.fromkeys(STATUSES, 0)
    for row in queryset.order_by().values("status").annotate(n=Count("pk")):
        counts[row["status"]] = row["n"]
    return {str(status): count for status, count in counts.items()}


@console_api()
def incident_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    words = params.search()
    status = params.choice("status", tuple(STATUS_FILTERS), "all")
    severity = params.choice("severity", SEVERITY_FILTERS, "all")
    kind = params.choice("kind", KIND_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "opened")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    in_scope = visible_incidents(request.visibility, scope)
    matching = apply_search(in_scope, words, SEARCH_FIELDS)
    if severity != "all":
        matching = matching.filter(severity=severity)
    if kind != "all":
        matching = matching.filter(entity_kind=kind)
    counts = status_counts(matching)
    narrowed = bool(words) or severity != "all" or kind != "all"
    scope_total = in_scope.count() if narrowed else sum(counts.values())
    total = sum(counts[str(value)] for value in STATUS_FILTERS[status])

    items: list[dict] = []
    if page.offset < total:
        rows = matching if status == "all" else matching.filter(status__in=STATUS_FILTERS[status])
        annotations, order = ordering(sort, direction)
        rows = list(
            with_columns(rows)
            .annotate(**annotations)
            .order_by(*order)
            .values(*FIELDS)[page.offset : page.offset + page.size]
        )
        may_acknowledge = request.user.has_perm(ACKNOWLEDGE)
        items = [serialize(row, may_acknowledge=may_acknowledge) for row in rows]
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


def entity_visible(visibility: Visibility, kind: str, ref: str) -> bool:
    """The incident's object exists, is still one the console reports on, and this user may see it."""
    owner, _, rest = ref.partition(":")
    if kind == EntityKind.SERVER:
        found = visibility.filter(Server.objects.filter(pk=owner))
    elif kind == EntityKind.TARGET:
        found = visibility.filter(NetworkTarget.objects.filter(pk=owner))
    elif kind == EntityKind.DEVICE:
        found = visibility.filter(Device.objects.filter(pk=owner, snmp_config__isnull=False))
    elif kind == EntityKind.CONTAINER:
        found = visibility.filter(
            DockerContainer.objects.filter(server_id=owner, container_id=rest, present=True), site_path="server__site"
        )
    else:
        found = visibility.filter(
            Interface.objects.filter(device_id=owner, if_index=int(rest), present=True, device__snmp_config__isnull=False),
            site_path="device__site",
        )
    return found.exists()


def detail_payload(request, incident_id: UUID, now: datetime) -> dict:
    row = request.visibility.get(with_columns(Incident.objects.all()).values(*DETAIL_FIELDS), incident_id)
    events = (
        IncidentEvent.objects.filter(incident_id=incident_id)
        .order_by("at", "pk")
        .values("at", "kind", "health", "reason", "actor_name")
    )
    return {
        "generatedAt": iso(now),
        "item": serialize(row, may_acknowledge=request.user.has_perm(ACKNOWLEDGE)),
        "rule": {
            "id": str(row["rule_id"]),
            "name": row["rule__name"],
            "description": row["rule__description"],
            "enabled": row["rule__enabled"],
        },
        "entityVisible": entity_visible(request.visibility, row["entity_kind"], row["entity_ref"]),
        "timeline": [
            {
                "at": iso(event["at"]),
                "kind": event["kind"],
                "health": event["health"] or None,
                "reason": event["reason"] or None,
                "actor": event["actor_name"] or None,
            }
            for event in events
        ],
    }


@console_api()
def incident_detail(request, incident_id: UUID):
    now = timezone.now()
    QueryParams(request, ())  # no parameters: a stray one is a mistake, not ignored
    return JsonResponse(detail_payload(request, incident_id, now))


@console_api(methods=("POST",))
def incident_acknowledge(request, incident_id: UUID):
    now = timezone.now()
    QueryParams(request, ())
    # Visibility first: a hidden incident is a 404 whatever the user's permissions.
    incident = request.visibility.get(Incident.objects.all(), incident_id)
    if not request.user.has_perm(ACKNOWLEDGE):
        raise ApiError(403, "forbidden", "This account may not acknowledge incidents.")
    # One conditional update and its event, together: the first acknowledgement is the only one.
    if incident.acknowledge(request.user, at=max(now, incident.opened_at)):
        logger.info("Incident acknowledged (incident=%s, user_id=%s)", incident.pk, request.user.pk)
    else:
        incident.refresh_from_db(fields=["status"])
        if incident.status in Incident.ENDED:
            raise ApiError(409, "incident_ended", "This incident has ended: there is nothing to acknowledge.")
    return JsonResponse(detail_payload(request, incident_id, now))


def engine_status_payload(now: datetime) -> dict:
    beat = AlertEngineHeartbeat.objects.filter(pk=1).values(
        "started_at",
        "beat_at",
        "interval_seconds",
        "last_cycle_ms",
        "monitoring_since",
        "last_error_at",
        "last_error_category",
    ).first() or dict.fromkeys(
        ("started_at", "beat_at", "interval_seconds", "last_cycle_ms", "monitoring_since", "last_error_at", "last_error_category")
    )
    stale_after = max(offline_threshold_seconds(), 3 * (beat["interval_seconds"] or DEFAULT_INTERVAL))
    success, failure = beat["beat_at"], beat["last_error_at"]
    attempts = [moment for moment in (success, failure) if moment is not None]
    attempt = max(attempts) if attempts else None
    stale = attempt is None or (now - attempt).total_seconds() > stale_after
    if attempt is None:
        state = "never_started"
    elif stale:
        state = "stale"
    elif failure is not None and (success is None or failure >= success):
        state = "failed"
    else:
        state = "running"
    last_error = None
    if failure is not None:
        category = beat["last_error_category"] if beat["last_error_category"] in ErrorCategory.values else ErrorCategory.INTERNAL
        last_error = {"at": iso(failure), "category": str(category)}
    return {
        "generatedAt": iso(now),
        "state": state,
        "stale": stale,
        "staleAfterSeconds": stale_after,
        "intervalSeconds": beat["interval_seconds"],
        "startedAt": _iso(beat["started_at"]),
        "lastSuccessAt": _iso(success),
        "lastAttemptAt": _iso(attempt),
        "lastCycleMs": beat["last_cycle_ms"],
        "lastError": last_error,
        "monitoringSince": _iso(beat["monitoring_since"]),
    }


@console_api()
def engine_status(request):
    now = timezone.now()
    QueryParams(request, ())
    return JsonResponse(engine_status_payload(now))

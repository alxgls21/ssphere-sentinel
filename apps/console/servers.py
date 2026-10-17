"""Servers: ``GET /servers/`` (list) and ``GET /servers/<id>/`` (detail with its containers).

Response bodies are the UI's ``ServerList`` and ``ServerDetail`` (``api/types.ts``),
with the list's pagination added next to ``items``:

    {"generatedAt", "items": [ServerListItem], "page": {number, size, total, pages},
     "counts": StatusCounts, "scopeTotal": int}

``counts`` is per health status over the requested scope and search (not the
status filter), so the UI's status chips stay true; ``scopeTotal`` is the size
of the scope itself.

Query parameters (anything else, or a repeated one, is a 400):

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    q                words, every one must appear in the name, hostname, address,
                     OS, site or customer name
    status           all | critical | warning | unknown | healthy
    sort, dir        status | name | cpu | memory | disk | uptime | seen; asc | desc
    page, pageSize   from 1 (at most 10000); 1-200 (default 50)

Sorting (the directions are the UI's): ``status`` desc is worst first; ``name``
is case-insensitive byte order of the lower-cased name (``web-10`` sorts before
``web-2``); cpu/memory/disk/uptime rank only current readings and put every
other server last in both directions (offline, never reported, and servers
whose latest resource report is not current: see below); ``seen`` orders by the
time since the last heartbeat, so desc is the longest silent first and servers
that never reported come last. Ties are broken by name, then id, so a page
boundary never repeats or skips a row.

Telemetry freshness (the rule is ``apps.console.health``): ``server.telemetry``
is the last known reading, kept for as long as the server exists, and says how
current it is. ``receivedAt`` is when the server accepted it and ``stale`` is
true once that is older than the offline window (``generatedAt - receivedAt``),
whatever the heartbeat does. A stale reading is not current: it takes no part in
``health``, ``counts`` or the load sorting, and a client must not show it as
the present value. ``server.status`` (liveness) is independent of it: a server
can be ``online`` with a stale reading, which is what an agent that keeps
sending heartbeats without usable telemetry looks like.

Access: every query starts from ``request.visibility.filter(...)`` (a server
without a site is visible only to users who may see all customers). The
queries read an explicit list of columns (``.values``), never model instances,
so nothing that is not in the response body, an agent's token hash above
all, is even loaded.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone

from apps.console.access import Scope, Visibility
from apps.console.containers import container_counts_by_server, containers_of_server
from apps.console.health import (
    HEALTH_NAMES,
    annotate_servers,
    empty_counts,
    server_load,
)
from apps.console.http import console_api
from apps.console.listing import filter_list, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import iso
from apps.infrastructure.models import Server

STATUS_FILTERS = ("all", "critical", "warning", "unknown", "healthy")
SORT_KEYS = ("status", "name", "cpu", "memory", "disk", "uptime", "seen")
DIRECTIONS = ("asc", "desc")
# The direction a column starts at when ``dir`` is omitted.
DEFAULT_DIRECTION = {
    "status": "desc",
    "name": "asc",
    "cpu": "desc",
    "memory": "desc",
    "disk": "desc",
    "uptime": "desc",
    "seen": "desc",
}
LIST_PARAMS = ("q", "status", "sort", "dir", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = (
    "name",
    "hostname",
    "ip_address",
    "operating_system",
    "site__name",
    "site__customer__name",
)
# The only columns ever read for a server (see the module docstring).
FIELDS = (
    "id",
    "name",
    "hostname",
    "ip_address",
    "operating_system",
    "site_id",
    "site__name",
    "site__customer__name",
    "last_seen_at",
    "agent__agent_version",
    "liveness",
    "severity",
    "telemetry__cpu_percent",
    "telemetry__memory_percent",
    "telemetry__disk_percent",
    "telemetry__memory_total_bytes",
    "telemetry__disk_total_bytes",
    "telemetry__uptime_seconds",
    "telemetry__collected_at",
    "telemetry__received_at",
    "telemetry_fresh",
)
LOAD_COLUMNS = {
    "cpu": "cpu_percent",
    "memory": "memory_percent",
    "disk": "disk_percent",
    "uptime": "uptime_seconds",
}


def visible_servers(visibility: Visibility, now: datetime, scope: Scope | None = None):
    """Servers the user may see, with ``liveness`` and ``severity``: the start of every server query."""
    return annotate_servers(visibility.filter(Server.objects.all(), scope=scope), now)


def ordering(sort: str, direction: str, now: datetime):
    """The ORDER BY of a list, and the annotations it needs, as ``(annotations, expressions)``."""
    ascending = direction == "asc"
    tie = [name_order("name"), "pk"]
    if sort == "name":
        return {}, [name_order("name", descending=not ascending), "pk"]
    if sort == "status":
        # Rank 0 is the worst: "desc" (worst first) is ascending by rank.
        return {}, [F("severity").desc() if ascending else F("severity").asc(), *tie]
    if sort == "seen":
        # By age: the longest silent (the oldest heartbeat) is the largest.
        oldest = F("last_seen_at").asc(nulls_last=True)
        newest = F("last_seen_at").desc(nulls_last=True)
        return {}, [newest if ascending else oldest, *tie]
    key = f"_sort_{sort}"
    column = F(key)
    return (
        {key: server_load(LOAD_COLUMNS[sort], now)},
        [column.asc(nulls_last=True) if ascending else column.desc(nulls_last=True), *tie],
    )


def serialize(row: dict, container_counts: dict[str, int]) -> dict:
    """One ``ServerListItem`` from a row of ``FIELDS``."""
    telemetry = None
    if row["telemetry__collected_at"] is not None:
        telemetry = {
            "cpuPercent": row["telemetry__cpu_percent"],
            "memoryPercent": row["telemetry__memory_percent"],
            "diskPercent": row["telemetry__disk_percent"],
            "memoryTotalBytes": row["telemetry__memory_total_bytes"],
            "diskTotalBytes": row["telemetry__disk_total_bytes"],
            "uptimeSeconds": row["telemetry__uptime_seconds"],
            "collectedAt": iso(row["telemetry__collected_at"]),
            "receivedAt": iso(row["telemetry__received_at"]),
            "stale": not row["telemetry_fresh"],
        }
    item = {
        "server": {
            "id": str(row["id"]),
            "name": row["name"],
            "hostname": row["hostname"],
            "ipAddress": str(row["ip_address"]) if row["ip_address"] is not None else None,
            "operatingSystem": row["operating_system"],
            "status": row["liveness"],
            "siteId": str(row["site_id"]) if row["site_id"] is not None else None,
            "lastSeenAt": iso(row["last_seen_at"]) if row["last_seen_at"] is not None else None,
            "agentVersion": row["agent__agent_version"] or "",
            "telemetry": telemetry,
        },
        "health": HEALTH_NAMES[row["severity"]],
    }
    if row["site__customer__name"] is not None:
        item["customerName"] = row["site__customer__name"]
    if row["site__name"] is not None:
        item["siteName"] = row["site__name"]
    item["containers"] = {"total": sum(container_counts.values()), "counts": container_counts}
    return item


@console_api()
def server_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "status")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    in_scope = visible_servers(request.visibility, now, scope)
    rows, counts, total, scope_total = filter_list(in_scope, words=words, fields=SEARCH_FIELDS, status=status)

    items: list[dict] = []
    if page.offset < total:
        annotations, order = ordering(sort, direction, now)
        rows = list(
            rows.annotate(**annotations)
            .order_by(*order)
            .values(*FIELDS)[page.offset : page.offset + page.size]
        )
        per_server = container_counts_by_server(request.visibility, [row["id"] for row in rows], now, scope=scope)
        items = [serialize(row, per_server.get(row["id"], empty_counts())) for row in rows]
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


@console_api()
def server_detail(request, server_id: UUID):
    now = timezone.now()
    QueryParams(request, ())  # no parameters: a stray one is a mistake, not ignored
    row = request.visibility.get(visible_servers(request.visibility, now).values(*FIELDS), server_id)
    counts = container_counts_by_server(request.visibility, [server_id], now).get(server_id, empty_counts())
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "item": serialize(row, counts),
            "containers": containers_of_server(request.visibility, server_id, now),
        }
    )

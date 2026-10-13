"""Docker containers: ``GET /containers/`` (list across servers) and the pieces the server views embed.

An item is the UI's ``ServerContainer`` (``{container, status}``) plus where the
container runs, so a fleet-wide list can show it:

    {"container": {id, serverId, name, image, state, health, startedAt},
     "status": HealthStatus, "serverName", "customerName"?, "siteName"?}

and the response carries the same ``page``, ``counts`` and ``scopeTotal`` as the
server list (see ``apps.console.servers``). ``container.id`` is
``<server id>:<docker container id>``: unique (Docker ids are unique per host
only) and stable. Only containers the host currently lists are served;
containers that disappeared stay in the database for the retention period
(``purge_absent_docker_containers``) but are not the UI's concern.

A container on a host that went silent, or whose Docker is unavailable, is
reported as ``unknown`` (state and health): the stored values are last-known,
not current (see ``apps.console.health``).

Query parameters (anything else, or a repeated one, is a 400):

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    server           only this server's containers (a UUID; one the user may not
                     see simply has none, like one that does not exist)
    q                words, every one must appear in the container name, image,
                     Docker id, or the server, site or customer name
    status           all | critical | warning | unknown | idle | healthy
    sort, dir        status | name | server | started; asc | desc
    page, pageSize   as for servers

Access: through ``request.visibility.filter(..., site_path="server__site")``,
like every console query, and with an explicit column list.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from django.db.models import Count, F
from django.http import JsonResponse
from django.utils import timezone

from apps.console.access import Scope, Visibility
from apps.console.health import (
    HEALTH_NAMES,
    HEALTH_RANKS,
    annotate_containers,
    empty_counts,
)
from apps.console.http import console_api
from apps.console.listing import apply_search, counts_by_severity, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import iso
from apps.infrastructure.models import DockerContainer

STATUS_FILTERS = ("all", "critical", "warning", "unknown", "idle", "healthy")
SORT_KEYS = ("status", "name", "server", "started")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"status": "desc", "name": "asc", "server": "asc", "started": "desc"}
LIST_PARAMS = ("q", "status", "sort", "dir", "server", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = (
    "name",
    "image",
    "container_id",
    "server__name",
    "server__site__name",
    "server__site__customer__name",
)
FIELDS = (
    "server_id",
    "container_id",
    "name",
    "image",
    "state",
    "health",
    "started_at",
    "observable",
    "severity",
    "server__name",
    "server__site__name",
    "server__site__customer__name",
)
# A report holds at most 1000 containers (apps.infrastructure.docker_reports), so a
# host never has more present; the limit is the same bound stated where it is used.
MAX_CONTAINERS_PER_SERVER = 1000


def visible_containers(visibility: Visibility, now: datetime, scope: Scope | None = None):
    """Present containers the user may see (those of visible servers), with ``observable`` and ``severity``."""
    visible = visibility.filter(
        DockerContainer.objects.filter(present=True), site_path="server__site", scope=scope
    )
    return annotate_containers(visible, now)


def container_counts_by_server(
    visibility: Visibility, server_ids: list[UUID], now: datetime, scope: Scope | None = None
) -> dict[UUID, dict[str, int]]:
    """Containers per server and health status, for the servers of one page, in one grouped query.

    Pass the request's ``scope`` so the visible sites are looked up once, not
    again for a different scope.
    """
    if not server_ids:
        return {}
    rows = (
        visible_containers(visibility, now, scope)
        .filter(server_id__in=server_ids)
        .order_by()
        .values("server_id", "severity")
        .annotate(n=Count("pk"))
    )
    counts: dict[UUID, dict[str, int]] = {}
    for row in rows:
        counts.setdefault(row["server_id"], empty_counts())[HEALTH_NAMES[row["severity"]]] = row["n"]
    return counts


def serialize(row: dict) -> dict:
    """``{container, status}`` from a row of ``FIELDS``."""
    observable = row["observable"]
    return {
        "container": {
            "id": f"{row['server_id']}:{row['container_id']}",
            "serverId": str(row["server_id"]),
            "name": row["name"],
            "image": row["image"],
            # What is stored is last-known: only a current host's state is shown as is.
            "state": row["state"] if observable else DockerContainer.State.UNKNOWN,
            "health": row["health"] if observable else DockerContainer.Health.UNKNOWN,
            "startedAt": iso(row["started_at"]) if row["started_at"] is not None else None,
        },
        "status": HEALTH_NAMES[row["severity"]],
    }


def containers_of_server(visibility: Visibility, server_id: UUID, now: datetime) -> list[dict]:
    """The containers of one visible server, worst first, as the server detail embeds them."""
    rows = (
        visible_containers(visibility, now)
        .filter(server_id=server_id)
        .order_by("severity", name_order("name"), "container_id")
        .values(*FIELDS)[:MAX_CONTAINERS_PER_SERVER]
    )
    return [serialize(row) for row in rows]


def ordering(sort: str, direction: str):
    ascending = direction == "asc"
    by_name = name_order("name")
    by_server = name_order("server__name")
    last = ["server_id", "container_id"]  # unique together: a total order
    if sort == "name":
        return [name_order("name", descending=not ascending), by_server, *last]
    if sort == "server":
        return [name_order("server__name", descending=not ascending), by_name, *last]
    if sort == "started":
        column = F("started_at")
        return [column.asc(nulls_last=True) if ascending else column.desc(nulls_last=True), by_name, by_server, *last]
    # status: rank 0 is the worst, so worst first ("desc") is ascending by rank.
    return [F("severity").desc() if ascending else F("severity").asc(), by_name, by_server, *last]


@console_api()
def container_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    server_id = params.uuid("server")
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "status")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    in_scope = visible_containers(request.visibility, now, scope)
    if server_id is not None:
        in_scope = in_scope.filter(server_id=server_id)
    matching = apply_search(in_scope, words, SEARCH_FIELDS)
    counts = counts_by_severity(matching)
    scope_total = sum(counts.values()) if not words else in_scope.count()
    total = sum(counts.values()) if status == "all" else counts[status]

    items: list[dict] = []
    if page.offset < total:
        rows = matching if status == "all" else matching.filter(severity=HEALTH_RANKS[status])
        rows = rows.order_by(*ordering(sort, direction)).values(*FIELDS)[page.offset : page.offset + page.size]
        for row in rows:
            item = serialize(row)
            item["serverName"] = row["server__name"]
            if row["server__site__customer__name"] is not None:
                item["customerName"] = row["server__site__customer__name"]
            if row["server__site__name"] is not None:
                item["siteName"] = row["server__site__name"]
            items.append(item)
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))

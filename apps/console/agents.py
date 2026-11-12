"""The agents of the servers the user may see: ``GET /agents/``, for choosing which agent probes
a target or polls a device (``apps.console.target_config``, ``apps.console.device_config``).

An item::

    {"id", "name", "enabled": bool, "status": online | offline | unknown, "lastSeenAt": str | null,
     "serverId", "serverName"}

The envelope is ``{"generatedAt", "items", "page": {number, size, total, pages}}``; parameters
``q`` (words, every one in the agent's or the server's name), ``page`` and ``pageSize`` as for
every list. Never a token, nor a token's hash: the columns are named. Access: every query starts
from ``request.visibility.filter`` on the servers (an agent is read through the server it runs
on, never through the agents app); an agent of a hidden server is not listed.
"""

from __future__ import annotations

from django.http import JsonResponse
from django.utils import timezone

from apps.console.health import offline_cutoff
from apps.console.http import console_api
from apps.console.listing import apply_search, name_order
from apps.console.params import PAGE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import iso, iso_or_none
from apps.infrastructure.models import Server

LIST_PARAMS = ("q", *PAGE_PARAMS)
SEARCH_FIELDS = ("agent__name", "name")
FIELDS = ("agent__id", "agent__name", "agent__enabled", "agent__last_seen_at", "id", "name")


def serialize(row: dict, now) -> dict:
    last_seen = row["agent__last_seen_at"]
    if last_seen is None:
        status = "unknown"
    else:
        status = "online" if last_seen >= offline_cutoff(now) else "offline"
    return {
        "id": str(row["agent__id"]),
        "name": row["agent__name"],
        "enabled": row["agent__enabled"],
        "status": status,
        "lastSeenAt": iso_or_none(last_seen),
        "serverId": str(row["id"]),
        "serverName": row["name"],
    }


@console_api()
def agent_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    words = params.search()
    page = PageRequest.from_params(params)
    visible = request.visibility.filter(Server.objects.filter(agent__isnull=False))
    matching = apply_search(visible, words, SEARCH_FIELDS)
    total = matching.count()
    items: list[dict] = []
    if page.offset < total:
        rows = matching.order_by(name_order("name"), name_order("agent__name"), "pk").values(*FIELDS)
        items = [serialize(row, now) for row in rows[page.offset : page.offset + page.size]]
    return JsonResponse({"generatedAt": iso(now), "items": items, "page": page.payload(total)})

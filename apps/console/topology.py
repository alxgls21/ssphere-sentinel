"""The infrastructure graph: ``GET /topology/``, for a Cytoscape.js view.

    {"generatedAt", "physicalLinksKnown": false,
     "elements": {"nodes": [{"data": {...}}], "edges": [{"data": {...}}]},
     "counts": {kind: {"visible": int, "returned": int}}, "truncated": bool}

What the database records, and nothing else. Sentinel knows who owns what,
where it is, what runs on what and which agent measures what; it does not know
how anything is cabled or routed (no LLDP, CDP, ARP or routing data), so no
edge here is a network link and ``physicalLinksKnown`` is false. Nothing is
inferred from addresses, names, sites or shared agents.

Nodes (``data``): ``id``, ``kind``, ``label`` and, but for the groups,
``health`` (the console's status, ``apps.console.health``) and ``ref`` (the id
the other endpoints take). ``parent`` is the node it belongs to: a Cytoscape
compound parent, never drawn as a link.

    customer   customer:<uuid>
    site       site:<uuid>                       parent: its customer
    group      group:unassigned                  synthetic: what belongs to no site
    server     server:<uuid>                     parent: its site (or the group);
                                                 ``agent``: {id, name, version, status, lastSeenAt} | null
    container  container:<server uuid>:<docker id>   parent: the server it runs on (include=containers)
    target     target:<uuid>                     parent: its site (or the group)
    device     device:<uuid>                     parent: its site (or the group); SNMP devices only
    interface  interface:<device uuid>:<ifIndex>     parent: its device (include=interfaces); present ones

Edges (``data``): ``id``, ``source``, ``target``, ``category`` and ``kind``. The
only category is ``monitoring``: the server whose agent is assigned to a
network target (``kind: probes``, ``monitors:target:<uuid>``) or to an SNMP
device (``kind: polls``, ``polls:device:<uuid>``). It says which agent measures
it, not that the two are connected.

Parameters (anything else, or a repeated one, is a 400):

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    include          containers, interfaces, or both (comma-separated); default neither
    limit            nodes to return, 1-5000 (default 2000)

Limit and truncation. Every node counts, parents too, and a node is returned
only with all its ancestors, so no ``parent`` and no edge refers to a node that
is not in the response. Nodes are taken worst health first (critical, warning,
unknown, idle, healthy), then servers, devices, targets, containers, interfaces,
then by name: a node is skipped when it does not fit with the ancestors it
still needs. Sites and customers with nothing returned under them come last.
``counts`` says, per kind, how many are visible in the scope and how many were
returned; ``truncated`` is true when any visible node of a requested kind was
left out. An edge is returned when both its ends are; its server may be out of
the scope or hidden, and then the edge is not part of the graph at all.

Access: every query goes through ``request.visibility`` (servers, targets and
devices by their site, containers through their server's, interfaces through
their device's); customers and sites are those the user may see. Hidden
entities are not counted, labelled or referred to: an agent's server that the
user may not see is no node, no edge end and no name. Explicit columns only:
no token hash, no credential profile.

Bounded: for each kind one count and one query of at most ``limit`` rows (worst
first, the order the selection takes them in), interfaces only of the devices
fetched; a fixed number of queries whatever the estate.
"""

from __future__ import annotations

from datetime import datetime

from django.db.models import Case, IntegerField, Q, Value, When
from django.http import JsonResponse
from django.utils import timezone

from apps.console.containers import visible_containers
from apps.console.devices import interfaces_of, snmp_devices
from apps.console.health import HEALTH_NAMES, HEALTH_RANKS, interface_health, offline_cutoff
from apps.console.http import console_api
from apps.console.listing import name_order
from apps.console.params import SCOPE_PARAMS, QueryParams, invalid
from apps.console.serializers import iso
from apps.console.servers import visible_servers
from apps.console.targets import visible_targets

DEFAULT_LIMIT = 2000
MAX_LIMIT = 5000
INCLUDABLE = ("containers", "interfaces")
PARAMS = ("include", "limit", *SCOPE_PARAMS)
UNASSIGNED = "group:unassigned"
# The order nodes of the same health are taken in: the infrastructure itself first.
KIND_ORDER = {"server": 0, "device": 1, "target": 2, "container": 3, "interface": 4}
# Interfaces administratively up but operationally down or lowerLayerDown: the only ones a
# reachable device can report as a problem (``interface_health``), fetched first.
_INTERFACE_PROBLEM_FIRST = Case(
    When(Q(admin_status=1, oper_status__in=(2, 7)), then=Value(0)),
    default=Value(1),
    output_field=IntegerField(),
)


def includes(request) -> set[str]:
    raw = request.GET.get("include")
    if raw is None:
        return set()
    parts = raw.split(",")
    if any(part not in INCLUDABLE for part in parts) or len(set(parts)) != len(parts):
        raise invalid("include", f"expected a comma-separated subset of {', '.join(INCLUDABLE)}")
    return set(parts)


def agent_metadata(row: dict, now: datetime) -> dict | None:
    if row["agent__id"] is None:
        return None
    seen = row["agent__last_seen_at"]
    status = "unknown" if seen is None else ("online" if seen >= offline_cutoff(now) else "offline")
    return {
        "id": str(row["agent__id"]),
        "name": row["agent__name"],
        "version": row["agent__agent_version"] or None,
        "status": status,
        "lastSeenAt": iso(seen) if seen else None,
    }


def site_parent(site_id) -> str:
    return f"site:{site_id}" if site_id is not None else UNASSIGNED


class Graph:
    """The nodes chosen under the limit, each with its ancestors."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.nodes: dict[str, dict] = {}
        self.parents: dict[str, str | None] = {}  # every node that may be returned, and its parent
        self.data: dict[str, dict] = {}

    def offer(self, node_id: str, data: dict, parent: str | None) -> None:
        self.parents[node_id] = parent
        self.data[node_id] = data

    def chain(self, node_id: str) -> list[str] | None:
        """``node_id`` and its ancestors that are not chosen yet, outermost first; None if one is unknown."""
        missing = []
        current: str | None = node_id
        while current is not None and current not in self.nodes:
            if current not in self.parents:
                return None  # an ancestor that cannot be returned: neither can the node
            missing.append(current)
            current = self.parents[current]
        return list(reversed(missing))

    def take(self, node_id: str) -> bool:
        """Choose ``node_id`` with its missing ancestors, if they all fit."""
        missing = self.chain(node_id)
        if missing is None or len(self.nodes) + len(missing) > self.limit:
            return False
        for member in missing:
            data = {**self.data[member]}
            if self.parents[member] is not None:
                data["parent"] = self.parents[member]
            self.nodes[member] = {"data": data}
        return True


@console_api()
def topology(request):
    now = timezone.now()
    params = QueryParams(request, PARAMS)
    visibility = request.visibility
    scope = params.scope(visibility)
    wanted = includes(request)
    limit = params.integer("limit", minimum=1, maximum=MAX_LIMIT, default=DEFAULT_LIMIT)

    graph = Graph(limit)
    candidates: list[tuple] = []  # (health rank, kind order, label, node id)
    counts: dict[str, dict[str, int]] = {}

    def entity(kind: str, node_id: str, label: str, parent: str, rank: int, ref: str, **extra) -> None:
        graph.offer(node_id, {"id": node_id, "kind": kind, "label": label, "health": HEALTH_NAMES[rank], "ref": ref, **extra}, parent)
        candidates.append((rank, KIND_ORDER[kind], label.lower(), node_id))

    def fetched(queryset, *fields):
        return list(queryset.order_by("severity", name_order("name"), "pk").values(*fields)[:limit])

    # Servers, with their agent (one per server, and visible with it).
    servers_in_scope = visible_servers(visibility, now, scope)
    counts["server"] = {"visible": servers_in_scope.count()}
    server_ids = set()
    for row in fetched(servers_in_scope, "id", "name", "site_id", "severity", "agent__id", "agent__name",
                       "agent__agent_version", "agent__last_seen_at"):
        server_ids.add(row["id"])
        entity("server", f"server:{row['id']}", row["name"], site_parent(row["site_id"]), row["severity"], str(row["id"]),
               agent=agent_metadata(row, now))

    # Network targets and SNMP devices, with the server of their assigned agent (for the edges).
    monitored: list[tuple[str, str, str, object]] = []  # (edge id, kind, node id, server id)
    for kind, queryset, edge_kind, edge_prefix in (
        ("target", visible_targets(visibility, now, scope), "probes", "monitors:target"),
        ("device", snmp_devices(visibility, now, scope), "polls", "polls:device"),
    ):
        counts[kind] = {"visible": queryset.count()}
        for row in fetched(queryset, "id", "name", "site_id", "severity", "assigned_agent__server_id"):
            node_id = f"{kind}:{row['id']}"
            entity(kind, node_id, row["name"], site_parent(row["site_id"]), row["severity"], str(row["id"]))
            if row["assigned_agent__server_id"] is not None:
                monitored.append((f"{edge_prefix}:{row['id']}", edge_kind, node_id, row["assigned_agent__server_id"]))
    device_health = {
        data["ref"]: data["health"] for node_id, data in graph.data.items() if node_id.startswith("device:")
    }

    if "containers" in wanted:
        containers = visible_containers(visibility, now, scope)
        counts["container"] = {"visible": containers.count()}
        rows = (
            containers.filter(server_id__in=server_ids)
            .order_by("severity", name_order("name"), "server_id", "container_id")
            .values("server_id", "container_id", "name", "severity")[:limit]
        )
        for row in rows:
            ref = f"{row['server_id']}:{row['container_id']}"
            entity("container", f"container:{ref}", row["name"], f"server:{row['server_id']}", row["severity"], ref)

    if "interfaces" in wanted:
        interfaces = interfaces_of(visibility, scope).filter(present=True, device__snmp_config__isnull=False)
        counts["interface"] = {"visible": interfaces.count()}
        rows = (
            interfaces.filter(device_id__in=[ref for ref in device_health])
            .order_by(_INTERFACE_PROBLEM_FIRST, "device_id", "if_index")
            .values("device_id", "if_index", "name", "admin_status", "oper_status")[:limit]
        )
        for row in rows:
            health, _ = interface_health(
                device_healthy=device_health[str(row["device_id"])] == "healthy",
                present=True,
                admin_status=row["admin_status"],
                oper_status=row["oper_status"],
            )
            ref = f"{row['device_id']}:{row['if_index']}"
            entity("interface", f"interface:{ref}", row["name"], f"device:{row['device_id']}", HEALTH_RANKS[health], ref)

    # Sites and customers: the ones the entities belong to, then the rest of the scope.
    sites = visibility.sites()
    customers = visibility.customers()
    if scope.site_id is not None:
        sites = sites.filter(pk=scope.site_id)
    elif scope.customer_id is not None:
        sites = sites.filter(customer_id=scope.customer_id)
    if scope.site_id is not None or scope.customer_id is not None:
        customers = customers.filter(pk__in=sites.order_by().values("customer_id"))
    counts["site"] = {"visible": sites.count()}
    counts["customer"] = {"visible": customers.count()}
    needed_sites = {parent.split(":", 1)[1] for parent in graph.parents.values() if parent and parent.startswith("site:")}
    site_rows = list(sites.filter(pk__in=needed_sites).values("id", "name", "customer_id"))
    site_rows += list(sites.exclude(pk__in=needed_sites).order_by(name_order("name"), "pk").values("id", "name", "customer_id")[:limit])
    customer_ids = {row["customer_id"] for row in site_rows}
    customer_rows = list(customers.filter(pk__in=customer_ids).values("id", "name"))
    customer_rows += list(customers.exclude(pk__in=customer_ids).order_by(name_order("name"), "pk").values("id", "name")[:limit])
    for row in customer_rows:
        graph.offer(f"customer:{row['id']}", {"id": f"customer:{row['id']}", "kind": "customer", "label": row["name"], "ref": str(row["id"])}, None)
    for row in site_rows:
        graph.offer(
            f"site:{row['id']}", {"id": f"site:{row['id']}", "kind": "site", "label": row["name"], "ref": str(row["id"])},
            f"customer:{row['customer_id']}",
        )
    # What belongs to no site is visible only to users who see every customer, and only without a scope.
    unassigned = scope.site_id is None and scope.customer_id is None and visibility.all_access and (
        servers_in_scope.filter(site__isnull=True).exists()
        or visible_targets(visibility, now).filter(site__isnull=True).exists()
        or snmp_devices(visibility, now).filter(site__isnull=True).exists()
    )
    if unassigned:
        graph.offer(UNASSIGNED, {"id": UNASSIGNED, "kind": "group", "label": "No site", "synthetic": True}, None)

    # Choose: worst first, each node with its ancestors; then the sites and customers still empty.
    for *_, node_id in sorted(candidates):
        graph.take(node_id)
    for row in sorted(site_rows, key=lambda r: (r["name"].lower(), str(r["id"]))):
        graph.take(f"site:{row['id']}")
    for row in sorted(customer_rows, key=lambda r: (r["name"].lower(), str(r["id"]))):
        graph.take(f"customer:{row['id']}")

    edges = []
    for edge_id, edge_kind, node_id, server_id in monitored:
        source = f"server:{server_id}"
        if node_id in graph.nodes and source in graph.nodes:
            edges.append({"data": {"id": edge_id, "source": source, "target": node_id, "category": "monitoring", "kind": edge_kind}})

    returned: dict[str, int] = {}
    for node in graph.nodes.values():
        returned[node["data"]["kind"]] = returned.get(node["data"]["kind"], 0) + 1
    for kind, numbers in counts.items():
        numbers["returned"] = returned.get(kind, 0)
    if unassigned:
        counts["group"] = {"visible": 1, "returned": returned.get("group", 0)}
    truncated = any(numbers["returned"] < numbers["visible"] for numbers in counts.values())
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "physicalLinksKnown": False,
            "elements": {"nodes": list(graph.nodes.values()), "edges": edges},
            "counts": counts,
            "truncated": truncated,
        }
    )


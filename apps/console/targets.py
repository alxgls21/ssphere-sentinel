"""Network targets: ``GET /targets/``, ``GET /targets/<id>/`` and ``GET /targets/<id>/series/?range=``.

A list item::

    {"target": {id, name, address, protocol, port, enabled, intervalSeconds, timeoutSeconds,
                circuitId, siteId, agentAssigned, agent},
     "latest": {measuredAt, receivedAt, success, latencyMs, lossPercent, probeCount,
                successfulProbes, failureReason} | null,
     "stale": bool, "health": HealthStatus, "reason": str, "customerName"?, "siteName"?}

``agent`` is ``{id, name, status, lastSeenAt, serverId, serverName}`` when one is
assigned and its server is visible to the user, and ``null`` otherwise
(``agentAssigned`` tells the two apart). ``latest`` is the newest measurement by
the time it was taken, kept whatever its age; ``stale`` is true when there is
one and it is no longer current, and then it takes no part in ``health``.
``reason`` is the rule that decided the status (``apps.console.health``).

A measurement is one round of the agent's probes: ``success`` when at least
one probe got an answer, ``latencyMs`` the mean round trip of those that did
(null when none did), ``lossPercent`` the share that did not, which for a TCP
target is failed connection attempts, not lost packets. Nothing else is
measured: there is no jitter, no per-hop or DNS timing.

The list has the server list's envelope (``page``, ``counts``, ``scopeTotal``)
and parameters:

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    q                words, every one must appear in the name, address, circuit
                     id, site or customer name
    status           all | critical | warning | unknown | idle | healthy
    sort, dir        status | name | latency | loss | measured; asc | desc
    page, pageSize   as for servers

``latency`` and ``loss`` rank only current readings (a current measurement of an
enabled target whose agent reports; latency only when it succeeded) and put
every other target last in both directions; ``measured`` orders by the age of
the latest measurement, targets never measured last. Ties are broken by name,
then id.

The detail is ``{generatedAt, item, measurements, availability24h}``: the item,
the latest ``RECENT`` measurements (newest first, the list's ``latest`` shape),
and what the last 24 hours observed::

    {"from", "to", "measurements", "successful", "percent", "expectedMeasurements", "coveragePercent"}

``percent`` is successful measurements over measurements taken in the window
(null without any). It is an observation, not an SLA figure: the agent may not
have measured all along, so ``expectedMeasurements`` (the window over the
current interval) and ``coveragePercent`` say how much of the window it covers.

The series is ``{generatedAt, bucketMs, t, latencyMs, latencyMaxMs, lossPercent,
measurements, failed}``, the conventions of ``apps.console.history``: parallel
arrays, oldest first, clock-aligned completed buckets only, ``null`` where a
bucket has no value. ``latencyMs``/``latencyMaxMs`` are the mean and the highest
latency of the measurements that succeeded, ``lossPercent`` their mean loss
(a failed measurement is counted in ``failed``, not as 100 % loss);
``measurements`` and ``failed`` are counts (0 for an empty bucket). The bucket
is the server series' for the range, never shorter than the target's interval.
A target never measured has empty arrays.

Access: every target query starts from ``request.visibility.filter``, every
measurement query from ``visibility.filter(..., site_path="target__site")``; a
hidden or unknown target is a 404. Explicit column lists (``.values``): an
agent's token hash is never read.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from django.db.models import Case, Count, F, FloatField, Q, When
from django.http import JsonResponse
from django.utils import timezone

from apps.console.access import Scope, Visibility
from apps.console.health import HEALTH_NAMES, annotate_targets, offline_cutoff
from apps.console.history import DEFAULT_RANGE, RANGES
from apps.console.http import console_api
from apps.console.listing import filter_list, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import agent_server_names, assigned_agent_payload, iso
from apps.network.models import NetworkMeasurement, NetworkTarget

STATUS_FILTERS = ("all", "critical", "warning", "unknown", "idle", "healthy")
SORT_KEYS = ("status", "name", "latency", "loss", "measured")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"status": "desc", "name": "asc", "latency": "desc", "loss": "desc", "measured": "desc"}
LIST_PARAMS = ("q", "status", "sort", "dir", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = ("name", "hostname_or_ip", "circuit_identifier", "site__name", "site__customer__name")
# The only columns ever read for a target (see the module docstring).
FIELDS = (
    "id",
    "name",
    "hostname_or_ip",
    "protocol",
    "port",
    "enabled",
    "monitoring_interval_seconds",
    "timeout_seconds",
    "circuit_identifier",
    "site_id",
    "site__name",
    "site__customer__name",
    "assigned_agent_id",
    "assigned_agent__name",
    "assigned_agent__last_seen_at",
    "assigned_agent__server_id",
    "latest_id",
    "measurement_fresh",
    "severity",
    "health_reason",
)
MEASUREMENT_FIELDS = (
    "id",
    "measured_at",
    "received_at",
    "success",
    "latency_ms",
    "packet_loss_percentage",
    "probe_count",
    "successful_probes",
    "failure_reason",
)
RECENT = 20
AVAILABILITY_WINDOW = timedelta(hours=24)


def visible_targets(visibility: Visibility, now: datetime, scope: Scope | None = None):
    """Targets the user may see, with their latest measurement and health: the start of every target query."""
    return annotate_targets(visibility.filter(NetworkTarget.objects.all(), scope=scope), now)


def visible_measurements(visibility: Visibility, scope: Scope | None = None):
    return visibility.filter(NetworkMeasurement.objects.all(), site_path="target__site", scope=scope)


def current_reading(now: datetime) -> Q:
    """A latest measurement that judges the target: enabled, its agent reporting, the measurement current."""
    return Q(
        enabled=True,
        assigned_agent__enabled=True,
        assigned_agent__last_seen_at__gte=offline_cutoff(now),
        measurement_fresh=True,
    )


def ordering(sort: str, direction: str, now: datetime):
    """The ORDER BY of the list, and the annotations it needs, as ``(annotations, expressions)``."""
    ascending = direction == "asc"
    tie = [name_order("name"), "pk"]
    if sort == "name":
        return {}, [name_order("name", descending=not ascending), "pk"]
    if sort == "status":
        return {}, [F("severity").desc() if ascending else F("severity").asc(), *tie]
    if sort == "measured":
        # By age: the oldest measurement is the largest.
        oldest = F("latest_measured_at").asc(nulls_last=True)
        newest = F("latest_measured_at").desc(nulls_last=True)
        return {}, [newest if ascending else oldest, *tie]
    current = current_reading(now)
    if sort == "latency":
        value = Case(When(current & Q(latest_success=True), then=F("latest_latency_ms")), default=None, output_field=FloatField())
    else:
        value = Case(When(current, then=F("latest_loss")), default=None, output_field=FloatField())
    column = F("_sort_value")
    return (
        {"_sort_value": value},
        [column.asc(nulls_last=True) if ascending else column.desc(nulls_last=True), *tie],
    )


def serialize_measurement(row: dict) -> dict:
    return {
        "measuredAt": iso(row["measured_at"]),
        "receivedAt": iso(row["received_at"]),
        "success": row["success"],
        "latencyMs": row["latency_ms"],
        "lossPercent": row["packet_loss_percentage"],
        "probeCount": row["probe_count"],
        "successfulProbes": row["successful_probes"],
        "failureReason": row["failure_reason"] or None,
    }


def serialize(row: dict, latest: dict | None, servers: dict[UUID, str], now: datetime) -> dict:
    """One list item from a row of ``FIELDS``, its latest measurement, and the visible agent servers' names."""
    item = {
        "target": {
            "id": str(row["id"]),
            "name": row["name"],
            "address": row["hostname_or_ip"],
            "protocol": row["protocol"],
            "port": row["port"],
            "enabled": row["enabled"],
            "intervalSeconds": row["monitoring_interval_seconds"],
            "timeoutSeconds": row["timeout_seconds"],
            "circuitId": row["circuit_identifier"] or None,
            "siteId": str(row["site_id"]) if row["site_id"] is not None else None,
            "agentAssigned": row["assigned_agent_id"] is not None,
            "agent": assigned_agent_payload(row, servers, now),
        },
        "latest": serialize_measurement(latest) if latest is not None else None,
        "stale": latest is not None and not row["measurement_fresh"],
        "health": HEALTH_NAMES[row["severity"]],
        "reason": row["health_reason"],
    }
    if row["site__customer__name"] is not None:
        item["customerName"] = row["site__customer__name"]
    if row["site__name"] is not None:
        item["siteName"] = row["site__name"]
    return item


def serialize_rows(visibility: Visibility, rows: list[dict], now: datetime, scope: Scope | None = None) -> list[dict]:
    """The items of one page: its latest measurements and its agents' servers in one query each."""
    latest_ids = [row["latest_id"] for row in rows if row["latest_id"] is not None]
    latest = {}
    if latest_ids:
        latest = {
            m["id"]: m for m in visible_measurements(visibility, scope).filter(pk__in=latest_ids).values(*MEASUREMENT_FIELDS)
        }
    servers = agent_server_names(visibility, rows)
    return [serialize(row, latest.get(row["latest_id"]), servers, now) for row in rows]


@console_api()
def target_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "status")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    in_scope = visible_targets(request.visibility, now, scope)
    rows, counts, total, scope_total = filter_list(in_scope, words=words, fields=SEARCH_FIELDS, status=status)

    items: list[dict] = []
    if page.offset < total:
        annotations, order = ordering(sort, direction, now)
        rows = list(rows.annotate(**annotations).order_by(*order).values(*FIELDS)[page.offset : page.offset + page.size])
        items = serialize_rows(request.visibility, rows, now, scope)
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


def availability(visibility: Visibility, target_id: UUID, interval_seconds: int, now: datetime) -> dict:
    """What the last 24 hours observed (see the module docstring)."""
    start = now - AVAILABILITY_WINDOW
    observed = visible_measurements(visibility).filter(
        target_id=target_id, measured_at__gte=start, measured_at__lte=now
    ).aggregate(measurements=Count("pk"), successful=Count("pk", filter=Q(success=True)))
    measurements, successful = observed["measurements"], observed["successful"]
    expected = int(AVAILABILITY_WINDOW.total_seconds()) // interval_seconds
    return {
        "from": iso(start),
        "to": iso(now),
        "measurements": measurements,
        "successful": successful,
        "percent": round(successful * 100 / measurements, 2) if measurements else None,
        "expectedMeasurements": expected,
        "coveragePercent": round(min(measurements, expected) * 100 / expected, 1) if expected else None,
    }


@console_api()
def target_detail(request, target_id: UUID):
    now = timezone.now()
    QueryParams(request, ())  # no parameters: a stray one is a mistake, not ignored
    visibility = request.visibility
    row = visibility.get(visible_targets(visibility, now).values(*FIELDS), target_id)
    (item,) = serialize_rows(visibility, [row], now)
    recent = (
        visible_measurements(visibility)
        .filter(target_id=target_id)
        .order_by("-measured_at", "-id")
        .values(*MEASUREMENT_FIELDS)[:RECENT]
    )
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "item": item,
            "measurements": [serialize_measurement(m) for m in recent],
            "availability24h": availability(visibility, target_id, row["monitoring_interval_seconds"], now),
        }
    )


def bucket_seconds(range_key: str, interval_seconds: int) -> int:
    """The server series' bucket for the range, never shorter than the target's interval (it would be empty every other time)."""
    return max(int(RANGES[range_key][1].total_seconds()), interval_seconds)


def build_series(rows, *, range_key: str, interval_seconds: int, now: datetime) -> dict:
    """The series of ``rows`` (``(measured_at, success, latency_ms, loss)``) over ``range_key`` ending at ``now``."""
    step = bucket_seconds(range_key, interval_seconds)
    count = int(RANGES[range_key][0].total_seconds()) // step
    first = int(now.timestamp()) // step * step - count * step
    measured = [0] * count
    failed = [0] * count
    latencies: list[list[float]] = [[] for _ in range(count)]
    losses: list[list[float]] = [[] for _ in range(count)]
    for measured_at, success, latency, loss in rows:
        index = (int(measured_at.timestamp()) - first) // step
        if not 0 <= index < count:
            continue
        measured[index] += 1
        if success:
            latencies[index].append(latency)
            losses[index].append(loss)
        else:
            failed[index] += 1
    return {
        "bucketMs": step * 1000,
        "t": [(first + index * step) * 1000 for index in range(count)],
        "latencyMs": [round(sum(v) / len(v), 3) if v else None for v in latencies],
        "latencyMaxMs": [round(max(v), 3) if v else None for v in latencies],
        "lossPercent": [round(sum(v) / len(v), 2) if v else None for v in losses],
        "measurements": measured,
        "failed": failed,
    }


@console_api()
def target_series(request, target_id: UUID):
    now = timezone.now()
    params = QueryParams(request, ("range",))
    range_key = params.choice("range", RANGES, DEFAULT_RANGE)
    visibility = request.visibility
    target = visibility.get(
        NetworkTarget.objects.only("pk", "monitoring_interval_seconds", "site_id"), target_id
    )
    interval = target.monitoring_interval_seconds
    step = bucket_seconds(range_key, interval)
    count = int(RANGES[range_key][0].total_seconds()) // step
    first = int(now.timestamp()) // step * step - count * step
    end = first + count * step  # start of the current bucket
    measurements = visible_measurements(visibility).filter(target_id=target.pk)
    if not measurements.exists():
        series = {
            "bucketMs": step * 1000, "t": [], "latencyMs": [], "latencyMaxMs": [], "lossPercent": [],
            "measurements": [], "failed": [],
        }
    else:
        rows = (
            measurements.filter(
                measured_at__gte=datetime.fromtimestamp(first, tz=now.tzinfo),
                measured_at__lt=datetime.fromtimestamp(end, tz=now.tzinfo),
            )
            .order_by()
            .values_list("measured_at", "success", "latency_ms", "packet_loss_percentage")
        )
        series = build_series(rows, range_key=range_key, interval_seconds=interval, now=now)
    return JsonResponse({"generatedAt": iso(now), **series})

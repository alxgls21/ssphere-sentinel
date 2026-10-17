"""SNMP devices: ``GET /devices/``, ``GET /devices/<id>/``, ``GET /devices/<id>/series/?range=`` and
``GET /devices/<id>/interfaces/<ifIndex>/series/?range=``.

A device is an inventory device with an SNMP configuration; others are not SNMP
devices and are not served here. A list item::

    {"device": {id, name, type, address, enabled, siteId, snmpVersion, port, pollIntervalSeconds,
                timeoutSeconds, retries, agentAssigned, agent},
     "state": {reachable, error, responseMs, uptimeSeconds, sysName, sysDescr, sysObjectId,
               lastPollAt, lastSuccessAt, lastDiscoveryAt, receivedAt} | null,
     "stale": bool, "health": HealthStatus, "reason": str,
     "interfaces": {"total": int, "counts": {critical, warning, unknown, idle, healthy}},
     "customerName"?, "siteName"?}

``agent`` as for targets (``apps.console.targets``): shown only when its server
is visible. ``state`` is the latest poll (``DeviceSnmpState``), kept whatever its
age; ``stale`` is true when there is one and it is no longer current, and it then
takes no part in ``health``. ``interfaces`` counts the present interfaces by
their health. The credential profile, and anything else about credentials, is
never read.

The list has the envelope and parameters of the target list:

    customer, site   a UUID from ``/scope/``; unknown or hidden: 404
    q                words, every one must appear in the name, address, sysName,
                     site or customer name
    status           all | critical | warning | unknown | idle | healthy
    sort, dir        status | name | response | polled; asc | desc
    page, pageSize   as for servers

``response`` ranks only a current reachable poll (others last both ways);
``polled`` is the age of the latest poll (never polled last).

The detail is ``{generatedAt, item, polls, interfaces}``: the latest ``RECENT``
polls ``{measuredAt, receivedAt, reachable, responseMs, error}`` newest first, and
the present interfaces by ifIndex::

    {ifIndex, name, descr, alias, type, speedBps, adminStatus, operStatus,
     operStatusChangedAt, health, reason, rates}

``adminStatus``/``operStatus`` are IF-MIB's words (``up``, ``down``,
``lowerLayerDown``...). ``rates`` is the interface's latest sample::

    {measuredAt, deltaState, octetsBits, intervalSeconds, valid, invalidReason,
     inBps, outBps, inUtilizationPercent, outUtilizationPercent,
     inErrorsPerSec, outErrorsPerSec, inDiscardsPerSec, outDiscardsPerSec} | null

The rates of a sample, from the deltas the agent calculated (it handles wraps,
resets and restarts, ``docs/snmp.md``): ``bps = octets delta * 8 / interval``,
errors and discards per second ``= delta / interval``. A sample gives none of
them (``valid`` false, every rate null, never 0) and says why in
``invalidReason``, the first of:

    delta_state   its deltas are not valid (``first``, ``reboot``, ``reset``, ``gap``)
    interval      no positive ``interval_seconds``
    implausible   the interface speed is known and a direction exceeds 1.5 times it
    stale         (latest sample only) taken before the device's stale cutoff

A valid sample without one counter (the device lacks it) has that rate null.
Utilization needs a known speed (the sample's): otherwise it is null and the
bps stand.

The device series is ``{generatedAt, bucketMs, t, responseMs, reachablePolls,
failedPolls}``: the mean response time of the reachable polls, and the polls
of each kind. The interface series is ``{generatedAt, bucketMs, t, inBps, outBps,
inBpsMax, outBpsMax, inErrorsPerSec, outErrorsPerSec, inDiscardsPerSec,
outDiscardsPerSec, validSamples, invalidSamples}``: means (and maxima) over the
valid samples of each bucket, each sample judged by itself (its state, interval
and speed: a stale device does not void its history). Both follow
``apps.console.history``: clock-aligned completed buckets only, ``null`` where a
bucket has no value, counts 0, the bucket never shorter than the poll interval,
empty arrays for a device (interface) never polled (sampled).

Access: every query starts from ``request.visibility``: devices by their site,
interfaces through ``device__site``, polls and samples through theirs. A hidden
or unknown device, or an unknown interface of it, is a 404.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from django.db.models import Case, Count, F, FloatField, OuterRef, Q, Subquery, When
from django.http import Http404, JsonResponse
from django.utils import timezone

from apps.console.access import Scope, Visibility
from apps.console.health import (
    HEALTH_NAMES,
    HEALTH_RANKS,
    HEALTHY,
    annotate_devices,
    empty_counts,
    interface_health,
    offline_cutoff,
)
from apps.console.history import DEFAULT_RANGE, RANGES
from apps.console.http import console_api
from apps.console.listing import apply_search, counts_by_severity, name_order, page_envelope
from apps.console.params import PAGE_PARAMS, SCOPE_PARAMS, PageRequest, QueryParams
from apps.console.serializers import iso
from apps.console.targets import agent_status
from apps.infrastructure.models import Server
from apps.inventory.models import Device
from apps.snmp.models import (
    DELTA_STATES_WITH_VALUES,
    AdminStatus,
    DevicePoll,
    Interface,
    InterfaceSample,
    OperStatus,
)

STATUS_FILTERS = ("all", "critical", "warning", "unknown", "idle", "healthy")
SORT_KEYS = ("status", "name", "response", "polled")
DIRECTIONS = ("asc", "desc")
DEFAULT_DIRECTION = {"status": "desc", "name": "asc", "response": "desc", "polled": "desc"}
LIST_PARAMS = ("q", "status", "sort", "dir", *SCOPE_PARAMS, *PAGE_PARAMS)
SEARCH_FIELDS = ("name", "management_address", "snmp_state__sys_name", "site__name", "site__customer__name")
# The only columns ever read for a device: never the credential profile.
FIELDS = (
    "id",
    "name",
    "device_type",
    "management_address",
    "enabled",
    "site_id",
    "site__name",
    "site__customer__name",
    "snmp_config__version",
    "snmp_config__port",
    "snmp_config__poll_interval_seconds",
    "snmp_config__timeout_seconds",
    "snmp_config__retries",
    "assigned_agent_id",
    "assigned_agent__name",
    "assigned_agent__last_seen_at",
    "assigned_agent__server_id",
    "snmp_state__reachable",
    "snmp_state__error",
    "snmp_state__response_ms",
    "snmp_state__sys_uptime_ticks",
    "snmp_state__sys_name",
    "snmp_state__sys_descr",
    "snmp_state__sys_object_id",
    "snmp_state__last_poll_at",
    "snmp_state__last_success_at",
    "snmp_state__last_discovery_at",
    "snmp_state__received_at",
    "stale_before",
    "poll_fresh",
    "severity",
    "health_reason",
)
INTERFACE_FIELDS = (
    "id",
    "if_index",
    "name",
    "descr",
    "alias",
    "if_type",
    "speed_bps",
    "admin_status",
    "oper_status",
    "oper_status_changed_at",
    "present",
)
SAMPLE_FIELDS = (
    "id",
    "measured_at",
    "interval_seconds",
    "speed_bps",
    "octets_bits",
    "delta_state",
    "in_octets_delta",
    "out_octets_delta",
    "in_errors_delta",
    "out_errors_delta",
    "in_discards_delta",
    "out_discards_delta",
)
RECENT = 20
# The agent reads at most 4,096 rows of a table (docs/snmp.md): no device has more interfaces.
MAX_INTERFACES = 4096
# A rate above this many times the interface speed is not believed.
PLAUSIBLE_SPEED_FACTOR = 1.5
ADMIN_WORDS = {value: label for value, label in AdminStatus.choices}
OPER_WORDS = {value: label for value, label in OperStatus.choices}
RATE_KEYS = (
    "inBps",
    "outBps",
    "inUtilizationPercent",
    "outUtilizationPercent",
    "inErrorsPerSec",
    "outErrorsPerSec",
    "inDiscardsPerSec",
    "outDiscardsPerSec",
)


def snmp_devices(visibility: Visibility, now: datetime, scope: Scope | None = None):
    """SNMP devices the user may see, with their health: the start of every device query."""
    return annotate_devices(
        visibility.filter(Device.objects.filter(snmp_config__isnull=False), scope=scope), now
    )


def current_poll(now: datetime) -> Q:
    """A latest poll that judges the device: enabled, its agent reporting, the poll current."""
    return Q(
        enabled=True,
        assigned_agent__enabled=True,
        assigned_agent__last_seen_at__gte=offline_cutoff(now),
        poll_fresh=True,
    )


def ordering(sort: str, direction: str, now: datetime):
    ascending = direction == "asc"
    tie = [name_order("name"), "pk"]
    if sort == "name":
        return {}, [name_order("name", descending=not ascending), "pk"]
    if sort == "status":
        return {}, [F("severity").desc() if ascending else F("severity").asc(), *tie]
    if sort == "polled":
        oldest = F("snmp_state__last_poll_at").asc(nulls_last=True)
        newest = F("snmp_state__last_poll_at").desc(nulls_last=True)
        return {}, [newest if ascending else oldest, *tie]
    value = Case(
        When(current_poll(now) & Q(snmp_state__reachable=True), then=F("snmp_state__response_ms")),
        default=None,
        output_field=FloatField(),
    )
    column = F("_sort_value")
    return {"_sort_value": value}, [column.asc(nulls_last=True) if ascending else column.desc(nulls_last=True), *tie]


# -- rates ---------------------------------------------------------------------


def sample_rates(sample: dict, *, stale_before: datetime | None = None) -> dict:
    """The rates of one sample, or why it gives none (see the module docstring)."""
    interval = sample["interval_seconds"]
    speed = sample["speed_bps"] or None
    reason = None
    if sample["delta_state"] not in DELTA_STATES_WITH_VALUES:
        reason = "delta_state"
    elif interval is None or interval <= 0:
        reason = "interval"
    rates = dict.fromkeys(RATE_KEYS)
    if reason is None:
        for direction in ("in", "out"):
            octets = sample[f"{direction}_octets_delta"]
            rates[f"{direction}Bps"] = octets * 8 / interval if octets is not None else None
            for counter, key in (("errors", "ErrorsPerSec"), ("discards", "DiscardsPerSec")):
                delta = sample[f"{direction}_{counter}_delta"]
                rates[f"{direction}{key}"] = delta / interval if delta is not None else None
        if speed is not None and any(
            rates[key] is not None and rates[key] > PLAUSIBLE_SPEED_FACTOR * speed for key in ("inBps", "outBps")
        ):
            reason = "implausible"
        elif stale_before is not None and sample["measured_at"] < stale_before:
            reason = "stale"
    if reason is not None:
        rates = dict.fromkeys(RATE_KEYS)
    elif speed is not None:
        for direction in ("in", "out"):
            bps = rates[f"{direction}Bps"]
            rates[f"{direction}UtilizationPercent"] = round(bps * 100 / speed, 2) if bps is not None else None
    return {key: round(value, 3) if isinstance(value, float) else value for key, value in rates.items()} | {
        "valid": reason is None,
        "invalidReason": reason,
    }


def serialize_rates(sample: dict | None, stale_before: datetime | None) -> dict | None:
    if sample is None:
        return None
    return {
        "measuredAt": iso(sample["measured_at"]),
        "deltaState": sample["delta_state"],
        "octetsBits": sample["octets_bits"],
        "intervalSeconds": sample["interval_seconds"],
        **sample_rates(sample, stale_before=stale_before),
    }


# -- items ---------------------------------------------------------------------


def serialize(row: dict, interface_counts: dict, servers: dict[UUID, str], now: datetime) -> dict:
    agent = None
    server_id = row["assigned_agent__server_id"]
    if row["assigned_agent_id"] is not None and server_id in servers:
        agent = {
            "id": str(row["assigned_agent_id"]),
            "name": row["assigned_agent__name"],
            "status": agent_status(row["assigned_agent__last_seen_at"], now),
            "lastSeenAt": iso(row["assigned_agent__last_seen_at"]) if row["assigned_agent__last_seen_at"] else None,
            "serverId": str(server_id),
            "serverName": servers[server_id],
        }
    polled = row["snmp_state__last_poll_at"]
    state = None
    if polled is not None:
        ticks = row["snmp_state__sys_uptime_ticks"]
        state = {
            "reachable": row["snmp_state__reachable"],
            "error": row["snmp_state__error"] or None,
            "responseMs": row["snmp_state__response_ms"],
            "uptimeSeconds": ticks // 100 if ticks is not None else None,
            "sysName": row["snmp_state__sys_name"] or None,
            "sysDescr": row["snmp_state__sys_descr"] or None,
            "sysObjectId": row["snmp_state__sys_object_id"] or None,
            "lastPollAt": iso(polled),
            "lastSuccessAt": iso(row["snmp_state__last_success_at"]) if row["snmp_state__last_success_at"] else None,
            "lastDiscoveryAt": iso(row["snmp_state__last_discovery_at"]) if row["snmp_state__last_discovery_at"] else None,
            "receivedAt": iso(row["snmp_state__received_at"]) if row["snmp_state__received_at"] else None,
        }
    item = {
        "device": {
            "id": str(row["id"]),
            "name": row["name"],
            "type": row["device_type"],
            "address": row["management_address"],
            "enabled": row["enabled"],
            "siteId": str(row["site_id"]) if row["site_id"] is not None else None,
            "snmpVersion": row["snmp_config__version"],
            "port": row["snmp_config__port"],
            "pollIntervalSeconds": row["snmp_config__poll_interval_seconds"],
            "timeoutSeconds": row["snmp_config__timeout_seconds"],
            "retries": row["snmp_config__retries"],
            "agentAssigned": row["assigned_agent_id"] is not None,
            "agent": agent,
        },
        "state": state,
        "stale": polled is not None and not row["poll_fresh"],
        "health": HEALTH_NAMES[row["severity"]],
        "reason": row["health_reason"],
        "interfaces": {"total": sum(interface_counts.values()), "counts": interface_counts},
    }
    if row["site__customer__name"] is not None:
        item["customerName"] = row["site__customer__name"]
    if row["site__name"] is not None:
        item["siteName"] = row["site__name"]
    return item


def interfaces_of(visibility: Visibility, scope: Scope | None = None):
    return visibility.filter(Interface.objects.all(), site_path="device__site", scope=scope)


def serialize_rows(visibility: Visibility, rows: list[dict], now: datetime, scope: Scope | None = None) -> list[dict]:
    """The items of one page: interface counts and agent servers in one query each."""
    ids = [row["id"] for row in rows]
    healthy = {row["id"]: row["severity"] == HEALTHY for row in rows}
    counts = {device_id: empty_counts() for device_id in ids}
    statuses = (
        interfaces_of(visibility, scope)
        .filter(device_id__in=ids, present=True)
        .order_by()
        .values("device_id", "admin_status", "oper_status")
        .annotate(n=Count("pk"))
    )
    for status in statuses:
        health, _ = interface_health(
            device_healthy=healthy[status["device_id"]],
            present=True,
            admin_status=status["admin_status"],
            oper_status=status["oper_status"],
        )
        counts[status["device_id"]][health] += status["n"]
    server_ids = {row["assigned_agent__server_id"] for row in rows if row["assigned_agent__server_id"] is not None}
    servers = dict(visibility.filter(Server.objects.filter(pk__in=server_ids)).values_list("pk", "name")) if server_ids else {}
    return [serialize(row, counts[row["id"]], servers, now) for row in rows]


@console_api()
def device_list(request):
    now = timezone.now()
    params = QueryParams(request, LIST_PARAMS)
    scope = params.scope(request.visibility)
    words = params.search()
    status = params.choice("status", STATUS_FILTERS, "all")
    sort = params.choice("sort", SORT_KEYS, "status")
    direction = params.choice("dir", DIRECTIONS, DEFAULT_DIRECTION[sort])
    page = PageRequest.from_params(params)

    in_scope = snmp_devices(request.visibility, now, scope)
    matching = apply_search(in_scope, words, SEARCH_FIELDS)
    counts = counts_by_severity(matching)
    scope_total = sum(counts.values()) if not words else in_scope.count()
    total = sum(counts.values()) if status == "all" else counts[status]

    items: list[dict] = []
    if page.offset < total:
        rows = matching if status == "all" else matching.filter(severity=HEALTH_RANKS[status])
        annotations, order = ordering(sort, direction, now)
        rows = list(rows.annotate(**annotations).order_by(*order).values(*FIELDS)[page.offset : page.offset + page.size])
        items = serialize_rows(request.visibility, rows, now, scope)
    return JsonResponse(page_envelope(now, items, page, total=total, counts=counts, scope_total=scope_total))


@console_api()
def device_detail(request, device_id: UUID):
    now = timezone.now()
    QueryParams(request, ())
    visibility = request.visibility
    row = visibility.get(snmp_devices(visibility, now).values(*FIELDS), device_id)
    (item,) = serialize_rows(visibility, [row], now)
    polls = (
        visibility.filter(DevicePoll.objects.filter(device_id=device_id), site_path="device__site")
        .order_by("-measured_at")
        .values("measured_at", "received_at", "reachable", "response_ms", "error")[:RECENT]
    )
    latest_sample = InterfaceSample.objects.filter(interface=OuterRef("pk")).order_by("-measured_at")
    interfaces = list(
        interfaces_of(visibility)
        .filter(device_id=device_id, present=True)
        .annotate(latest_sample_id=Subquery(latest_sample.values("id")[:1]))
        .order_by("if_index")
        .values(*INTERFACE_FIELDS, "latest_sample_id")[:MAX_INTERFACES]
    )
    sample_ids = [i["latest_sample_id"] for i in interfaces if i["latest_sample_id"] is not None]
    samples = {}
    if sample_ids:
        samples = {
            s["id"]: s
            for s in visibility.filter(
                InterfaceSample.objects.filter(pk__in=sample_ids), site_path="interface__device__site"
            ).values(*SAMPLE_FIELDS)
        }
    device_healthy = row["severity"] == HEALTHY
    served = []
    for interface in interfaces:
        health, reason = interface_health(
            device_healthy=device_healthy,
            present=interface["present"],
            admin_status=interface["admin_status"],
            oper_status=interface["oper_status"],
        )
        served.append(
            {
                "ifIndex": interface["if_index"],
                "name": interface["name"],
                "descr": interface["descr"] or None,
                "alias": interface["alias"] or None,
                "type": interface["if_type"],
                "speedBps": interface["speed_bps"],
                "adminStatus": ADMIN_WORDS.get(interface["admin_status"], "unknown"),
                "operStatus": OPER_WORDS.get(interface["oper_status"], "unknown"),
                "operStatusChangedAt": iso(interface["oper_status_changed_at"]) if interface["oper_status_changed_at"] else None,
                "health": health,
                "reason": reason,
                "rates": serialize_rates(samples.get(interface["latest_sample_id"]), row["stale_before"]),
            }
        )
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "item": item,
            "polls": [
                {
                    "measuredAt": iso(p["measured_at"]),
                    "receivedAt": iso(p["received_at"]),
                    "reachable": p["reachable"],
                    "responseMs": p["response_ms"],
                    "error": p["error"] or None,
                }
                for p in polls
            ],
            "interfaces": served,
        }
    )


# -- series --------------------------------------------------------------------


def window(range_key: str, interval_seconds: int, now: datetime) -> tuple[int, int, int]:
    """``(step, count, first)``: the server series' bucket, never shorter than the poll interval, and the window."""
    step = max(int(RANGES[range_key][1].total_seconds()), interval_seconds)
    count = int(RANGES[range_key][0].total_seconds()) // step
    first = int(now.timestamp()) // step * step - count * step
    return step, count, first


def bounds(first: int, step: int, count: int, now: datetime) -> tuple[datetime, datetime]:
    return (
        datetime.fromtimestamp(first, tz=now.tzinfo),
        datetime.fromtimestamp(first + count * step, tz=now.tzinfo),  # the bucket in progress is not served
    )


def visible_device(visibility: Visibility, device_id: UUID):
    return visibility.get(
        Device.objects.filter(snmp_config__isnull=False).values("pk", "snmp_config__poll_interval_seconds"), device_id
    )


def mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


@console_api()
def device_series(request, device_id: UUID):
    now = timezone.now()
    params = QueryParams(request, ("range",))
    range_key = params.choice("range", RANGES, DEFAULT_RANGE)
    visibility = request.visibility
    device = visible_device(visibility, device_id)
    step, count, first = window(range_key, device["snmp_config__poll_interval_seconds"], now)
    polls = visibility.filter(DevicePoll.objects.filter(device_id=device["pk"]), site_path="device__site")
    empty = {"bucketMs": step * 1000, "t": [], "responseMs": [], "reachablePolls": [], "failedPolls": []}
    if not polls.exists():
        return JsonResponse({"generatedAt": iso(now), **empty})
    start, end = bounds(first, step, count, now)
    responses: list[list[float]] = [[] for _ in range(count)]
    reachable = [0] * count
    failed = [0] * count
    rows = polls.filter(measured_at__gte=start, measured_at__lt=end).order_by().values_list("measured_at", "reachable", "response_ms")
    for measured_at, ok, response in rows:
        index = (int(measured_at.timestamp()) - first) // step
        if not 0 <= index < count:
            continue
        if ok:
            reachable[index] += 1
            if response is not None:
                responses[index].append(response)
        else:
            failed[index] += 1
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "bucketMs": step * 1000,
            "t": [(first + i * step) * 1000 for i in range(count)],
            "responseMs": [mean(v) for v in responses],
            "reachablePolls": reachable,
            "failedPolls": failed,
        }
    )


SERIES_KEYS = ("inBps", "outBps", "inErrorsPerSec", "outErrorsPerSec", "inDiscardsPerSec", "outDiscardsPerSec")


@console_api()
def interface_series(request, device_id: UUID, if_index: int):
    now = timezone.now()
    params = QueryParams(request, ("range",))
    range_key = params.choice("range", RANGES, DEFAULT_RANGE)
    visibility = request.visibility
    device = visible_device(visibility, device_id)
    interface = interfaces_of(visibility).filter(device_id=device["pk"], if_index=if_index).values("pk").first()
    if interface is None:
        raise Http404
    step, count, first = window(range_key, device["snmp_config__poll_interval_seconds"], now)
    samples = visibility.filter(
        InterfaceSample.objects.filter(interface_id=interface["pk"]), site_path="interface__device__site"
    )
    keys = (*SERIES_KEYS, "inBpsMax", "outBpsMax", "validSamples", "invalidSamples")
    if not samples.exists():
        return JsonResponse({"generatedAt": iso(now), "bucketMs": step * 1000, "t": [], **{key: [] for key in keys}})
    start, end = bounds(first, step, count, now)
    values: dict[str, list[list[float]]] = {key: [[] for _ in range(count)] for key in SERIES_KEYS}
    valid = [0] * count
    invalid = [0] * count
    for sample in samples.filter(measured_at__gte=start, measured_at__lt=end).order_by().values(*SAMPLE_FIELDS):
        index = (int(sample["measured_at"].timestamp()) - first) // step
        if not 0 <= index < count:
            continue
        rates = sample_rates(sample)  # judged by itself: its state, interval and speed, not today's freshness
        if not rates["valid"]:
            invalid[index] += 1
            continue
        valid[index] += 1
        for key in SERIES_KEYS:
            if rates[key] is not None:
                values[key][index].append(rates[key])
    return JsonResponse(
        {
            "generatedAt": iso(now),
            "bucketMs": step * 1000,
            "t": [(first + i * step) * 1000 for i in range(count)],
            **{key: [mean(v) for v in values[key]] for key in SERIES_KEYS},
            "inBpsMax": [round(max(v), 3) if v else None for v in values["inBps"]],
            "outBpsMax": [round(max(v), 3) if v else None for v in values["outBps"]],
            "validSamples": valid,
            "invalidSamples": invalid,
        }
    )

"""Resource history: ``GET /servers/<id>/series/?range=15m|1h|6h|24h`` (the UI's ``ServerSeries``).

    {"generatedAt", "bucketMs", "t": [bucket start, epoch ms], "cpu": [..], "memory": [..], "disk": [..]}

The arrays are parallel, oldest first, ``null`` where a bucket has no sample
(a host that was silent leaves a gap, not a zero). A value is the mean of the
samples in its bucket, in percent, to two decimals. Buckets are aligned to the
clock (UTC) and only completed buckets are served: the chart can lag "now" by
up to one bucket, and a trailing ``null`` therefore means the host stopped
reporting, never "this bucket has not filled yet". The bucket sizes are the UI's (1 minute for 15m and 1h, 5 minutes for 6h,
15 minutes for 24h); the sample grid (``SENTINEL_TELEMETRY_SAMPLE_SECONDS``,
a divisor of 60 or 300) never makes a bucket empty. A server that has never
reported telemetry has empty arrays.

Access: the server is looked up with ``Visibility.get`` (hidden and unknown are
the same 404) and the samples themselves are read through ``Visibility.filter``
as well. At most ``range / sample grid`` rows are read for a request, from the
primary key's index, and they are averaged here, in Python, so the result does
not depend on any database-specific date arithmetic.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from django.conf import settings
from django.db.models import Exists, OuterRef
from django.http import JsonResponse
from django.utils import timezone

from apps.console.http import console_api
from apps.console.params import QueryParams
from apps.console.serializers import iso
from apps.infrastructure.models import Server, ServerTelemetry, ServerTelemetrySample

# range -> (length, bucket).
RANGES = {
    "15m": (timedelta(minutes=15), timedelta(minutes=1)),
    "1h": (timedelta(hours=1), timedelta(minutes=1)),
    "6h": (timedelta(hours=6), timedelta(minutes=5)),
    "24h": (timedelta(hours=24), timedelta(minutes=15)),
}
DEFAULT_RANGE = "1h"
METRICS = ("cpu", "memory", "disk")


def window(range_key: str, minimum_seconds: int, now: datetime) -> tuple[int, int, int]:
    """``(step, count, first)`` of every series: the UI's bucket for the range, never shorter than
    ``minimum_seconds`` (a finer bucket would be empty every other time), and the window, the
    ``count`` completed buckets before the current one, from ``first`` (epoch seconds)."""
    step = max(int(RANGES[range_key][1].total_seconds()), minimum_seconds)
    count = int(RANGES[range_key][0].total_seconds()) // step
    first = int(now.timestamp()) // step * step - count * step
    return step, count, first


def bounds(first: int, step: int, count: int, now: datetime) -> tuple[datetime, datetime]:
    return (
        datetime.fromtimestamp(first, tz=now.tzinfo),
        datetime.fromtimestamp(first + count * step, tz=now.tzinfo),  # the bucket in progress is not served
    )


def bucket_starts_ms(first: int, step: int, count: int) -> list[int]:
    return [(first + index * step) * 1000 for index in range(count)]


def bucket_seconds(range_key: str) -> int:
    """Seconds per bucket: the UI's, but never below the sample grid (a finer bucket would be empty every other time)."""
    return max(int(RANGES[range_key][1].total_seconds()), int(settings.SENTINEL_TELEMETRY_SAMPLE_SECONDS))


def build_series(rows, *, range_key: str, now: datetime) -> dict:
    """The series of ``rows`` (``(sampled_at, cpu, memory, disk)``) over ``range_key`` ending at ``now``."""
    step, count, first = window(range_key, bucket_seconds(range_key), now)
    sums = [[0.0, 0.0, 0.0] for _ in range(count)]
    seen = [0] * count
    for sampled_at, cpu, memory, disk in rows:
        index = (int(sampled_at.timestamp()) - first) // step
        if 0 <= index < count:
            seen[index] += 1
            for slot, value in enumerate((cpu, memory, disk)):
                sums[index][slot] += value
    series = {name: [] for name in METRICS}
    for index in range(count):
        for slot, name in enumerate(METRICS):
            series[name].append(round(sums[index][slot] / seen[index], 2) if seen[index] else None)
    return {
        "bucketMs": step * 1000,
        "t": bucket_starts_ms(first, step, count),
        **series,
    }


@console_api()
def server_series(request, server_id: UUID):
    now = timezone.now()
    params = QueryParams(request, ("range",))
    range_key = params.choice("range", RANGES, DEFAULT_RANGE)
    visibility = request.visibility
    server = visibility.get(
        Server.objects.only("pk").annotate(
            has_telemetry=Exists(ServerTelemetry.objects.filter(server=OuterRef("pk")))
        ),
        server_id,
    )
    step, count, first = window(range_key, bucket_seconds(range_key), now)
    if not server.has_telemetry:
        series = {"bucketMs": step * 1000, "t": [], "cpu": [], "memory": [], "disk": []}
    else:
        start, end = bounds(first, step, count, now)
        rows = visibility.filter(
            ServerTelemetrySample.objects.filter(server_id=server.pk, sampled_at__gte=start, sampled_at__lt=end),
            site_path="server__site",
        ).order_by().values_list("sampled_at", "cpu_percent", "memory_percent", "disk_percent")
        series = build_series(rows, range_key=range_key, now=now)
    return JsonResponse({"generatedAt": iso(now), **series})

# Data requirements

Visualizations the console deliberately does not draw today, and what the backend would
have to serve for each. What exists is read from the backend models and the console API
(`/api/v1/console/`: session, scope, servers, server detail, server series, containers).
Nothing here is drawn from simulated or inferred values.

## Availability heatmap (uptime by interval)

Not built. A heatmap of uptime would say how long something was up, and the backend
cannot say that.

- **Exists.** `Server.status` and `last_seen_at`, the latest values only: the console API
  judges a server offline when `last_seen_at` is older than the offline threshold (90 s
  by default) at the time of the request, and nothing records earlier periods.
  `ServerTelemetrySample` keeps CPU, RAM and disk, at most one per sample slot (60 s by
  default), for 7 days by default (2 to 365); the series endpoint serves 15m, 1h, 6h and
  24h in 1, 1, 5 and 15 minute buckets, `null` where a bucket has no sample. That gap
  means no sample arrived. Heartbeats go on when the telemetry section is missing or
  dropped, so a gap is reporting continuity, not availability, and the console never
  calls it uptime. `NetworkMeasurement` (a success flag per probe) and `DevicePoll`
  (reachability per SNMP poll) are stored, 30 days by default, and not served. There is
  no state-transition log and no availability aggregate for any entity. The uptime in the
  Servers list is the host's own uptime counter, a different fact.
- **Missing.** A per-entity state history (entity, state, since) or a per-bucket
  aggregate (time in each state), decided by the backend with the rules of
  `apps/console/health.py` and served by the console API.
- **Missing.** Ranges beyond 24 h: 7, 30 and 90 days, bucketed by hour for a day-by-hour
  grid and by day for the longest, with retention long enough to fill them.
- **Missing.** "Down", "offline" and "no data" kept apart by construction: a bucket says
  healthy, degraded, down, offline or no data (nothing recorded: before enrolment,
  outside retention, or the collector was not running), never zero-filled and never
  inferred from a gap in telemetry.
- **Missing.** The access rules of the other endpoints: `Visibility` for every entity
  (hidden and unknown are one 404), the `customer` and `site` scope parameters, strict
  query parameters, a bounded number of rows per request.
- **Console.** A GitHub-style grid, one row per entity over the range or one row per day
  of 24 hour cells for one entity. Each cell is one of the five states or no data, drawn
  as shape, word and color (the status alphabet, an empty cell for no data), never color
  alone. Hover and focus give the interval, the state and the minutes in each state, and
  a table twin carries the same values. "Uptime" names only a share of time the backend
  measured as healthy. No cell is interpolated or simulated.

## Network throughput sparklines

- **Exists.** SNMP `InterfaceSample`: per interface and poll, the raw `in_octets` and
  `out_octets` counters, the deltas with `interval_seconds`, the `delta_state` (valid,
  first sample, reboot, reset, gap) and `speed_bps`, kept 30 days by default. It is stored
  and not served: the console API has no SNMP endpoint and the console does not read SNMP
  yet. Nothing else carries throughput: server telemetry is CPU, RAM and disk, and a
  probe measurement is latency and loss.
- **Missing.** Console API endpoints to list devices and interfaces under the scope
  rules, and a series per interface: bits per second in and out per bucket, from the
  deltas, `null` where the `delta_state` says the delta is not valid or no sample arrived,
  with the interface speed.
- **Missing.** Throughput of the monitored hosts themselves, if wanted: the agent would
  have to report interface counters, which it does not.
- **Console.** A `Sparkline` per interface in bits per second, on a domain from 0 to the
  link speed or to the observed maximum, a gap drawn as a gap. A reboot or a counter
  reset is a gap, never a spike or a zero.

## Sparklines in lists (Servers rows, Fleet load)

- **Exists.** `servers/<id>/series/` returns one server's CPU, RAM and disk for one
  range. A sparkline per row would cost one request per server listed (the API pages its
  list, 50 by default and 200 at most), and eight for Fleet load. The list payload
  carries only each server's latest reading.
- **Missing.** One request for many servers: a series per item in the list payload, or a
  summary endpoint that takes the page's server ids and returns, for each, a short fixed
  series (12 to 24 buckets) of CPU, RAM and disk, `null` where no sample arrived, with `t`
  and `bucketMs` once for all. It follows the rules of the single series: clock-aligned
  completed buckets, `Visibility` for every id (a hidden id is not echoed), a cap on ids
  and buckets per request.
- **Console.** An inspectable `Sparkline` beside the load meter of each row and in Fleet
  load, over the range in the top bar. The meter and its figure stay the primary reading.

## Incidents

- **Exists.** The console derives incidents from the event log (`SentinelEvent[]`): an
  opener is a warning or critical event with no parent, and the first healthy descendant
  that names the same subject (kind and id) after the opener closes it. A healthy event of
  another subject, one that names no subject and one stamped before the opener close
  nothing, and info events never do. An event carries no acknowledgement, so the timeline
  claims none. The backend has no event log, alert rules, acknowledgement or incident
  record, so the Overview mounts no timeline: its Recent events panel is PLANNED and holds
  no rows. The derivation stays as a component, shown in the gallery with labelled sample
  events.
- **Missing.** One record per incident with a stable identifier: the subject (kind, id,
  name), the severity it opened at and any change, `opened_at`, `resolved_at` or none, and
  what resolved it. Acknowledgement as data: who and when, with an optional note.
- **Missing.** Range semantics: the incidents that overlap the range, with their real
  start even when it is before the range, and the ongoing and resolved counts, the order
  and the durations computed by the server, under the access rules of the other endpoints.
- **Console.** The timeline reads incidents directly: lanes keyed by identifier, a real
  start for a bar the axis cuts, an acknowledged mark only from the record, the summary from
  the server's counts. The derivation goes away and the log stays as its text equivalent.
  Whether incidents feed the verdict is a separate product decision.

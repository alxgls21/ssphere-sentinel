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
  calls it uptime. `NetworkMeasurement` is served per target by `targets/<id>/` and its
  series, and `DevicePoll` (reachability per SNMP poll) is stored, 30 days by default, and served by `devices/<id>/` and its series. There is
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
  first sample, reboot, reset, gap) and `speed_bps`, kept 30 days by default. The console
  API serves the latest rates of each interface with the device and a series per interface
  (`devices/<id>/interfaces/<ifIndex>/series/`): bits per second in and out per bucket,
  `null` where the `delta_state` says the delta is not valid or no sample arrived, with the
  interface speed. The SNMP screen draws them. Nothing else carries throughput: server
  telemetry is CPU, RAM and disk, and a probe measurement is latency and loss. The Overview
  does not read them yet.
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

- **Exists.** The alert engine records one incident per occurrence of a rule's condition on
  one object, with a stable identifier, the severity, the condition it opened on, when the
  condition began and when it opened, who acknowledged it and when, when a recovery began and
  was confirmed, and when and why it ended without one. The console API serves the list, one
  incident with its timeline, the acknowledgement and the engine's state, and the Alerts screen
  and the Overview read them. An acknowledged incident is still open.
- **Still derived, and unmounted.** The lane timeline over a range reads incidents from an event
  log (`SentinelEvent[]`): an opener is a warning or critical event with no parent, and the
  first healthy descendant that names the same subject closes it. An event carries no
  acknowledgement and no closure reason, so that derivation cannot show what the alert engine
  records, and it stays a component in the gallery with labelled sample events. The backend has
  no event log, so the Overview's Recent events panel is PLANNED and holds no rows.
- **Missing.** Incidents over a range: the ones that overlap it with their real start, and
  their durations computed by the server. The lane timeline could then read the records
  directly, with an acknowledged mark and a closure reason from them.
- **Missing.** A count of open incidents per site or per entity kind for the Overview: the API
  counts per status over the scope, the search, the severity and the kind, one request each.
- **Not built.** Resolving an incident by hand: it ends when the engine confirms a recovery, or
  when monitoring of its object ends.

## Alert rules and notifications

- **Exists.** The console API serves the alert rules (list, one rule, create, change, and the options a form may
  offer: the kinds, their conditions and reasons, the limits and defaults), a user's own email preferences, a
  test email to their own address, and the system's status (the alert engine, the notifier, the email outbox
  and what the deployment sets). Settings reads and writes them; every write carries the version that was read,
  and the contract of which changes end open incidents comes with the rule and with the options.
- **Not built.** Deleting a rule: an incident keeps its rule, so a rule is disabled. Changing a rule's kind or its
  default key. Anything but email as a way to be told (a webhook, a chat message), and a recipient other than
  the signed-in user.
- **Missing.** The trail of configuration changes the backend records (who changed which rule or preference,
  and when): no endpoint serves it, so no screen shows it.
- **Missing.** The customers and sites a rule may name are `scope/`'s: an account that may manage rules sees
  all of them, but there is no search over them, so a very large estate would need one.

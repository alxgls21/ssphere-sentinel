# Frontend architecture

SSphere Sentinel's web console is a React single-page app in `frontend/`. It is
**independent of the Django backend**: it shares no code with it, and reads it only
through the console API behind an API port.

## Hard boundaries

- Everything lives under `frontend/`. Nothing outside it is touched (no Django
  models, migrations, agent code, Docker files or CI).
- The console API serves the session and the scope (`/api/v1/console/session/`,
  `scope/`, `auth/login/`, `auth/logout/`), the servers (`servers/`, `servers/<id>/`,
  `servers/<id>/series/`), the containers (`containers/`) and the network targets (`targets/`,
  `targets/<id>/`, `targets/<id>/series/`) and the SNMP devices (`devices/`, `devices/<id>/`,
  `devices/<id>/series/`, `devices/<id>/interfaces/<ifIndex>/series/`), the incidents (`incidents/`,
  `incidents/<id>/`, `incidents/<id>/acknowledge/`) and the alert engine's state
  (`alerts/engine-status/`). The Servers, Docker, Network, SNMP and Alerts screens, Fleet load, the
  top bar and the Overview read them. It serves no events, and no
  fleet-wide probe aggregate: wherever one of those would be drawn, the UI says it is not
  served and shows no figure (see _Honest labelling_ below).
- No unfinished feature may look operational, and no figure may be made up for one.

## Stack

| Concern       | Choice                                                         | Why                                                                                   |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| UI            | React 19 + TypeScript (strict, `noUncheckedIndexedAccess`)     |                                                                                       |
| Build         | Vite 8                                                         | fast dev server, a static `dist/`                                                     |
| Styling       | Tailwind CSS v4, tokens in CSS (`@theme static`)               | one token source shared by CSS, SVG and charts                                        |
| Charts        | Apache ECharts 6, modular imports, canvas renderer, lazy chunk | only the chart types we use are bundled; the shell paints before any chart code loads |
| Icons         | lucide-react (tree-shaken)                                     |                                                                                       |
| Routing       | react-router                                                   | deep links; the URL carries the view (range, scope, mock scenario)                    |
| Fonts         | `@fontsource` (self-hosted, latin + latin-ext + greek)         | NOC networks are often air-gapped: no CDN                                             |
| Tests         | Vitest + Testing Library (jsdom)                               |                                                                                       |
| Lint / format | Oxlint (react, hooks, jsx-a11y, typescript) + Prettier         |                                                                                       |

Deliberately **not** included: TanStack Query (`useResource` is a small state
machine that covers polling and states; swap it later behind the same
signature), a UI kit (components are small and ours), a state library (state is
local, in context, or in the URL), Cytoscape.js (added with the Topology screen,
once approved).

## Folder structure

```
frontend/
  docs/                   this file, the design system, the full design spec
  src/
    main.tsx  fonts.ts    entry; self-hosted font imports
    api/                  THE DATA CONTRACT
      types.ts              domain view-models
      client.ts             SentinelApi: the port (one method per panel resource)
      context.ts errors.ts
      http/                 the console API adapter (transport, session, scope, servers, containers)
      mock/                 the sample fleet of servers and containers (development and tests only)
    app/                  providers and cross-cutting state
      providers.tsx         router > data source > prefs > live layer > summary
      consoleApi.ts         composes the console API requests into the whole SentinelApi
      live.ts               pause, refresh-now, freshness store
      viewState.ts          range and scope, in the URL
      viewSearch.ts         carries the view to another screen (useViewTo)
      scenario.ts           the mock scenario, in the URL (the only bridge to api/mock)
      hotkeys/              the keyboard layer
    config/               features.ts (what the backend implements), nav.ts, shortcuts.ts
    hooks/                useResource, useLiveResource, useStale, ...
    lib/                  pure helpers: status (health and its offline presentation), thresholds, verdict, format, freshness
    styles/               tokens.css (the only place colors are written), base CSS
    ui/                   design-system primitives
      controls/ meters/ entity-cells/ status/ states/ provenance/ incidents/ events/ Panel.tsx
    charts/               ECharts setup, theme from the tokens, ChartFrame, shared time-series pieces
    shell/                app frame: sidebar, top bar, status bar, command palette, sheets
    features/
      overview/           hero/ queue/ load/ health/ alerts/ (latency/ holds components for data the
                          console API does not serve yet; the Overview does not mount them)
      alerts/             incident list (table, cards, filters), incident page (summary, timeline), acknowledge
      servers/            list (table, cards, search/filter/sort) and detail (summary with sparklines, history chart, containers)
      placeholder/        honest "not designed yet" screens
      design-system/      dev-only gallery at /_ds
    test/                 test setup and render helpers
```

### Dependency rules

Enforced by `src/architecture.test.ts` (a rule nothing enforces drifts):

| Layer                | May import                                             | Never                            |
| -------------------- | ------------------------------------------------------ | -------------------------------- |
| `api` (the contract) | nothing                                                | everything else                  |
| `api/mock`           | `api`, `lib`                                           | UI, app                          |
| `api/http`           | `api`                                                  | everything else                  |
| `lib`                | `api` (types only)                                     | `app`, `ui`, `shell`, `features` |
| `ui`                 | `api`, `app`, `config`, `hooks`, `lib`                 | `shell`, `charts`, `features`    |
| `charts`             | `app`, `lib`, `hooks`, `config`                        | `features`                       |
| `shell`              | `app`, `ui`, `hooks`, `config`, `lib`, `api`           | `features`                       |
| `features/x`         | `ui`, `charts`, `app`, `hooks`, `config`, `lib`, `api` | another feature                  |
| `app`                | everything (it wires the app)                          |                                  |

- Only `app/` knows the mock (`app/providers.tsx`, `app/scenario.ts`). Screens,
  the shell and the primitives talk to `SentinelApi`.
- `ui/` is not hermetic: primitives read three ambient contexts through hooks
  (the data source for provenance, the display preferences, the live layer for
  staleness). They stay free of any screen or the shell.
- The design-system gallery (`features/design-system`) may import from
  `features/overview`: it exists to show those components in every state.

## Data flow

```
panel --useLiveResource(id, key, fetch)--> useApi() --> SentinelApi --> console API (HTTP) | sample fleet (dev)
```

- `SentinelApi` is the only door to data. Each Overview panel has its own method,
  so each panel loads, refreshes and fails independently. A panel with nothing behind it
  has no method at all.
- `useResource` owns loading / success / error, polling, abort, pause, and
  stale-while-revalidate: a failed refresh keeps the last good data, a reload
  keeps the previous render, an explicit retry of a failed first load shows the
  loading state again. `useLiveResource` wires it into the live layer.
- **The live layer** (`app/live.ts`): one poll interval (15 s), pause (`p`),
  refresh now (`r`), and a freshness store every live resource reports into. The
  shared summary also polls every 60 s in a hidden tab, so a background tab's
  title and favicon stay true.
- **Freshness**: older than 45 s reads STALE, older than 120 s (or every request
  failed) reads NO DATA. A panel also judges its own data age, so one dead
  endpoint is visible on its own panel. A dead dashboard must never look healthy:
  the sidebar badges show the unknown ring, not an old count.
- **Health vocabulary** (`lib/status.ts`): the one place a domain state becomes a
  `HealthStatus`, and where the offline presentation lives. `DisplayStatus`
  adds `'offline'` to the five health statuses; `displayStatus`, `healthOf`,
  `DISPLAY_ORDER`, `displayCounts` and `countEntities` map between the two.
  Offline is critical to anything that decides (verdict, ranking, filters, badges,
  tab title, favicon, severity edge), which reads `HealthStatus`; only marks that
  describe an entity or a composition show it apart (`design-system.md`).
- **The Overview** is servers, containers, probe targets and SNMP devices. `app/consoleApi.ts` asks
  the console API for the worst first of each (one page of 200, sorted by status, in the topbar
  scope) and derives the summary, the attention queue and the health breakdown from those four
  answers (`lib/overview.ts`, pure). No device is read one by one: the Overview never asks for a
  device's detail or history, and never for a second page. The verdict, the queue and the health
  panel ask at the same moment and share one set of requests; if any of the four fails, the
  Overview fails with it, because a verdict without one of its lists would understate. Totals and per-status counts are the API's own and cover the whole scope; the console
  never recounts a page as if it were the fleet. What is made of the rows is exact only for the part
  of the fleet the rows cover, and says so: the queue counts the problems it cannot list
  (`AttentionResult.omitted`) and the idle containers, disabled targets and disabled devices beyond
  its rows (`hiddenIdle`), and the sites carry a `siteCoverage`. `all`: all four lists fit in one
  page, so every site is whole. `problems`: they do not, but every server, container, target and
  device that needs attention is in the rows, so each site lists
  those (healthy and idle ones are not counted per site). `none`: the problems alone exceed the rows,
  so no site is totalled and the panel says so. Exact per-site totals for a larger fleet need a
  per-site count from the console API (see _Docker screen_). A failed request rejects: it is that
  panel's error, and nothing stands in for it.
- **Incidents** are the alert engine's own records, served as they are (see _Alerts screen_). The
  lane timeline that derives incidents from an event log (`features/overview/events/incidentModel.ts`)
  is a different thing and stays unmounted: the backend has no event log. The log's lines
  (`ui/events/`) are shared, and draw one incident's recorded steps on its page.
- Types in `api/types.ts` are the UI's own view-models. When the backend ships
  read endpoints, write an HTTP client that maps their payloads onto them; no
  screen changes.
- The sample fleet is deterministic (seeded, time-keyed): values are stable across
  refreshes and screenshots are reproducible, yet drift so the console feels live. It holds
  servers and containers only: it invents no targets, devices, incidents or events (its target list
  is empty, its summary counts none, it records no incident and its alert engine has never run).

### State that lives in the URL

`?range=6h&customer=…&site=…&mock=error`. Reload, back, a shared link and the
command palette can never disagree. Every in-app link goes through `useViewTo`,
so a link to another screen keeps the view (a bare path would silently reset it).

### Mock scenarios

`?mock=` or the command palette: `normal` (the outage story, verdict CRITICAL),
`healthy` (NOMINAL), `partial` (PARTIAL), `stale` (each method answers once, then
fails: watch the stale guard), `slow`, `loading`, `empty`, `error`. Every state
can be seen and tested without a backend.

## Honest labelling

`config/features.ts` keeps four facts apart, and none implies another:

- `backend`: what the backend offers (`console-api`: the console API serves it;
  `stored`: stored but not served to the console; `unsupported`; `unknown`).
- `connected`: whether the console reads it yet. False while a screen shows demo
  data or nothing, even where the backend is ready.
- `requires`: what an operator must set up for the backend to have data. It is
  information. It says nothing about whether that was done, and setting it up does
  not make data appear in a console that is not connected.
- `configuration`: whether that setup is done, only from reliable evidence (a
  capability the backend reports). Never inferred from `requires`; absent means
  unknown, and unknown is not "missing". No entry sets it today: there is no
  runtime detection.

`availabilityOf(id, source)` derives one state, and every marker follows it.
Connection comes first, and a feature is `live` only when the console API serves
it, the console reads it and the data is not demo data (anything unknown, or a
missing data source, is not live):

| State                 | Meaning                                                           | Marker                                                   |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `live`                | served, read by the screen, real data                             | the quiet source tag only                                |
| `not-connected`       | the console API does not serve it, or the screen does not read it | `mock` tag (demo figures) or a dashed NOT CONNECTED chip |
| `needs-configuration` | otherwise live, and its setup is confirmed missing                | dashed frame, NEEDS SETUP chip                           |
| `planned`             | the backend does not implement it                                 | dashed frame, PLANNED chip, a sentence, no figure        |
| `unknown`             | no entry, or not detected                                         | no claim either way (never shown as unsupported)         |

**One provenance contract.** What rendered content may call itself comes from
`provenanceOf(features, source)` (`config/features.ts`), read through
`useProvenance`, and nowhere else:

- `live` only when every feature behind it is `live`, which needs the console API,
  the screen reading it and an HTTP source. The adapter alone is never enough: an
  HTTP adapter says nothing about whether this feature's figures are real.
- `mock` for demo, simulated or stored-only figures, and for any mix that includes
  them. A panel combining a live and a demo feature is `mock`.
- `unknown` when nothing can be verified: no source, no feature to judge it by (a
  component that backs no registered feature), or only unknown features. It fails
  conservatively and is shown as `unverified`, never `live`.

The visual tag (`live`, `mock`, `unverified`) and the spoken text (nothing for live,
"mock data", "source not verified") come from the same value, so a screen reader hears
what a sighted user sees. Entity cells are judged by their own kind's feature. The
app-wide indicators (top bar chip, notice strip, status bar, tab title) read
`useShowsDemoData()`: they stay until every feature that shows figures is live
(`DATA_FEATURES`: the overview counts, the servers and the site assignment; features with no
figure on any screen are not in the list).

`Panel` takes the backing features as a required prop and derives its markers:
a quiet source tag (`live`, `mock`, `unverified`) always, and, when nothing real exists
behind it (unsupported, or a placeholder feature such as the Overview's fleet latency), a dashed
frame, a chip and one sentence in place of the body. Such a panel renders no children, no
footer and no loading or error state: it has nothing to load, so it holds no figure, chart,
sample row or zero. PLANNED is reserved for what the backend does not implement. The Overview's
fleet latency (`network-overview`) is `not-connected`: the backend stores what it could be derived
from, but the console API serves no aggregate, so configuring it does not make data appear there.
The Network and SNMP screens are the `network` and `snmp` features, which are live, and so are the
Overview's device tile, queue rows and health row: they are the `snmp` feature read through the
Overview's counts. Stat tiles follow the same
rule. Placeholder panels never feed the verdict, the sidebar badges, the tab title or the
palette's PROBLEMS list. The design-system gallery is the one place that draws sample
content for such a feature; it does so in a panel labelled `mock` whose footer says
"Sample data".
Presentational thresholds (80/95 %, 2 % loss, 150 ms) live in
`lib/thresholds.ts`, are judged on the value as displayed, and are labelled
"UI defaults"; where the console API publishes the resource limits with the session, those are
used instead and labelled "set on the server". When the backend gains a capability, or a screen is connected to it,
change one registry entry.

## Network screen

`SentinelApi` has three target methods, all the console API's: `listTargets` (one page, with
`q` over name, address, circuit id, site and customer; `status`; `sort` by `status`, `name`,
`latency`, `loss`, `measured`; `dir`; `page`; `pageSize`; and the topbar scope), `getTarget` (the
item, the newest 20 measurements and the last 24 hours; 404 for an unknown or hidden id) and
`getTargetSeries` (`range` one of `15m`, `1h`, `6h`, `24h`, the ranges the API serves). Each item
is `{target, latest, stale, health, reason, customerName?, siteName?}`. `health` and `reason` are
the server's decision and are never recomputed: the console words the reason (`disabled`,
`no_agent`, `agent_offline`, `no_measurement`, `stale`, `failing`, `failed`, `latency`, `loss`,
`ok`) in `lib/targets.ts`, so a disabled target, one with no agent, an offline agent, no
measurement, a stale one and a failing one each read differently.

A measurement is a round of an agent's probes. `lossPercent` is the share of them that got no
answer, and what that is depends on the protocol: lost packets for ICMP, failed connection
attempts for TCP. Every label, cell, chart series and sentence follows the protocol (`Packet
loss` and `2.0% lost`; `Failed connection attempts` and `2.0% failed`) and a TCP failure is
never called packet loss. The shared inventory column is headed `LOSS / FAILED` with the
distinction in its title.

Latency and loss are shown as a reading only where the API judged health from a current
measurement; for a stale, disabled, unassigned, unreported or never-measured target the cells
are empty with the reason, and the last measurement is shown only as the last one, with its age
and a `NOT CURRENT` tag. `availability24h.percent` is the share of the measurements taken that
succeeded; `coveragePercent` (measurements against what the interval would give) is shown apart.
Neither is called an SLA, an uptime or a guarantee. The history draws latency (mean and highest
of the measurements that answered), loss and a count of failed measurements on three grids with
one time axis: a bucket with nothing to average is a gap, a failed measurement is counted in its
own series and never drawn as 100% loss, and a bucket with no measurement has no failed count
either. The warning limits drawn come from the session (`probeLatencyWarnMs`,
`probeLossWarnPercent`, `targetCritFailures`), or the console's own defaults, said to be so.

An agent links to its server only when the API gives the agent's `serverId` (it does so only for
servers the user may see); an assigned agent without one is named "assigned" and linked to
nothing. The sample fleet monitors no targets: its list is empty and a target is a 404, so a
development run shows the empty and not-found states, never an invented target. A failed request
is that panel's error with Retry; nothing falls back to other data.

## SNMP screen

`SentinelApi` has four device methods, all the console API's: `listDevices` (one page, with `q`
over name, address, site and customer; `status`; `sort` by `status`, `name`, `response`, `polled`;
`dir`; `page`; `pageSize`; and the topbar scope), `getDevice` (the item, the recent polls and every
present interface; 404 for an unknown or hidden id), `getDeviceSeries` and `getInterfaceSeries`
(`range` one of `15m`, `1h`, `6h`, `24h`, completed buckets only). Each item is `{device, state,
stale, health, reason, interfaces, customerName?, siteName?}`. The device's `health` and `reason`
(`disabled`, `no_agent`, `agent_offline`, `no_poll`, `stale`, `unreachable`, `ok`) are the
server's decision and are never recomputed; `lib/devices.ts` words them. The adapter names every
field it reads, so a credential or credential profile could not reach the UI even if the API sent
one, and it refuses a rate set that contradicts itself (`valid` with a reason, or invalid with a
rate) as a bad response.

A device's health ignores its interfaces: a switch with ports down stays reachable. An
interface has its own health from the API: unhealthy device gives `device_unavailable` (unknown),
admin down is idle, up and up is healthy, admin up with operational down is a warning, anything
else is unknown. The words keep admin down, operationally down, healthy, unknown, absent and
device unavailable apart, and never use critical for an interface.

Response time and the other figures of a poll are shown as present only for a device whose latest
poll is current. For a stale, unreachable-since, disabled, unassigned or never-polled device the
cells are empty with the reason, and the last poll is shown as the last one, with its age and a
`NOT CURRENT` tag. The interface inventory then says its states and rates are the last stored.

Rates are the API's: the console never recalculates a delta. When `rates.valid` is false every
rate is a dash with the `invalidReason` in words (`delta_state` says whether it was the first
sample, a restart, a counter reset or a gap; `interval`; `implausible`; `stale`) and never a zero.
An unknown speed shows the bits per second and an unavailable utilization. The history draws, for
one interface, mean and highest inbound and outbound bits per second, errors and discards per
second on three grids with one time axis: a bucket with no valid sample is a gap, never an
interpolated line or a zero, and the counts of usable and unusable samples are given apart. The
device history draws the mean response time and the reachable and failed polls the same way.

The query lives in the URL (`?q=&status=&sort=&dir=&page=`), the chosen interface in `?interface=`
of the device page, and the list's own query travels in the navigation state so the way back
restores the search and filters. An agent links to its server only when the API gives its
`serverId`. The sample fleet monitors no devices: its list is empty and a device is a 404. A failed
request is that panel's error with Retry; nothing falls back to other data.

### SNMP on the Overview

The devices are the fourth list of the Overview, read as the others are (see _The Overview_ under
_Data flow_), and the API's `scopeTotal` and `counts` are the totals: the Devices tile (`ok` of the
total, problems worst first), the verdict, and the SNMP DEVS row of the health panel. A device's
health is the API's, so an interface that is down never raises the verdict, a tile count or a queue
row. The queue lists the devices that are critical, warning or unknown (disabled ones on request),
worst first and by name, each as `dev` with the type and address, the API's reason in a few words,
the site, and the age of the latest poll (`Last polled` on hover); Enter opens the device's own
page, not a list told to focus it. A device with a site is placed on it in BY SITE.

The API counts interfaces per device, not for the scope, so the Overview has no scope-wide
interface total. The SNMP DEVS row's tooltip adds the interfaces of the devices in the rows, apart
from the devices and in the interfaces' own words (up, down, admin down, unknown): whole when every
device in scope is in the rows (`complete`), and otherwise headed "the first N devices of M" with a
sentence saying it is not a total for the scope. When the scope has no device, there is no
interface figure at all.

## Alerts screen

`SentinelApi` has five incident methods. `listIncidents` is one page, with `q` over the object,
the rule, the site and the customer; `status` (`open` is active and acknowledged, `ended` is
recovered and closed, or one status); `severity`; `kind` (server, container, target, device,
interface); `sort` by `severity`, `status`, `opened`, `started` or `name`; `dir`; `page`; `pageSize`
(50 here, 200 at most); and the topbar scope. `getIncident` is the incident with its rule, whether
the object is still visible to this user (`entityVisible`) and its recorded timeline. `acknowledgeIncident`
posts through the same transport as every write (the session's CSRF token, refreshed once when it
goes stale) and answers with the incident as it now is. `getEngineStatus` is the alert engine's own
state: `running`, `failed`, `stale` or `never_started`. `getIncidentOverview` is what the Overview
and the top bar read (below).

Statuses stay apart by word and mark: **active** (open, not yet seen), **acknowledged** (seen, and
still open), **recovered** (ended: the condition cleared and the recovery was confirmed) and
**closed** (ended without a recovery, with the reason: the object was removed, disabled or moved,
or the rule was disabled or changed). Severity (critical, warning) is a column of its own. The
status chips carry the API's counts, per status over the scope and the search (never the rows on
the page): `OPEN` and `HISTORY` are sums of those counts, and `scopeTotal` is the header's total.
The query lives in the URL (`?q=&status=&severity=&kind=&sort=&dir=&page=`, the opening view is
`status=open`, the worst first); the way back from an incident restores it.

Acknowledging is the one write, and is offered only where the API says `canAcknowledge`: the
incident is active and the account has the permission. It marks an incident as seen and nothing
else; nothing in the console resolves or closes one. Each outcome is worded: acknowledged, already
acknowledged by someone else (the API keeps the first), 403 (no permission), 404 (gone or hidden), 409
(already ended) and a network failure (where it is not known whether it went through). The
incident shown afterwards is the API's answer, and the list and the shell's count are read again.

The incident page links its object to its own page only when the API says the user may see it
(`entityVisible`): a server, target or device on its page, a container on the Docker list focused on
it, an interface on its device's page with that interface chosen. Otherwise it says the object no
longer exists or may not be seen, and prints no reference. Every time is the API's. The timeline is
drawn with the Overview's log lines (`ui/events/EventLog`): the opening, with every later step nested
under it, each at its recorded time.

`getIncidentOverview` is two bounded requests, shared by every reader that arrives together: the
first five open incidents by severity (critical first, then the newest), and a page of one whose
counts say how many open incidents are critical. Open is active and acknowledged, over the whole
scope; the figures are the API's, and the rows only the few that matter most. One `AlertsProvider`
fetches it, with the engine's state, for the whole signed-in shell: the top bar's indicator, the
Overview's Alerts tile and Active alerts panel, and the Alerts screen's engine banner read the same
resources, so they cannot disagree. Open incidents are not added to the verdict: they follow the
health already counted.

An engine that is not running is said wherever incidents are counted: the banner on the Alerts
screen, a line in the Overview's panel and the tile, and a mark and words in the top bar's
accessible name. `never_started` is drawn as unknown, never as healthy, and an empty list from an
engine that is not confirmed running says that it does not mean everything is healthy. A state
that cannot be read is an error with Retry, not a blank. The sample fleet records no incident and
its engine has never run; a failed request is always that panel's error, and nothing stands in
for it.

## Docker screen

`SentinelApi.listContainers` is one page of the containers of every visible server, and the
console API does the work: `q` (words, every one in the name, image, Docker id, server, site or
customer), `status` (`all`, `critical`, `warning`, `unknown`, `idle`, `healthy`), `sort`
(`status`, `name`, `server`, `started`) with `dir`, `page` and `pageSize` (50 here, 200 at most),
the topbar scope as `customer` and `site`, and `server` for one host. Nothing else is sent: the
screen has no other sort, filter or column that the API cannot answer. Each row is the API's
`{container, status, serverName, customerName?, siteName?}`: `container` has the id
(`<server id>:<Docker id>`), `serverId`, `name`, `image`, `state`, `health` and `startedAt`, and
`status` is the health the server decided. The response's `counts` (by status over the scope, the
host and the search, not the status filter) are what the chips say, and `scopeTotal` the header.
The query lives in the URL (`?q=&status=&sort=&dir=&page=&server=`); `focus=<container id>`, which
the Overview's queue opens, shows the host of that container with the row marked.

A container whose host is not reporting, whose Docker is unavailable or whose Docker report is out
of date is served as `unknown` (state and health), because what is stored is last-known. The row
says "unknown" with that explanation and shows no start; the list does not carry the host's status,
so it never says which of the three it is, and never shows a stale state as current. The panel's
own freshness tag still applies to the list as a whole. The inventory is `docker` in the registry,
which is `live` because its only panel reads the API; the Containers panel of a server (its detail)
stays `servers`, and links to this list limited to that host.

What the console API does not give, and the screen therefore does not show: a per-container
timestamp other than `startedAt`, resource metrics, restart counts, exit codes, the host's status in
a container row, and per-site counts. A per-site aggregation (for every site: its servers and its
containers by status, with the names of the worst few) would let the Overview total sites for a
fleet larger than one page; until the API has it the Overview says what it can and cannot total.

## Servers screen

`SentinelApi` gains three methods: `listServers` (one page of the servers in scope that match
a query: `q`, `status`, `sort`, `dir`, `page`, `pageSize`), `getServer` (one server and its
containers, 404 for an unknown id) and `getServerSeries` (CPU, RAM and disk history). The
console API searches, filters, sorts and pages (50 a page, 200 at most); the list asks for a
page and never treats it as the fleet: its `counts` (per status over the scope and the
search) and `scopeTotal` are what the chips and the header say, a page past the last goes
to the last, and the search is asked for once it has held still. The sample data answers the
same query by the same rules (`lib/serverList.ts`, pure and tested). The query lives in
the URL (`?q=&status=&sort=&dir=&page=`), like the range and scope; changing what the list
shows starts again from the first page. A reading marked `stale` by the server is never shown
as a load: the rows say there is no current reading, and the detail page shows the last one
labelled as such.
Below `md` the table becomes cards (`useMediaQuery`: the DOM differs, so one of
the two is mounted, never both). The detail page requests the series once, over the
range in the top bar, and shares it between the Summary's sparklines and the history
chart, so one request serves both and they cannot disagree. The chart is the third
consumer of `ChartFrame` and is in the chart contract test.

What the console API serves for this screen, all of which it reads (the Containers panel
of a server is part of its detail, so it is `servers`, not the Docker screen's `docker`;
a failed request is that panel's error, and no sample data stands in for it):

| Need                       | In the console API                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Server list                | `servers/`: `Server` rows with their status, filtered by scope, searched, sorted and paged   |
| Latest telemetry           | In the list payload, with whether the reading is stale                                       |
| Site / customer per server | `Server.site`: the list carries the names and scope filters on it (`site-links`)             |
| Containers per server      | `servers/<id>/`, with each container's state and health                                      |
| CPU, RAM, disk history     | `servers/<id>/series/`: bucket means of the stored telemetry samples, `null` where none came |

`ServerListItem`, `ServerDetail` and `ServerSeries` (`api/types.ts`) are the
shapes of those payloads. `lib/status.ts` holds the health rules, which the console
API mirrors, so the console and the Overview agree. A server that has never
reported has empty series arrays, and the panel says "No history".

## Authentication and API modes

`VITE_SENTINEL_API` picks the mode (`config/runtime.ts`):

- `http` (default): the console API. Sign-in is required.
- `mock`: the sample fleet, no sign-in. Development and tests only. A production
  build never runs in it: `vite build` fails, and a bundle that carries the
  setting refuses to start with a message (there is no fallback in either
  direction). `?mock=` only means something in this mode.

```
BrowserRouter > ModeContext > AuthProvider > ApiProvider > LimitsProvider > PrefsProvider
  > SessionScope (signed in only: live layer, shared summary, frame state) > routes
```

- **`api/http`** is the adapter: `transport.ts` (same-origin `fetch` with the
  session cookie, CSRF header on writes, one error shape, timeout), `session.ts`
  (sign-in, sign-out, session and scope, each answer validated before use). It
  depends on the contract in `api/` only; only `app/` wires it in (a test
  enforces both).
- **`AuthProvider`** owns the state (`checking`, `anonymous`, `expired`,
  `denied`, `unreachable`, `authenticated`) and nothing else decides it: not the
  URL, not browser storage. `RequireAuth` guards every route but `/login`; the
  live layer, the shared summary and the frame state only exist while signed in,
  so nothing polls on the sign-in page and nothing survives a sign-out.
- **One rule for a dead session.** The transport reports every 401
  `unauthenticated` to the auth state, a signed-in tab asks the server every
  minute, and both lead to `expired`: the guard sends the user to
  `/login?next=<page>&reason=expired`. A 403 `forbidden` re-reads the session
  (the account lost its console permission).
- **`/login?next=`** is followed only for paths inside the application
  (`app/auth/safeNext.ts`): absolute and protocol-relative URLs, other schemes,
  backslashes and control characters are ignored, and the sign-in page is never
  its own destination.
- **Demo data and real data stay apart.** `app/consoleApi.ts` composes the port from the
  console API alone (`api/http`, with every answer validated: one that does not fit is a
  `bad_response` error). The sample fleet is a separate `SentinelApi` that only a development
  run with `VITE_SENTINEL_API=mock` loads, through a dynamic import behind that build-time
  setting, so a production bundle holds no import of it and none of its names. It is
  announced by a `DEMO DATA` strip above every designed screen. The composed port is an
  `http` source, which makes nothing live by itself: the registry says which features the
  console reads (`overview`, `servers`, `site-links`). Adding a method and marking its
  feature connected is how a screen goes live, together.
- **Limits.** The health limits the console API publishes with the session
  (`thresholds`) are what the meters, the history chart and the footers use
  (`app/LimitsProvider`, read through `useResourceLimits`); without them (mock mode)
  the console's own defaults apply and are labelled as such. The health verdicts are the
  server's: the console does not recompute them.

## Routing and navigation

All eight screens are routed from day one. **Overview**, **Servers** (`/servers`,
`/servers/:id`) and **Docker** (`/docker`) are designed; the others render an explicit placeholder. `config/nav.ts` drives the sidebar, the
palette, the `g <key>` go-to chords and route titles.

Responsive: Tailwind breakpoints `sm 40rem`, `md 48rem`, `lg 64rem`, `xl 80rem`,
`2xl 90rem`. Below `md` an app bar replaces the top bar; below `lg` the sidebar is
a drawer; the top bar compacts below `xl`; the sidebar defaults to a rail below
`2xl`. On the Overview, `xl` is two columns, `lg` stacks the queue above 6/6
charts and a 4/4/4 row, `md` folds the PLANNED panels into one collapsed section,
and phones reorder to queue-first with a sticky verdict bar.

## Keyboard

`app/hotkeys` is the one global layer. Letters and digits match the physical key
(`event.code`) so Greek and Cyrillic layouts work. The modifier is ⌘ on macOS and
Ctrl elsewhere. Single-key shortcuts are ignored while typing and can be turned
off (the Display menu, or the command palette on a phone). `config/shortcuts.ts`
is the registry the shortcut sheet is generated from. Panel-scoped keys (`j k y f`
in the queue, `v` on a chart, `a` on alerts) are handled by the focused panel and
yield to a pending `g` chord.

## Accessibility notes

One polite live region (`ShellProvider.announce`) speaks verdict changes, once
(`shell/useDocumentStatus`), and is rate limited to one message per 5 s; a
repeated message is still heard (the region is cleared first). Persistent
staleness never dims small text (60 % opacity would take it below AA); it adds a
STALE tag, and only marks and large figures dim.

## Testing

- `lib/`, `api/mock/`, `hooks/`: unit tests (pure logic, state machines).
- `ui/`, `shell/`, `features/`: Testing Library tests for behavior that matters
  (keyboard, states, accessibility roles), not for pixels.
- `features/overview/OverviewPage.test.tsx`: the page against the sample API.
- `lib/overview.test.ts`, `app/consoleApi.test.ts`: the Overview derived from the console API's two lists, shared requests, aborts, and that a failure is never replaced.
- `styles/tokens.test.ts`: WCAG contrast of every text and mark token, no color
  literal outside `tokens.css`, status-color utilities (healthy, warning, critical and
  offline, with their tint and line) only in `ui/status`, `ui/meters` and `charts`,
  and offline's derived tint and line, its chroma and its separation from the other
  status hues and the greys under simulated color vision.
- `app/auth`, `api/http`, `app/providers.test.tsx`: the transport (CSRF, 401, timeouts), the session
  state, the route guard, `next` handling and the production-mode refusal.
- `architecture.test.ts`: the layering rules above, and that every chart goes
  through `ChartFrame` (nothing else calls the chart runtime).
- `features/design-system/chartContract.test.tsx`: the chart interaction contract
  (`design-system.md`, "Chart interactions") run against every chart. A new chart
  is added to its list.

## Commands

```bash
npm run dev          # Vite dev server (the console API through the proxy)
npm run check        # lint + typecheck + tests + production build + format check
```

## Departures from the design spec

[`design-spec.md`](./design-spec.md) is the panel's spec. Where the build departs
from it on purpose:

- **Stale state**: a STALE tag and mark-only dimming instead of 60 % opacity on
  everything (AA contrast).
- **Thresholds** are judged on the displayed value, so "95 %" never sits beside a
  warning.
- **Breakpoints**: drawer below 1024 px, app bar below 768 px (the spec's table
  and its tablet text disagreed; the tablet text won).
- **Charts**: the latency plot grows with its panel (the spec fixed its height),
  the legend is a single row (the latency chart's 150 ms and loss 2 % limits are
  both labelled on the plot, not in the legend), and chart behavior is shared code
  with a contract test rather than per-chart wiring.
- **Not built (deferred in the spec)**: wall mode, density modes, the inspector
  drawer, "NEW" tags.
- **The Overview counts servers, containers, probe targets and SNMP devices, and shows the open
  incidents apart.** The spec's queue, verdict, tiles and health also cover alerts; the open
  incidents have a tile and a panel [5] of their own and are not added to the verdict. Its panels
  [2] and [6] draw a latency chart and recent events. The console API serves neither (and no
  fleet-wide latency aggregate, only each target's own history), so those panels carry a statement
  and no figure, and the verdict is "of the servers, containers, targets and devices counted". Tiles show
  the ok count of the total (`13/16 ok`), not online or running, because that is what the API's
  counts say. A queue row for a target is worded from the API's reason and dated by its newest
  measurement, and a row for a device by its latest poll, never by a start the API does not give.
  Fleet latency carries the `network-overview` feature and stays a statement.
- **Not installed yet**: Cytoscape (Topology screen).

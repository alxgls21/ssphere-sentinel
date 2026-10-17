# Frontend architecture

SSphere Sentinel's web console is a React single-page app in `frontend/`. It is
**independent of the Django backend**: it shares no code with it, and reads it only
through the console API behind an API port.

## Hard boundaries

- Everything lives under `frontend/`. Nothing outside it is touched (no Django
  models, migrations, agent code, Docker files or CI).
- The console API serves the session and the scope (`/api/v1/console/session/`,
  `scope/`, `auth/login/`, `auth/logout/`), the servers (`servers/`, `servers/<id>/`,
  `servers/<id>/series/`) and the containers (`containers/`). The Servers screens, Fleet
  load and the Overview read them. It serves no probe targets, SNMP devices, alerts,
  incidents or events: wherever one of those would be drawn, the UI says it is not
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
      controls/ meters/ entity-cells/ status/ states/ provenance/ Panel.tsx
    charts/               ECharts setup, theme from the tokens, ChartFrame, shared time-series pieces
    shell/                app frame: sidebar, top bar, status bar, command palette, sheets
    features/
      overview/           hero/ queue/ load/ health/ (latency/ and events/ hold components for
                          data the console API does not serve yet; the Overview does not mount them)
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
- **The Overview** is servers and containers. `app/consoleApi.ts` asks the console API for the
  worst first of each (one page of 200, sorted by status) and derives the summary, the
  attention queue and the health breakdown from those two answers (`lib/overview.ts`, pure).
  The verdict, the queue and the health panel ask at the same moment and share one pair of
  requests. Totals and per-status counts are the API's own and cover the whole scope; the console
  never recounts a page as if it were the fleet. What is made of the rows is exact only for the part
  of the fleet the rows cover, and says so: the queue counts the problems it cannot list
  (`AttentionResult.omitted`) and the idle containers beyond its rows (`hiddenIdle`), and the sites
  carry a `siteCoverage`. `all`: both lists fit in one page, so every site is whole. `problems`:
  they do not, but every server and container that needs attention is in the rows, so each site lists
  those (healthy and idle ones are not counted per site). `none`: the problems alone exceed the rows,
  so no site is totalled and the panel says so. Exact per-site totals for a larger fleet need a
  per-site count from the console API (see _Docker screen_). A failed request rejects: it is that
  panel's error, and nothing stands in for it.
- **Incidents** would not be a resource either: an incident timeline is derived in the console
  from an event log (`features/overview/events/incidentModel.ts`). The backend has no event
  log, so no screen mounts it; the components are kept for when one exists.
- Types in `api/types.ts` are the UI's own view-models. When the backend ships
  read endpoints, write an HTTP client that maps their payloads onto them; no
  screen changes.
- The sample fleet is deterministic (seeded, time-keyed): values are stable across
  refreshes and screenshots are reproducible, yet drift so the console feels live. It holds
  servers and containers only: it invents no targets, devices, alerts or events.

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
behind it (unsupported, or a placeholder feature such as probe targets or SNMP), a dashed
frame, a chip and one sentence in place of the body. Such a panel renders no children, no
footer and no loading or error state: it has nothing to load, so it holds no figure, chart,
sample row or zero. PLANNED is reserved for what the backend does not implement. Probe
targets and SNMP are `not-connected`: the backend stores them, but the console API does not
serve them, so configuring them does not make data appear here. Stat tiles follow the same
rule. Placeholder panels never feed the verdict, the sidebar badges, the tab title or the
palette's PROBLEMS list. The design-system gallery is the one place that draws sample
content for such a feature; it does so in a panel labelled `mock` whose footer says
"Sample data".
Presentational thresholds (80/95 %, 2 % loss, 150 ms) live in
`lib/thresholds.ts`, are judged on the value as displayed, and are labelled
"UI defaults"; where the console API publishes the resource limits with the session, those are
used instead and labelled "set on the server". When the backend gains a capability, or a screen is connected to it,
change one registry entry.

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
- **The Overview counts servers and containers only.** The spec's queue, verdict, tiles and
  health also cover ICMP/TCP targets, SNMP devices and alerts, and its panels [2], [5] and [6]
  draw a latency chart, active alerts and recent events. The console API serves none of those,
  so their tiles and panels carry a statement and no figure, and the verdict is "of the servers
  and containers counted". Tiles show the ok count of the total (`13/16 ok`), not online or
  running, because that is what the API's counts say.
- **Not installed yet**: Cytoscape (Topology screen).

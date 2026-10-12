# Frontend architecture

SSphere Sentinel's web console is a React single-page app in `frontend/`. It is
**independent of the Django backend**: it shares no code with it, and today it
runs entirely on mock data behind an API port.

## Hard boundaries

- Everything lives under `frontend/`. Nothing outside it is touched (no Django
  models, migrations, agent code, Docker files or CI).
- The backend exposes no read API yet (only agent ingest at `/api/v1/agent/`).
  **All data in the console is mock**, and the UI says so (see
  _Honest labelling_ below).
- No unfinished feature may look operational.

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
      mock/                 the only implementation today (fixtures, series, scenarios)
    app/                  providers and cross-cutting state
      providers.tsx         router > data source > prefs > live layer > summary
      live.ts               pause, refresh-now, freshness store
      viewState.ts          range and scope, in the URL
      viewSearch.ts         carries the view to another screen (useViewTo)
      scenario.ts           the mock scenario, in the URL (the only bridge to api/mock)
      hotkeys/              the keyboard layer
    config/               features.ts (what the backend implements), nav.ts, shortcuts.ts
    hooks/                useResource, useLiveResource, useStale, ...
    lib/                  pure helpers: status, thresholds, verdict, format, freshness
    styles/               tokens.css (the only place colors are written), base CSS
    ui/                   design-system primitives
      controls/ meters/ entity-cells/ status/ states/ provenance/ Panel.tsx
    charts/               ECharts setup, theme from the tokens, ChartFrame, shared time-series pieces
    shell/                app frame: sidebar, top bar, status bar, command palette, sheets
    features/
      overview/           the one designed screen: hero/ queue/ latency/ load/ health/ alerts/ events/
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
panel --useLiveResource(id, key, fetch)--> useApi() --> SentinelApi --> mock | (future) HTTP
```

- `SentinelApi` is the only door to data. Each Overview panel has its own method,
  so each panel loads, refreshes and fails independently.
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
- Types in `api/types.ts` are the UI's own view-models. When the backend ships
  read endpoints, write an HTTP client that maps their payloads onto them; no
  screen changes.
- The mock is deterministic (seeded, time-keyed): charts are stable across
  refreshes and screenshots are reproducible, yet values drift so the console
  feels live.

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

`config/features.ts` records what the backend really implements per feature
(`ingest`, `partial`, `admin-only`, `planned`). `Panel` takes the backing
features as a required prop and derives its markers: a quiet `mock · 15s` tag
always, plus a dashed frame, a PLANNED chip and a footer sentence when every
feature behind it is unimplemented. Planned and sample data never feed the
verdict, the sidebar badges, the tab title or the palette's PROBLEMS list.
Presentational thresholds (80/95 %, 2 % loss, 150 ms) live in
`lib/thresholds.ts`, are judged on the value as displayed, and are labelled
"UI defaults". When the backend gains a capability, change one registry entry.

## Routing and navigation

All eight screens are routed from day one. Only **Overview** is designed; the
others render an explicit placeholder. `config/nav.ts` drives the sidebar, the
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
- `features/overview/OverviewPage.test.tsx`: the page against the real mock API.
- `styles/tokens.test.ts`: WCAG contrast of every text and mark token, no color
  literal outside `tokens.css`, status-color utilities only in `ui/status`,
  `ui/meters` and `charts`.
- `architecture.test.ts`: the layering rules above, and that every chart goes
  through `ChartFrame` (nothing else calls the chart runtime).
- `features/design-system/chartContract.test.tsx`: the chart interaction contract
  (`design-system.md`, "Chart interactions") run against every chart. A new chart
  is added to its list.

## Commands

```bash
npm run dev          # Vite dev server (mock data)
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
  the legend is a single row (the warning threshold is labelled on the plot, not
  in the legend), and chart behavior is shared code with a contract test rather
  than per-chart wiring.
- **Not built (the spec's Phase 2)**: wall mode, density modes, the inspector
  drawer, "NEW" tags.
- **Not installed yet**: Cytoscape (Topology screen).

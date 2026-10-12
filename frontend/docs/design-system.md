# Design system

A terminal-inspired, dark-first design language for a NOC console: dense but
readable, thin borders, precise mono typography, status you can read from five
metres away and under color-vision deficiency. This page is the short version.
[`design-spec.md`](./design-spec.md) holds every exact value and the full
behavior of each component; the code (`src/styles/tokens.css`, `src/ui`) wins
if they ever disagree.

## Principles

1. **Quiet when healthy, loud when not.** Healthy things recede (small dot, no
   tint, no word in dense strips). Warning and critical get tinted cells, bigger
   glyphs and words. Attention is a budget.
2. **Status is never color alone.** Every state is a **shape + a word + a
   color**. The mandated palette's green, amber and red are only ΔE 8–9 apart
   under protan/deutan, so shape and word carry the meaning and color reinforces it.
3. **Provenance is data, not decoration.** Everything is mock today and says so.
   A feature the backend has not implemented is drawn with a dashed frame and a
   PLANNED chip, and never feeds the verdict.
4. **A dead dashboard must never look healthy.** Freshness is explicit: STALE
   after 45 s, NO DATA after 120 s. Stale content is tagged STALE (shape + word)
   and only marks and large figures dim: 60 % opacity would take small text below
   AA, so text is never dimmed. A sidebar badge becomes the unknown ring on NO DATA
   instead of keeping an old count.
5. **Nothing moves under the operator.** The triage queue locks its row order
   while it is focused or hovered; new data queues behind an "apply" pill.
6. **Terminal in grammar, not costume.** Prompt breadcrumb, statusline, indexed
   panels `[1]`–`[6]` that double as hotkeys. Every borrowed idea carries
   information; there is no glow, scanline, gradient or decorative motion.

## Palette

The first group is mandated; the rest is derived (tints are 12%, lines 40% of a
hue mixed over the panel color). `src/styles/tokens.test.ts` asserts the WCAG
contrast of every text token on every surface (4.5:1) and of every mark against
the panel (3:1).

| Role           | Token              | Value     |
| -------------- | ------------------ | --------- |
| Background     | `--color-bg`       | `#080B0E` |
| Panels         | `--color-panel`    | `#10161B` |
| Borders        | `--color-border`   | `#253039` |
| Primary (cyan) | `--color-primary`  | `#64D8E8` |
| Healthy        | `--color-healthy`  | `#42D99B` |
| Warning        | `--color-warning`  | `#F5BD4F` |
| Critical       | `--color-critical` | `#F16B73` |
| Text           | `--color-fg`       | `#D5DEE5` |

Derived: `raised`, `hover`, `primary-tint` (selection), `border-strong`,
`border-control` (3:1 outlines), `fg-muted`, `fg-faint`, `fg-disabled`,
`*-tint` / `*-line` per status, `series-2..4` and `series-other` for charts,
`seq-1..4` for sequential magnitude, `chart-grid`.

Rules (the first two are enforced by tests): no color literal outside
`tokens.css`; status color utilities only inside `ui/status`, `ui/meters` and
`charts`; cyan never means OK.

## Status alphabet

| Status   | Glyph           | Word | Used for                                  |
| -------- | --------------- | ---- | ----------------------------------------- |
| healthy  | filled circle   | OK   | up and within thresholds                  |
| warning  | filled triangle | WARN | degraded                                  |
| critical | filled diamond  | CRIT | down or failing                           |
| unknown  | hollow ring     | UNKN | not reported; needs a look                |
| idle     | filled bar      | IDLE | deliberately stopped; not counted         |
| planned  | dotted ring     | PLAN | provenance marker, **not** a health state |

Glyphs are inline SVG (font subsets contain no geometric shapes) and use
`currentColor`, so forced-colors and print keep the shape. Domain words
(`OFFLINE`, `UNHEALTHY`, `RESTARTING`) may replace the class word.

## Typography

Two self-hosted families (no CDN; Latin, Latin-Ext and Greek subsets):

- **JetBrains Mono**: everything an operator scans (names, IPs, numbers, tags,
  nav, buttons, tables, chart text, even the hero figure).
- **IBM Plex Sans**: prose a person wrote (event text, descriptions, titles).

Composite utilities (`type-hero`, `type-verdict`, `type-kpi`, `type-title`,
`type-body`, `type-data`, `type-label`, `type-tag`, `type-kbd`, `type-chart`,
`type-prompt`) bundle family, size, weight and tracking. Minimum rendered size
is 11px. Ligatures are off so `->` and `!=` read literally.

## Geometry

- 4px spacing step, everything in rem so the root size can scale it.
- 1px borders, 2px radius (4px for overlays only), no shadows except on
  overlays, no gradients.
- Density tokens `--row-h`, `--ctl-h`, `--panel-head`, `--pad`, `--gap`,
  `--hit`; coarse pointers always get 44px targets.
- Names before marks: in a row that has both a name and a status strip, the name
  keeps a reserved width and the strip takes what is left, giving up cells and
  then collapsing to a bar plus counts, so a narrow panel never truncates the
  name to make room for decoration.
- Panel = 1px frame + 32px header (`[n]` keycap, title, count, scope, actions,
  source tag) + body + optional footer. Loading, empty, error and stale replace
  the body only; header and frame never move.

## Components

`ui/` (domain-agnostic): `Panel`, `StatusGlyph`, `StatusTag`, controls kit
(`Button`, `IconButton`, `Chip`, `SegmentedControl`, `Select`, `Tooltip`,
`Menu`, `Kbd`), meters (`SegmentedBar`, `CellMeter`, `Sparkline`),
`EntityCells`, provenance chips (`MockChip`, `PlannedChip`, `SourceTag`),
states (`Skeleton`, `EmptyState`, `ErrorState`).
`charts/`: ECharts theme built from the tokens at runtime, `ChartFrame`,
legend, tooltip, table twin, and the shared time-series pieces (axes, crosshair,
growing plot).
`shell/`: app frame, sidebar, top bar, status bar, command palette, shortcut sheet.

Run the dev server and open `/_ds` to see every component in every state, with
a color-vision / grayscale simulator.

## Charts

Apache ECharts, modular, canvas. One theme built from the CSS tokens. No dual
axes (two measures = two grids on one time axis). 2px lines, solid hairline
grid, legend for two or more series, one crosshair and one tooltip listing every
series, a table twin for every chart, refetch keeps the previous render dimmed.
Series colors follow the entity, never its rank: cyan, azure, magenta, indigo,
and slate for context. Green, amber and red are never series colors.

The legend is one row of toggles above the plot. A static reference (the
warning threshold) is drawn on the plot and labelled there, not repeated as a
legend entry. The plot has a minimum height and grows with its panel: a taller
window shows more chart, and the extra room goes to the main grid, never to a
secondary one.

### Chart interactions

Every chart answers the same hands the same way, on every screen. That is
guaranteed by construction, not by care: a chart is drawn by `ChartFrame` and
builds its option from the shared pieces in `charts/timeSeries`. Two tests keep
it so. `features/design-system/chartContract.test.tsx` runs every chart through
the table below, and `architecture.test.ts` forbids anything but `ChartFrame`
from calling the chart runtime, so a chart cannot opt out.

| Interaction | Behavior                                                                                                                                                                                     | Comes from                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Pointer     | One crosshair across every grid; one tooltip listing every visible series at that x, values first, text only                                                                                 | `sharedCrosshair`                    |
| Keyboard    | The plot is a slider. Focus shows the tooltip at the newest sample; Left and Right step, Home and End jump; blur hides it; each sample is spoken in full (`aria-valuetext`)                  | `ChartFrame`                         |
| Legend      | Two or more series: one toggle each. Click shows or hides, Shift-click isolates, hiding the last one shows all. Hidden is struck through as well as `aria-pressed`; color follows the series | `ChartLegend`, `useSeriesVisibility` |
| Table twin  | The Table button, or `v` (the physical key, ignored while typing): every sample as a real table, newest first. Focus is never dropped by the switch                                          | `ChartFrame`, `ChartTable`           |
| Time axis   | One scale across every grid, half a bucket of air at both ends, HH:mm in the active timezone, labels on the bottom grid only                                                                 | `timeAxis`, `timeExtent`             |
| Value axis  | From zero, round 1-2-5 ticks, never truncated. A different unit gets its own grid, never a second axis                                                                                       | `valueAxis`, `niceAxis`              |
| Size        | A minimum plot in rem that grows with its panel                                                                                                                                              | `growingGridHeight`                  |
| Motion      | One 400 ms first draw; none under reduced motion                                                                                                                                             | `useECharts`                         |

Adding a chart, in order:

1. **Model** (pure, next to the screen): series ids and their color slots, bound
   to the metric; the one-sentence summary; the spoken sample; the tooltip rows;
   the table. The tooltip, the cursor and the table read the same samples, so
   they cannot disagree.
2. **Option builder** (pure): grid geometry from a minimum plus
   `growingGridHeight`, then `timeAxis`, `valueAxis`, `...sharedCrosshair` and
   the series. Series ids are stable.
3. **Component** (a `React.lazy` chunk): `ChartFrame` with the legend, the
   visibility hook, the navigation and the table.
4. **Prove it**: add the chart to `CHARTS` in `chartContract.test.tsx`, and a
   specimen to `/_ds` (the gallery already shows a second chart built this way).

## Motion

Only to explain change, and every animation is removed under
`prefers-reduced-motion` (or the Display menu's override). The only things that
loop are the loading skeleton's slow pulse (first load only) and a stepped cursor
while a request is in flight. Everything else plays once: a 1px refresh line
that fills over the poll interval, a flash on a changed value, one fade on a new
critical row, overlays that fade in over 120 ms, a 400 ms first chart draw. No
looping pulses elsewhere, no blinking, no count-up numbers.

## Accessibility

AA contrast asserted by tests; shape + word for status; roving tabindex in
lists, tables and the sidebar; every shortcut has a visible or palette
equivalent; single-key shortcuts can be turned off and are ignored while typing;
shortcuts match physical keys so Greek and Cyrillic layouts work; native
`<dialog>`, `<select>`, `<table>`; skip links; a polite live region that speaks
only verdict changes.

## Extending

1. New color or size: add a token in `tokens.css`, never a literal.
2. New health presentation: compose `StatusGlyph` / `StatusTag` / the meters.
3. New panel: wrap it in `Panel` and pass its backend `features`, so provenance
   markers are derived, not hand-placed.
4. New data: add a method to `SentinelApi` and its mock; never fetch in a component.

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
   color**: six silhouettes (circle, triangle, diamond, hollow square, bar, ring),
   each with a four-letter word. The mandated palette's green, amber and red are
   only ΔE 8–9 apart under protan/deutan, so shape and word carry the meaning and
   color reinforces it.
3. **Provenance is data, not decoration.** What is read from the console API says
   `live`; the built-in sample fleet, in a development run, says `mock`. A feature
   with nothing real to show is drawn with a dashed frame, a chip that says why
   and one sentence, and no figure, chart or sample row: PLANNED (the backend does
   not implement it) or NOT CONNECTED (the backend may have it, the console API
   does not serve it). NEEDS SETUP is kept for a connected feature whose setup is
   confirmed missing. None feeds the verdict.
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
the panel (3:1), and holds `offline` to the same bars as the status hues.

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
`offline` (`#989DD0`, a cool low-chroma hue for an agent that stopped reporting:
7.00:1 on the panel, never a chart series), `*-tint` / `*-line` per status
(healthy, warning, critical and offline), `series-2..4` and `series-other` for
charts, `seq-1..4` for sequential magnitude, `chart-grid`.

`offline` stays a restrained hue, and the test checks it: less than three
quarters of the chroma of any status hue or of primary, more than twice that of a
grey, at least 10 ΔE from critical, warning, healthy and primary, and at least 6
from `fg-muted` and `fg-faint` (4 under tritanopia, where a blue-violet drifts
toward grey), under normal vision, protanopia, deuteranopia and tritanopia.

Rules (the first two are enforced by tests): no color literal outside
`tokens.css`; status color utilities (healthy, warning, critical and offline,
with their tint and line) only inside `ui/status`, `ui/meters` and `charts`;
cyan never means OK.

## Status alphabet

| Status   | Glyph                 | Word | Used for                                                      |
| -------- | --------------------- | ---- | ------------------------------------------------------------- |
| healthy  | circle, check         | OK   | up and within thresholds                                      |
| warning  | triangle, exclamation | WARN | degraded                                                      |
| critical | diamond, cross        | CRIT | down or failing                                               |
| offline  | hollow square, slash  | OFFL | a server whose agent stopped reporting: critical, drawn apart |
| unknown  | ring (question mark)  | UNKN | not reported; needs a look                                    |
| idle     | bar                   | IDLE | deliberately stopped; not counted                             |
| planned  | dotted ring (8 dots)  | PLAN | provenance marker, **not** a health state                     |

From 10px each silhouette carries its cue cut into it (a check, an exclamation
mark, a cross, a slash; the ring gets a question mark from 16px). The 6px mark is
the plain shape: the quiet OK dot of dense strips. The bar and the dotted ring
have no cue. Sizes are 6, 10, 12, 16 and 24px. Glyphs are inline SVG (font
subsets contain no geometric shapes) and use `currentColor`, so forced-colors
and print keep the shape. Domain words (`UNHEALTHY`, `RESTARTING`, `ONLINE`) may
replace the class word and keep the glyph. `OFFLINE` is the domain word of the
offline state, which has its own glyph and tint (class word OFFL); a count or a
legend, which has no room for a domain word, uses the class word.

**Offline is a presentation of critical, never a health status.** `HealthStatus`
has five members; `DisplayStatus` (`lib/status.ts`) adds `'offline'`, and
`displayStatus(status, offline)` is the one mapping to it. The rule that follows:
anything that decides reads `HealthStatus` (the verdict and its figure, attention
counts, ranking, sorting, filters, chips, nav badges, the tab title, the
favicon, the severity edge), so an offline server is critical to all of it;
marks that describe an entity or a composition (tags, bars, count lines, strips,
grid cells, legends, the Servers notice, spoken names) show it apart. Both are on
screen at once by design: the verdict reads "3 critical, 1 offline" while the
CRIT chip, the nav badge and the Servers filter count 4.

`StatusLegend` lists the states as glyph and word pairs in the order of the
alphabet (OK, WARN, CRIT, OFFL, UNKN, IDLE). The Overview closes its health panel
with it: OK, WARN and CRIT always, and the other states only when a mark in the
panel is drawn in them.

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

`ui/` (domain-agnostic): `Panel`, `StatusGlyph`, `StatusTag`, `StatusLegend`,
controls kit (`Button`, `IconButton`, `Chip`, `SegmentedControl`, `Select`,
`Tooltip`, `Menu`, `Kbd`) and the form controls (`Field`, `FieldInput`, `FieldTextArea`, `FieldSelect`,
`Checkbox`, `RadioGroup`), meters (`SegmentedBar`, `CellMeter`, `Sparkline`),
`SearchField`, `EntityCells`, provenance chips (`MockChip`, `PlannedChip`,
`FeatureChip`, `SourceTag`), states (`Skeleton`, `EmptyState`, `ErrorState`, `Notice`).
`charts/`: ECharts theme built from the tokens at runtime, `ChartFrame`,
legend, tooltip, table twin, and the shared time-series pieces (axes, crosshair,
growing plot).
`shell/`: app frame, sidebar, top bar, status bar, command palette, shortcut sheet.

Run the dev server and open `/_ds` to see every component in every state, with
a color-vision / grayscale simulator.

## Meters

Plain SVG and DOM marks in `ui/meters`, with no chart instance.

- **`SegmentedBar`**: composition by state, worst first: critical, offline,
  warning, unknown, idle, ok. A non-zero segment is never narrower than 3px.
  Unknown is a hollow outline, idle a half-height bar and offline two thin bars
  with a 2px break, so a bar never leans on color alone. An offline server is
  inside critical wherever a count decides something; the bar draws it apart,
  directly after the rest of critical. Its accessible name lists every count
  ("Servers: 1 critical, 1 offline, 2 warning, 13 ok"). Segments carry a native
  hover title ("CRIT 1 of 16") unless the bar sits in a row with a `Tooltip`
  (`segmentTitles` off), where the two would open together: the Infrastructure
  health domain rows. Each counted domain row is one tab stop; hovering it (after
  300 ms) or focusing it opens a tooltip with every state's glyph, word, count and
  share of the domain total, the total and, when a server is offline, a sentence
  that offline counts as critical in the verdict. The SNMP row and a row with
  nothing counted have neither tooltip nor tab stop.
- **`CellMeter`**: utilisation as 20 cells of 5%: cyan below 80, amber from 80,
  red from 95 (UI defaults), with a triangle or diamond once a threshold is crossed.
- **`Sparkline`**: a 64 by 24px trend line without axes, on a fixed 0 to 100
  scale so a flat hour reads flat. One entry per bucket, oldest left, null where
  no sample arrived. A missing sample breaks the line (it is never bridged or
  interpolated), a lone sample is a dot, and the newest real sample gets the
  primary end dot. A series that ends on a gap (the host stopped reporting) has no
  end dot: its last sample is a hollow mark and a dashed tail runs under the scale
  to the newest bucket, so the silence is drawn and cannot be read as a value.
  Fewer than two samples draw "no history". It is `role="img"`, named with the
  figures behind the line; given the bucket times, those are the period, the
  latest value, min, max and average, how many samples are missing and, for a
  series that went quiet, "no samples since HH:MM". `inspectable` makes it one tab
  stop whose tooltip carries the same figures, as hover does; it is off inside a
  link or button, which already carries the numbers.

A sparkline is drawn only where the console API serves the history: the server
detail Summary (CPU, RAM and disk beside each meter, from the same per-server
series as the history chart). The Servers list, Fleet load and the Servers and
Containers tiles have none. The
console API serves history per server, not for the fleet or for containers, and a
sparkline per row would cost one series request each, so those show a bar or a
number and nothing is drawn that the data does not contain.

## Charts

Apache ECharts, modular, canvas. One theme built from the CSS tokens. No dual
axes (two measures = two grids on one time axis). 2px lines, solid hairline
grid, legend for two or more series, one crosshair and one tooltip listing every
series, a table twin for every chart, refetch keeps the previous render dimmed.
Series colors follow the entity, never its rank: cyan, azure, magenta, indigo,
and slate for context. Green, amber and red are never series colors.

The legend is one row of toggles above the plot. Limits are drawn on the plot and
labelled on their own line, never repeated as a legend entry: the latency grid
carries "warn 150 ms (UI default)" and the loss grid "warn 2% (UI default)". Each
is a series of its own (`referenceLine()`, id `reference:...`, no data) on the
grid it belongs to, so it stays when the legend hides every data series, and it is
no tooltip row. A label takes whichever corner of its line the data leaves clear,
the start above the line by default. Samples past a limit are marked on the plot
with a warning triangle (a p95 over 150 ms, a loss at or over 2%) and the single
worst p95 spike is labelled with its value and time; the tooltip and the table say
the same in words ("62 ms over warn"), so the state never rests on color or on a
mark. An axis is raised where a label or mark needs the room: the loss grid runs
0 to 4% when loss is low, so its limit label fits above its line. The server
resource history marks its 80% limit on each of its series instead, so there the
line goes with the series. The plot has a minimum height and grows with its panel:
a taller window shows more chart, and the extra room goes to the main grid, never
to a secondary one.

### Chart interactions

Every chart answers the same hands the same way, on every screen. That is
guaranteed by construction, not by care: a chart is drawn by `ChartFrame` and
builds its option from the shared pieces in `charts/timeSeries`. Two tests keep
it so. `features/design-system/chartContract.test.tsx` runs every chart through
the table below (each chart declares its toggleable series and its static
references), and `architecture.test.ts` forbids anything but `ChartFrame` from
calling the chart runtime, so a chart cannot opt out.

| Interaction | Behavior                                                                                                                                                                                          | Comes from                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Pointer     | One crosshair across every grid; one tooltip listing every visible series at that x, values first, text only. A value past its limit is flagged in words on a line of its own under its row       | `sharedCrosshair`, `buildTooltipElement` |
| Keyboard    | The plot is a slider. Focus shows the tooltip at the newest sample; Left and Right step, Home and End jump; blur hides it; each sample is spoken in full (`aria-valuetext`)                       | `ChartFrame`                             |
| Legend      | Two or more series: one toggle each. Click shows or hides, Shift-click isolates, hiding the last one shows all. Hidden is struck through as well as `aria-pressed`; color follows the series      | `ChartLegend`, `useSeriesVisibility`     |
| Reference   | A limit drawn with `referenceLine` is a series of its own on its grid, labelled on its line: no legend entry, no tooltip row, and it stays whatever the legend hides                              | `referenceLine`, `isReferenceSeries`     |
| Table twin  | The Table button, or `v` (the physical key, ignored while typing): every sample as a real table, newest first, with a Flags column where a chart has limits. Focus is never dropped by the switch | `ChartFrame`, `ChartTable`               |
| Time axis   | One scale across every grid, half a bucket of air at both ends, HH:mm in the active timezone, labels on the bottom grid only                                                                      | `timeAxis`, `timeExtent`                 |
| Value axis  | From zero, round 1-2-5 ticks, never truncated. A different unit gets its own grid, never a second axis                                                                                            | `valueAxis`, `niceAxis`                  |
| Size        | A minimum plot in rem that grows with its panel                                                                                                                                                   | `growingGridHeight`                      |
| Motion      | One 400 ms first draw; none under reduced motion                                                                                                                                                  | `useECharts`                             |

Adding a chart, in order:

1. **Model** (pure, next to the screen): series ids and their color slots, bound
   to the metric; the one-sentence summary; the spoken sample; the tooltip rows;
   the table; and the judgement of each limit (which samples are past it, the
   flags in words, the marks). The tooltip, the cursor, the table, the summary and
   the marks read the same samples and the same judgement, so they cannot disagree.
2. **Option builder** (pure): grid geometry from a minimum plus
   `growingGridHeight`, then `timeAxis`, `valueAxis`, `...sharedCrosshair`, the
   series and one `referenceLine` per limit. Series ids are stable.
3. **Component** (a `React.lazy` chunk): `ChartFrame` with the legend, the
   visibility hook, the navigation and the table.
4. **Prove it**: add the chart to `CHARTS` in `chartContract.test.tsx` (its
   series and its references), and a specimen to `/_ds` (the gallery already shows
   a second chart built this way).

## Incident timeline

The incident timeline and the event log are components for an event log the backend does
not have. The Overview's Recent events panel [6] therefore mounts neither: it is a PLANNED
panel with no rows (dashed frame, PLANNED chip, one sentence). The components are kept,
and shown in the gallery as labelled sample content, for the day an events API exists.
Together they would give two views of one request, switched by Log | Timeline tabs: the
log, a terminal tail of the events, and the timeline, the incidents among the same
events, one lane each on a shared time axis. The timeline is a second view of the
events, not a second source: it knows nothing the log does not show.

- **What an incident is.** Derived in the console from `SentinelEvent[]`
  (`features/overview/events/incidentModel.ts`): a warning or critical event that
  nests under nothing opens one, the first healthy event of the same subject nested
  under it at any depth closes it, and info events never do. Nothing in an event says an
  operator acknowledged it, so no lane claims it. A
  recovery whose failure is not among the events is an incident with no start,
  severity or duration to give, and says so: it began before the range, or, when
  the answer filled the panel's limit of newest events, its opening is not among
  the events shown. A range cut short that way says so on the summary line, in the
  empty line and in the log's description. Info events alone make no incident ("No
  incidents in the last 1h"). Lanes read ongoing first (critical before warning),
  then resolved, the most recent start first.
- **Lanes.** A summary line ("2 ongoing · 5 resolved") and a time axis sit above
  the lanes, which are 24px, the log's line height, and scroll beneath them. The
  axis is the topbar range ending when the events were read, labelled at its two
  ends only. A lane is the subject, the incident on the axis and a word with a
  duration. The name column is 4rem in a panel narrower than 24rem, 7.5rem up to
  32rem and 10rem from there. When the axis runs across midnight (a 24h axis
  always does) both ends, every lane's times and the tooltip lead with the
  weekday, so the two ends are never the same label.
- **Marks.** Shape and word, never color alone. A diamond or triangle marks how
  the incident began. An ongoing incident is a solid bar in the severity color to
  the right edge, left open (a chevron), and says ONGOING with how long so far. A
  resolved one is a thin line on the severity tint that ends in the OK mark and
  says RESOLVED with how long it lasted. A chevron cuts a bar that began before the
  axis. Nothing animates.
- **Keyboard and names.** The lanes are one tab stop (Up, Down, Home and End move
  between them) in a list named "Incident timeline", described by its window and
  timezone ("Last hour, 13:05 to 14:05. Times are UTC."). Each lane is named by one
  sentence ("pir-vpn: critical incident, started 13:43, ongoing for 22 minutes"). Hovering or focusing a lane opens a tooltip
  with its severity, times, duration and both messages. The tooltip is
  supplementary: the log, whose description names it the text equivalent of the
  timeline, carries every message.
- **Holding still.** Like the log, the timeline freezes while it is read: hovering
  it or focusing a lane keeps the lanes, and the moment they are measured against,
  as they are, and what arrives meanwhile waits behind an "N new" pill. A different
  range or scope shows at once.

At the reference 1440 by 900 layout the panel body is 120px and the summary and
axis take 32 of it, so three whole lanes show and the rest scroll.

## Lists and tables

The Servers screen sets the pattern every inventory screen follows.

- **A table, not a grid of cards**, with 28px rows, a 2px severity edge at the
  left, status first (shape + word), the name as a real link, and the whole row as
  a bigger pointer target. Worst first by default. An offline server's tag is the
  offline one (OFFL, its own glyph and tint), while its edge, the status filter
  and the sort keep it critical.
- **Sortable headers** are buttons inside the `th`, with `aria-sort`. Rows that
  cannot supply a value (offline, never reported) sort last in either direction.
- **Search and status chips** sit above the panel; all of it, with the sort, lives
  in the URL. Chips count what each would show for the current search.
- **Columns yield to room** (container queries), not to the window: the site and
  uptime go before a number does. On a phone the same list is cards, with a sort menu.
- **No reading is said, not blanked.** A host that is offline or never reported
  shows one sentence in place of three empty meters.
- **Detail pages** are panels too: a summary, a chart through `ChartFrame`, a
  table. The summary's CPU, RAM and disk meters each carry a sparkline of their
  history; the page requests that series once, over the range in the top bar, and
  feeds the sparklines and the history chart alike. An offline host gets a notice
  first (the OFFLINE tag on the offline tint); its last reading stays visible and
  is labelled as the last reading, and a sparkline whose samples stop ends in the
  dashed tail that says nothing arrived since.

## Forms and notices

Settings sets the pattern for a form.

- **Every control has a real `<label>`**, tied by id; its hint and its errors are named by
  `aria-describedby`, and an invalid control carries `aria-invalid`. A group of choices (the severity, the
  scope) is a `fieldset` with a `legend`, not a loose row of radios.
- **An error is a mark and words, never color alone**, and sits under the field it is about. The server's own
  words are shown as they came, by field; a problem of the whole (or of a field the form does not draw) is
  listed on top, so none is lost. The check made before sending says the same things the server will.
- **A read-only value is a read-only input** (the account's address), focusable and copyable, not text that
  looks like a field.
- **A `Notice` is an inline message, never a toast**: a mark and a word (`SAVED`, `NOT SAVED`,
  `CHANGED ELSEWHERE`, `ENDS INCIDENTS`), the sentence, and what to do about it. `live="alert"` for what went
  wrong now, `live="status"` for what happened; none for what is simply so. It stays until the situation
  changes or it is dismissed.
- **A change that cannot be undone is confirmed first**: the warning says which object and what ends, the safe
  button takes the focus, Escape cancels, and nothing is applied until the other is chosen.
- **A save never overwrites.** A refusal leaves the form as it was; a conflict locks it, says what changed and
  offers the latest version.

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
only verdict changes. Tooltips are supplementary: what one says also exists where
touch and keyboard users reach it (an accessible name, a table twin, the log), and
the rows, lanes and sparklines that open one on hover take a tab stop so the
keyboard opens it too.

## Extending

1. New color or size: add a token in `tokens.css`, never a literal.
2. New health presentation: compose `StatusGlyph` / `StatusTag` / `StatusLegend` /
   the meters, and take colors only from the `STATUS_*` maps in `ui/status`. A
   state that describes without deciding, as offline does for critical, is a
   `DisplayStatus` layered on a `HealthStatus` through `displayStatus`: whatever
   ranks, counts into a verdict, filters or badges reads the `HealthStatus`, and
   only the marks that describe an entity or a composition show the layer.
3. New panel: wrap it in `Panel` and pass its backend `features`, so provenance
   markers are derived, not hand-placed.
4. New data: add a method to `SentinelApi` and answer it in `createConsoleApi` (the sample
   fleet too, for development); never fetch in a component. Data the console API does not
   serve gets no method and no figure.

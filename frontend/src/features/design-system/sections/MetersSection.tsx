import { useState } from 'react'
import type { SiteEntity, StatusCounts } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { DomainTip } from '@/features/overview/health/DomainTip'
import { Tooltip } from '@/ui/controls'
import { EntityCells, describeEntities } from '@/ui/entity-cells'
import { CellMeter, SegmentedBar, Sparkline } from '@/ui/meters'
import { GRID_ENTITIES, SPARK_SPECIMENS, counts, stripEntities } from '../sample/data'
import { Specimen } from '../Specimen'

const ROW = 'grid items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)]'
const ROW_LABEL = 'type-data text-fg-muted'

interface BarSample {
  label: string
  height: 6 | 8
  counts: StatusCounts
}

const BARS: readonly BarSample[] = [
  {
    label: 'Fleet, 8px',
    height: 8,
    counts: counts({ critical: 4, warning: 5, idle: 3, healthy: 112 }),
  },
  { label: 'Servers, 6px', height: 6, counts: counts({ critical: 1, warning: 2, healthy: 13 }) },
  {
    label: 'One server offline',
    height: 8,
    counts: counts({ critical: 4, offline: 1, warning: 5, idle: 3, healthy: 112 }),
  },
  {
    label: 'Only offline',
    height: 6,
    counts: counts({ critical: 2, offline: 2, healthy: 14 }),
  },
  { label: 'All healthy', height: 6, counts: counts({ healthy: 40 }) },
  { label: '1 of 124 critical', height: 8, counts: counts({ critical: 1, healthy: 123 }) },
  { label: 'Unknown and idle', height: 8, counts: counts({ unknown: 3, idle: 5, healthy: 8 }) },
  { label: 'Zero total', height: 6, counts: counts() },
]

const DETAILED = counts({ critical: 4, offline: 1, warning: 5, idle: 3, healthy: 112 })

/** A row that lists every state of its bar on hover and keyboard focus, as the Infrastructure health rows do. */
function DetailedBar() {
  return (
    <Tooltip content={<DomainTip name="Servers" counts={DETAILED} />}>
      <li
        // A row is read, not operated: the tab stop is what gives keyboard users the tooltip.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className={ROW}
      >
        <span className={ROW_LABEL}>With details</span>
        <SegmentedBar
          counts={DETAILED}
          height={8}
          label="Servers with details"
          segmentTitles={false}
          className="w-full"
        />
      </li>
    </Tooltip>
  )
}

function Bars() {
  return (
    <Specimen
      label="Segmented bar"
      note="Worst first: critical, offline, warning, unknown, idle, ok. Every non-zero segment keeps at least 3px, so one failure never vanishes in a large fleet. Unknown is hollow, idle a thin bar and offline two thin bars with a break between them, so the bar never leans on color. Offline servers are inside critical wherever a count decides something; a bar draws them apart. Segments carry a hover title unless the row has a Tooltip, which lists every state with its count and share of the total."
    >
      <ul className="flex flex-col gap-3">
        {BARS.map((bar) => (
          <li key={bar.label} className={ROW}>
            <span className={ROW_LABEL}>{bar.label}</span>
            <SegmentedBar
              counts={bar.counts}
              height={bar.height}
              label={bar.label}
              className="w-full"
            />
          </li>
        ))}
        <DetailedBar />
        <li className={ROW}>
          <span className={ROW_LABEL}>Planned</span>
          <SegmentedBar
            counts={counts()}
            height={6}
            label="Devices"
            planned
            plannedText="no SNMP data"
          />
        </li>
      </ul>
    </Specimen>
  )
}

/** Sampled across both thresholds: the cells change hue at 80 and 95, and a glyph joins them. */
const LEVELS: readonly (number | null)[] = [0, 45, 80, 94, 95, 100, null]

function Cells() {
  return (
    <Specimen
      label="Cell meter"
      note="20 cells of 5%. Cyan below 80, amber from 80, red from 95 (UI defaults). A triangle or diamond follows the cells once a threshold is crossed, and the value is printed."
    >
      <ul className="flex flex-col gap-2">
        {LEVELS.map((percent, index) => (
          <li key={percent ?? 'none'} className={ROW}>
            <span className={ROW_LABEL}>{percent === null ? 'No sample' : `${percent}%`}</span>
            <CellMeter percent={percent} label={`CPU of api-0${index + 1}`} />
          </li>
        ))}
      </ul>
    </Specimen>
  )
}

const TREND = [99, 99, 98, 99, 100, 99, 97, 98, 99, 100, 99, 99]
const DIP = [100, 100, 99, 97, 92, 85, 88, 94, 97, 99, 100, 100]
const FLAT = Array.from({ length: 12 }, () => 100)

function Sparklines() {
  const { tz } = usePrefs()
  return (
    <Specimen
      label="Sparkline"
      note="64 by 24px on a fixed 0 to 100 scale, so a flat hour reads flat. A missing sample breaks the line and a lone sample is a dot. A series that ends on a gap has no end dot: its last sample is hollow and a dashed tail runs under the scale to the newest bucket. Given its bucket times, a sparkline is one tab stop that opens the figures behind it. Only where the backend stores history; with none it says so instead of drawing one."
    >
      <ul className="flex flex-col gap-3">
        <li className={ROW}>
          <span className={ROW_LABEL}>Normal</span>
          <Sparkline values={TREND} label="Success rate, last hour" />
        </li>
        <li className={ROW}>
          <span className={ROW_LABEL}>With a dip</span>
          <Sparkline values={DIP} label="Success rate with a dip, last hour" />
        </li>
        <li className={ROW}>
          <span className={ROW_LABEL}>Flat</span>
          <Sparkline values={FLAT} label="Success rate, flat" />
        </li>
        <li className={ROW}>
          <span className={ROW_LABEL}>No history</span>
          <Sparkline values={[]} label="Success rate, no history" />
        </li>
        {SPARK_SPECIMENS.map(({ name, label, values, times }) => (
          <li key={name} className={ROW}>
            <span className={ROW_LABEL}>{name}</span>
            <Sparkline values={values} times={times} tz={tz} label={label} inspectable />
          </li>
        ))}
      </ul>
    </Specimen>
  )
}

const STRIPS = [
  { name: 'Few', entities: stripEntities(6) },
  { name: 'One server offline', entities: stripEntities(6, { 1: 'offline' }) },
  { name: 'At capacity (20)', entities: stripEntities(20) },
  { name: 'Over capacity (24)', entities: stripEntities(24, { 1: 'offline' }) },
] as const

function Strips() {
  return (
    <Specimen
      label="Entity strip"
      note="One glyph per entity, worst first, on a 12px pitch; an offline server wears its own glyph after the critical ones. Decorative inside an interactive row: the row's name lists every entity that is not OK. Past 20 entities it becomes a bar and counts."
    >
      <ul className="flex flex-col gap-1">
        {STRIPS.map(({ name, entities }) => (
          <li key={name}>
            <button
              type="button"
              aria-label={describeEntities(name, entities)}
              className="flex h-(--row-h) w-full items-center gap-3 rounded-sm px-2 text-left transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2"
            >
              <span className="type-body w-40 shrink-0 truncate">{name}</span>
              <EntityCells
                variant="strip"
                entities={entities}
                label={name}
                className="min-w-0 flex-1"
              />
            </button>
          </li>
        ))}
      </ul>
    </Specimen>
  )
}

function Grid() {
  const [selected, setSelected] = useState<SiteEntity | null>(null)
  return (
    <Specimen
      label="Entity grid"
      note="For screens with room: 20px cells on a 24px pitch, grouped by kind, worst first. One tab stop; arrows move, Home and End jump to the row ends, Page Up and Page Down move between groups."
    >
      <EntityCells
        variant="grid"
        label="Athens-DC entities"
        columns={10}
        entities={GRID_ENTITIES}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
      />
      <p className="type-data mt-3 text-fg-faint">
        {selected ? `Selected: ${selected.name}` : 'Nothing selected'}
      </p>
    </Specimen>
  )
}

export function MetersSection() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Bars />
      <Cells />
      <Sparklines />
      <Strips />
      <Grid />
    </div>
  )
}

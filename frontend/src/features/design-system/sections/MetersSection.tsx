import { useState } from 'react'
import type { SiteEntity, StatusCounts } from '@/api/types'
import { EntityCells, describeEntities } from '@/ui/entity-cells'
import { CellMeter, SegmentedBar, Sparkline } from '@/ui/meters'
import { GRID_ENTITIES, counts, stripEntities } from '../sample/data'
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
  { label: 'All healthy', height: 6, counts: counts({ healthy: 40 }) },
  { label: '1 of 124 critical', height: 8, counts: counts({ critical: 1, healthy: 123 }) },
  { label: 'Unknown and idle', height: 8, counts: counts({ unknown: 3, idle: 5, healthy: 8 }) },
  { label: 'Zero total', height: 6, counts: counts() },
]

function Bars() {
  return (
    <Specimen
      label="Segmented bar"
      note="Worst first: critical, warning, unknown, idle, ok. Every non-zero segment keeps at least 3px, so one failure never vanishes in a large fleet. Unknown is hollow and idle a thin bar, so the bar never leans on color."
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
  return (
    <Specimen
      label="Sparkline"
      note="64 by 24px on a fixed 0 to 100 scale, so a flat hour reads flat. Only where the backend stores history; with none it says so instead of drawing one."
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
      </ul>
    </Specimen>
  )
}

const STRIPS = [
  { name: 'Few', entities: stripEntities(6) },
  { name: 'At capacity (20)', entities: stripEntities(20) },
  { name: 'Over capacity (24)', entities: stripEntities(24) },
] as const

function Strips() {
  return (
    <Specimen
      label="Entity strip"
      note="One glyph per entity, worst first, on a 12px pitch. Decorative inside an interactive row: the row's name lists every entity that is not OK. Past 20 entities it becomes a bar and counts."
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

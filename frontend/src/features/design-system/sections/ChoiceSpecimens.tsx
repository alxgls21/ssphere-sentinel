import { useState } from 'react'
import { Chip, SegmentedControl, Select } from '@/ui/controls'
import type { ChipProps, SegmentedOption, SelectOption } from '@/ui/controls'
import { StatusGlyph } from '@/ui/status'
import { Specimen } from '../Specimen'

type Metric = 'cpu' | 'ram' | 'disk'
const METRICS: readonly SegmentedOption<Metric>[] = [
  { value: 'cpu', label: 'CPU', title: 'Processor load' },
  { value: 'ram', label: 'RAM' },
  { value: 'disk', label: 'DISK' },
]

type View = 'chart' | 'table'
const VIEWS: readonly SegmentedOption<View>[] = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
]

type Range = '15m' | '1h' | '6h' | '24h'
const RANGES: readonly SelectOption<Range>[] = [
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '6h', label: 'Last 6 hours' },
  { value: '24h', label: 'Last 24 hours' },
]

/** A chip that toggles itself, since a gallery has no filter for it to drive. */
function ToggleChip({
  initial,
  ...props
}: Omit<ChipProps, 'pressed' | 'onPressedChange'> & { initial: boolean }) {
  const [pressed, setPressed] = useState(initial)
  return <Chip pressed={pressed} onPressedChange={setPressed} {...props} />
}

function Chips() {
  return (
    <Specimen
      label="Chip"
      note="A toggle: aria-pressed, a tinted fill and primary text when on. The count is part of the name."
    >
      <div className="flex flex-wrap items-center gap-3">
        <ToggleChip initial={false}>Unpressed</ToggleChip>
        <ToggleChip initial>Pressed</ToggleChip>
        <ToggleChip initial={false} count={4} leading={<StatusGlyph status="critical" size={10} />}>
          CRIT
        </ToggleChip>
        <ToggleChip initial count={5} leading={<StatusGlyph status="warning" size={10} />}>
          WARN
        </ToggleChip>
        <ToggleChip initial={false} disabled>
          Disabled
        </ToggleChip>
      </div>
    </Specimen>
  )
}

function Segmented() {
  const [metric, setMetric] = useState<Metric>('cpu')
  const [view, setView] = useState<View>('chart')
  const [small, setSmall] = useState<Metric>('ram')
  return (
    <Specimen
      label="Segmented control"
      note="One tab stop, arrows move and select, Home and End jump. Radio changes a setting; tabs switch content; sm is for panel headers."
    >
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          aria-label="Load metric"
          value={metric}
          onChange={setMetric}
          options={METRICS}
        />
        <SegmentedControl
          aria-label="Chart view"
          variant="tabs"
          value={view}
          onChange={setView}
          options={VIEWS}
        />
        <SegmentedControl
          aria-label="Load metric, small"
          size="sm"
          value={small}
          onChange={setSmall}
          options={METRICS}
        />
      </div>
    </Specimen>
  )
}

function Selects() {
  const [range, setRange] = useState<Range>('1h')
  const [hidden, setHidden] = useState<Range>('6h')
  return (
    <Specimen
      label="Select"
      note="A styled native select: the platform supplies the keyboard, the picker and the popup."
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Select label="Range" value={range} onChange={setRange} options={RANGES} />
        <Select
          label="Range, label hidden"
          hideLabel
          value={hidden}
          onChange={setHidden}
          options={RANGES}
        />
        <Select label="Range, disabled" disabled value="24h" onChange={setRange} options={RANGES} />
      </div>
    </Specimen>
  )
}

export function ChoiceSpecimens() {
  return (
    <>
      <Chips />
      <Segmented />
      <Selects />
    </>
  )
}

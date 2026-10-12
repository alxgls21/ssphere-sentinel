import { useRange } from '@/app/viewState'
import { RANGE_OPTIONS } from '@/lib/range'
import { SegmentedControl } from '@/ui/controls'

const OPTIONS = RANGE_OPTIONS.map((value) => ({
  value,
  label: value,
  title: 'Scopes range panels only. Press t for the next range.',
}))

/** 15m 1h 6h 24h. It scopes the range panels (charts), not the state panels, and says so. */
export function TimeRange() {
  const [range, setRange] = useRange()
  return (
    <SegmentedControl aria-label="Time range" value={range} onChange={setRange} options={OPTIONS} />
  )
}

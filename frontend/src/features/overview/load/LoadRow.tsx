/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A load row is read, not operated. It takes a tab stop anyway so a keyboard user can open the
   tooltip (which sample this is) that a pointer gets on hover. There are at most eight. */
import type { FleetLoadRow, LoadMetric } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { CellMeter } from '@/ui/meters'
import { Tooltip } from '@/ui/controls'
import { metricNoun, rowTooltip } from './loadModel'

/** One server: name, then a 20-cell meter with its threshold glyph and value. */
export function LoadRow({ row, metric }: { row: FleetLoadRow; metric: LoadMetric }) {
  const { tz } = usePrefs()
  const noun = metricNoun(metric)
  return (
    <Tooltip content={rowTooltip(row, noun, tz)}>
      <li
        tabIndex={0}
        className="flex h-(--row-h) items-center gap-3 px-3 transition-colors duration-(--dur-fast) hover:bg-hover focus-visible:-outline-offset-2"
      >
        <span className="type-data-strong w-28 shrink-0 truncate">{row.name}</span>
        <CellMeter
          percent={row.percent}
          label={`${noun} of ${row.name}`}
          className="min-w-0 flex-1"
        />
      </li>
    </Tooltip>
  )
}

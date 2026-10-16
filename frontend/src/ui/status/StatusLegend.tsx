import { cn } from '@/lib/cn'
import type { DisplayStatus } from '@/lib/status'
import { StatusTag } from './StatusTag'

/** Every state a mark can show, in the order of the alphabet (offline directly after critical). */
const LEGEND: readonly DisplayStatus[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
]

interface StatusLegendProps {
  /** The states to explain, in order. Defaults to all of them. */
  statuses?: readonly DisplayStatus[]
  className?: string
}

/** The status alphabet as a row of glyph + word pairs: what each mark on the screen means. */
export function StatusLegend({ statuses = LEGEND, className }: StatusLegendProps) {
  return (
    <ul aria-label="Status legend" className={cn('flex flex-wrap items-center gap-x-3', className)}>
      {statuses.map((status) => (
        <li key={status}>
          <StatusTag status={status} />
        </li>
      ))}
    </ul>
  )
}

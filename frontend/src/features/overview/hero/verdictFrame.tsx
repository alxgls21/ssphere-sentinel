import type { HealthStatus } from '@/api/types'
import { cn } from '@/lib/cn'
import { STATUS_EDGE, STATUS_TINT } from '@/ui/status'

/** The frame shared by the hero and the compact bar; add STATUS_FRAME[status] for its color. */
export const VERDICT_FRAME = 'relative overflow-hidden rounded-sm border bg-panel'

/**
 * The 12% status tint and the 4px left edge. Separate layers over the panel
 * fill, so a status with no tint (unknown, no data) simply shows the panel.
 */
export function VerdictDecor({ status }: { status: HealthStatus }) {
  return (
    <>
      <span aria-hidden="true" className={cn('absolute inset-0', STATUS_TINT[status])} />
      <span
        aria-hidden="true"
        className={cn('absolute inset-y-0 left-0 w-1', STATUS_EDGE[status])}
      />
    </>
  )
}

import type { ReactNode } from 'react'
import type { StatusCounts } from '@/api/types'
import { describeCounts, nonZeroCounts } from '@/lib/blocks'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import type { DisplayStatus } from '@/lib/status'
import { STATUS_WORD } from '@/ui/status'

/**
 * Class names are written out in full so Tailwind's scanner sees them. Unknown
 * is a hollow outline, idle a half-height flat bar and offline two thin bars
 * with a 2px break between them (the shapes of the UNKN ring, the IDLE bar and
 * the OFFL slash), so the bar never leans on color alone.
 */
const SEGMENT: Record<DisplayStatus, string> = {
  critical: 'bg-critical',
  offline: 'flex flex-col gap-0.5 overflow-hidden',
  warning: 'bg-warning',
  unknown: 'border border-fg-faint',
  idle: 'h-1/2 self-center bg-fg-muted',
  healthy: 'bg-healthy',
}

const HEIGHT = { 6: 'h-1.5', 8: 'h-2' } as const

interface SegmentedBarProps {
  counts: StatusCounts
  /** Bar thickness in px: 6 in tiles, 8 in the verdict and health rows. */
  height: 6 | 8
  /** Accessible-name prefix: "Servers" reads "Servers: 1 critical, 2 warning, 13 ok". */
  label: string
  /** The feature behind this bar is not implemented: a dashed outline carrying `plannedText`. */
  planned?: boolean
  plannedText?: string
  /**
   * A hover title on each segment ("CRIT 1 of 16"). Off where a Tooltip already
   * describes the bar, or the two would open together.
   */
  segmentTitles?: boolean
  className?: string
}

/** The two halves of an offline segment. */
const OFFLINE_HALF = 'min-h-0 flex-1 bg-offline'

/**
 * Composition by state, worst first: critical, offline, warning, unknown, idle,
 * healthy. Offline servers are part of critical everywhere that decides
 * something; here they are drawn apart, directly after the rest of it.
 * Widths are flex-grow shares of the counts, so the browser resolves the
 * "every non-zero segment at least 3px" floor by shrinking the others in
 * proportion. The 2px gaps are real gaps (the surface shows through), and only
 * the outer ends are rounded. All spans, so it can sit inside a button or link.
 */
export function SegmentedBar({
  counts,
  height,
  label,
  planned = false,
  plannedText = 'no data',
  segmentTitles = true,
  className,
}: SegmentedBarProps) {
  const present = nonZeroCounts(counts)
  const total = present.reduce((sum, { count }) => sum + count, 0)

  let name: string
  let shape: string
  let content: ReactNode = null
  if (planned) {
    name = `${label}: ${plannedText}`
    shape =
      'type-data flex h-5 items-center rounded-sm border border-dashed border-border-strong px-1.5 text-fg-muted'
    content = plannedText
  } else if (total === 0) {
    name = `${label}: none`
    shape = cn('block rounded-sm border border-border', HEIGHT[height])
  } else {
    name = `${label}: ${describeCounts(counts)}`
    shape = cn('flex min-w-0 items-stretch gap-0.5', HEIGHT[height])
    content = present.map(({ status, count }) => (
      <span
        key={status}
        data-status={status}
        title={
          segmentTitles
            ? `${STATUS_WORD[status]} ${formatInteger(count)} of ${formatInteger(total)}`
            : undefined
        }
        style={{ flexGrow: count }}
        className={cn('min-w-0.75 basis-0 first:rounded-l-sm last:rounded-r-sm', SEGMENT[status])}
      >
        {status === 'offline' ? (
          <>
            <span className={OFFLINE_HALF} />
            <span className={OFFLINE_HALF} />
          </>
        ) : null}
      </span>
    ))
  }

  return (
    // A composition mark has no element of its own: role=img plus a label that lists every count.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <span role="img" aria-label={name} className={cn(shape, className)}>
      {content}
    </span>
  )
}

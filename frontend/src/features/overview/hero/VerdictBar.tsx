import { useId } from 'react'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { useProvenance } from '@/hooks/useProvenance'
import { cn } from '@/lib/cn'
import { Skeleton } from '@/ui/states'
import { STATUS_FRAME, STATUS_TEXT, StatusGlyph, StatusTag } from '@/ui/status'
import { focusAttentionPanel } from './focusAttention'
import { useFleetStatus } from './fleetStatus'
import { VERDICT_FRAME, VerdictDecor } from './verdictFrame'
import { VERDICT_FEATURES, describeVerdict } from './verdictText'

const SURFACE =
  'flex h-10 w-full min-w-0 items-center gap-2 pr-3 pl-4 text-left pointer-coarse:h-11'

interface VerdictBarProps {
  /** Where it sticks and when it shows (the page decides: sticky under the app bar, hidden from md up). */
  className?: string
}

/**
 * The verdict at phone width: glyph, word and "9 need attention" on one
 * 40px line. Tapping it scrolls to the Needs attention queue and focuses it.
 * It only reads the shared verdict; verdict changes are announced once, by the
 * shell.
 */
export function VerdictBar({ className }: VerdictBarProps) {
  const { verdict, freshness, stale, summary } = useFleetStatus()
  const { source } = useProvenance(VERDICT_FEATURES)
  const descriptionId = useId()
  const loading = summary.status === 'loading'
  const showSkeleton = useDelayedFlag(loading)

  if (loading) {
    return (
      <div aria-busy="true" className={cn(VERDICT_FRAME, SURFACE, 'border-border', className)}>
        <span className="sr-only">Loading fleet status</span>
        {showSkeleton ? <Skeleton className="h-5 w-48" /> : null}
      </div>
    )
  }

  const text = describeVerdict(verdict, { hasData: summary.data !== undefined, freshness })
  const name = `Fleet status: ${text.summary}${source === 'mock' ? ', mock data' : ''}`

  return (
    <button
      type="button"
      onClick={focusAttentionPanel}
      aria-label={name}
      aria-describedby={descriptionId}
      data-verdict={verdict.state}
      className={cn(
        VERDICT_FRAME,
        SURFACE,
        STATUS_FRAME[verdict.status],
        'focus-visible:-outline-offset-2',
        className,
      )}
    >
      <VerdictDecor status={verdict.status} />
      <span className={cn('relative flex min-w-0 items-center gap-2')}>
        <StatusGlyph status={verdict.status} size={16} />
        <span
          className={cn(
            'type-data-strong whitespace-nowrap uppercase',
            STATUS_TEXT[verdict.status],
          )}
        >
          {verdict.word}
        </span>
        <span className="type-data truncate text-fg-muted">{text.short}</span>
        {stale && verdict.state !== 'nodata' ? <StatusTag status="warning" word="STALE" /> : null}
      </span>
      <span id={descriptionId} className="sr-only">
        {text.scope} Opens Needs attention.
      </span>
    </button>
  )
}

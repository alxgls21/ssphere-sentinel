import { useId } from 'react'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { PROVENANCE_SPOKEN } from '@/config/features'
import { useProvenance } from '@/hooks/useProvenance'
import { cn } from '@/lib/cn'
import { emptyCounts } from '@/lib/status'
import { Tooltip } from '@/ui/controls'
import { SegmentedBar } from '@/ui/meters'
import { Skeleton } from '@/ui/states'
import { STATUS_FRAME, STATUS_TEXT, StatusGlyph, StatusTag } from '@/ui/status'
import { CountList } from './CountList'
import { focusAttentionPanel } from './focusAttention'
import { useFleetStatus } from './fleetStatus'
import { listedCounts } from './tileText'
import { VERDICT_FRAME, VerdictDecor } from './verdictFrame'
import { VERDICT_FEATURES, describeVerdict } from './verdictText'

const COUNTED_STATUSES = ['critical', 'warning', 'unknown', 'healthy'] as const

/**
 * Five marks with their words (an offline server is a fifth) need 311px, more than the
 * 291px block holds, and more than the row from 768px leaves beside its bar at the 96px
 * minimum: where the button's content is narrower than that, the shapes and numbers stay
 * and its name carries the words.
 */
const CROWDED_WORDS = 'max-xl:@max-[43rem]/hero:hidden xl:@max-[20rem]/hero:hidden'
const WORDED_MARKS = 4

/** Left padding clears the 4px status edge. */
const SURFACE = '@container/hero flex h-full w-full min-w-0 py-3 pr-3 pl-4 text-left'

/**
 * A 291x120 block from xl up; below it the strip is full width and the same
 * parts sit on one 88px line (figure and word, fleet bar, counts).
 */
const CONTENT =
  'relative flex min-w-0 flex-1 flex-col justify-center gap-2 transition-opacity duration-(--dur-base) max-xl:flex-row max-xl:items-center max-xl:gap-6'

const BAR_WIDTH = 'w-full max-xl:min-w-24 max-xl:flex-1'

interface VerdictHeroProps {
  className?: string
}

/**
 * Tier 0: one word for the whole fleet, readable from across a room. The
 * figure is entities needing attention in plain text color (the shape and the
 * word carry severity); under it, the fleet bar and glyph-coded counts.
 *
 * One button: Enter focuses the Needs attention panel. It always shows the
 * newest snapshot, and a verdict that has gone stale or has no data dims
 * instead of looking healthy. It does not announce: verdict changes are spoken
 * once, for every screen, by the shell (see shell/useDocumentStatus).
 */
export function VerdictHero({ className }: VerdictHeroProps) {
  const fleet = useFleetStatus()
  const { provenance } = useProvenance(VERDICT_FEATURES)
  const descriptionId = useId()
  const loading = fleet.summary.status === 'loading'
  const showSkeleton = useDelayedFlag(loading)

  if (loading) {
    return (
      <div aria-busy="true" className={cn(VERDICT_FRAME, SURFACE, 'border-border', className)}>
        <span className="sr-only">Loading fleet status</span>
        {showSkeleton ? <HeroSkeleton /> : null}
      </div>
    )
  }

  const { verdict, freshness, stale, summary } = fleet
  const text = describeVerdict(verdict, { hasData: summary.data !== undefined, freshness })
  const noData = verdict.state === 'nodata'
  const dim = stale || noData
  // Old numbers under a NO DATA word would read as a verdict: draw an empty bar and no counts.
  const counted = noData ? emptyCounts() : { ...verdict.counts, idle: 0 }
  const name = `Fleet status: ${text.summary}${PROVENANCE_SPOKEN[provenance] ? `, ${PROVENANCE_SPOKEN[provenance]}` : ''}`

  return (
    <Tooltip content={<span className="type-body">{text.scope}</span>}>
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
        <span className={CONTENT}>
          <span className="flex min-w-0 items-center gap-3">
            {/* Large text and marks may dim (3:1 is enough at this size); small text never does. */}
            <span className={cn('type-hero tnum shrink-0 text-fg', dim && 'opacity-60')}>
              {text.figure}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn('type-verdict flex items-center gap-2', STATUS_TEXT[verdict.status])}
              >
                <StatusGlyph status={verdict.status} size={24} />
                <span className="whitespace-nowrap">{verdict.word}</span>
              </span>
              <span className="type-data flex items-center gap-2 text-fg-muted">
                <span className="truncate">{text.caption}</span>
                {stale && !noData ? <StatusTag status="warning" word="STALE" /> : null}
              </span>
            </span>
          </span>
          <SegmentedBar
            counts={counted}
            height={8}
            label="Fleet"
            className={cn(BAR_WIDTH, dim && 'opacity-60')}
          />
          <CountList
            counts={counted}
            show={COUNTED_STATUSES}
            wordClassName={
              listedCounts(counted, COUNTED_STATUSES).length > WORDED_MARKS
                ? CROWDED_WORDS
                : undefined
            }
          />
        </span>
        <span id={descriptionId} className="sr-only">
          {text.scope} Enter opens Needs attention.
        </span>
      </button>
    </Tooltip>
  )
}

function HeroSkeleton() {
  return (
    <div className={CONTENT}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-14" />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className={cn('h-2', BAR_WIDTH)} />
      <Skeleton className="h-4 w-40" />
    </div>
  )
}

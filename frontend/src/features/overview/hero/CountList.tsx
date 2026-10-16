import type { HealthStatus, StatusCounts } from '@/api/types'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import { STATUS_WORD, StatusGlyph } from '@/ui/status'
import { listedCounts } from './tileText'

interface CountListProps {
  counts: StatusCounts
  /** Which statuses may be listed (offline is part of critical). Those with no members are skipped. */
  show: readonly HealthStatus[]
  /** Print the word after each number. A crowded tile keeps shape + number only. */
  words?: boolean
  /** Extra classes for each word: a container query that hides it where it would not fit. */
  wordClassName?: string
  /** Shown when nothing in `show` has members; the row keeps its height without it. */
  empty?: string
  className?: string
}

/**
 * Glyph, number and word for each status that has members, worst first
 * ("1 CRIT 1 OFFL 2 WARN"). Offline servers are listed apart from the rest of
 * critical. The shape and the word carry the state; the color of the glyph
 * only agrees with them. Decorative: its parent link or button names the same
 * counts in full sentences.
 */
export function CountList({
  counts,
  show,
  words = true,
  wordClassName,
  empty,
  className,
}: CountListProps) {
  const listed = listedCounts(counts, show)
  return (
    <span
      className={cn(
        'type-data tnum flex min-h-4 items-center gap-x-3 whitespace-nowrap',
        className,
      )}
    >
      {listed.length === 0 ? (
        empty ? (
          <span className="text-fg-faint">{empty}</span>
        ) : null
      ) : (
        listed.map(({ status, count }) => (
          <span key={status} className="inline-flex items-center gap-1">
            <StatusGlyph status={status} size={10} />
            <span className="text-fg">{formatInteger(count)}</span>
            {words ? (
              <>
                {/* The literal space keeps copied and spoken text "4 CRIT"; it takes no room in the flex row. */}{' '}
                <span className={cn('text-fg-muted', wordClassName)}>{STATUS_WORD[status]}</span>
              </>
            ) : null}
          </span>
        ))
      )}
    </span>
  )
}

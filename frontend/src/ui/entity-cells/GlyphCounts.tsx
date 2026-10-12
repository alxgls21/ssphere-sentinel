import type { StatusCounts } from '@/api/types'
import { nonZeroCounts } from '@/lib/blocks'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import { EntityGlyph } from './EntityGlyph'

/**
 * A glyph and a number for each status that has members, worst first: the
 * counts that sit beside a bar once a strip has too many entities to draw.
 * Decorative like the strip: the parent row's label carries the words.
 */
export function GlyphCounts({ counts, className }: { counts: StatusCounts; className?: string }) {
  return (
    <span
      className={cn(
        'type-data tnum flex items-center gap-2 whitespace-nowrap text-fg-muted',
        className,
      )}
    >
      {nonZeroCounts(counts).map(({ status, count }) => (
        <span key={status} className="inline-flex items-center gap-1">
          <EntityGlyph status={status} />
          {formatInteger(count)}
        </span>
      ))}
    </span>
  )
}

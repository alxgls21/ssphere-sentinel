import type { SiteEntity } from '@/api/types'
import { cn } from '@/lib/cn'
import { countEntities } from '@/lib/status'
import { SegmentedBar } from '@/ui/meters'
import { EntityGlyph } from './EntityGlyph'
import { GlyphCounts } from './GlyphCounts'
import { displayOf, entityKey, worstFirst } from './entities'

const STRIP_CAPACITY = 20

interface EntityStripProps {
  entities: readonly SiteEntity[]
  /** Most glyphs the row can hold (20 at 395px); past it the strip becomes a bar plus counts. */
  capacity?: number
  /** Accessible-name prefix of the collapsed bar. */
  label?: string
  className?: string
}

/**
 * One glyph per entity, worst first, on a 12px pitch (10px cells, 2px gaps).
 * It is decorative: it sits inside a link or button whose aria-label comes
 * from describeEntities, so nothing here is announced or gated by hover.
 */
export function EntityStrip({
  entities,
  capacity = STRIP_CAPACITY,
  label = 'Entities',
  className,
}: EntityStripProps) {
  if (entities.length === 0) return null

  if (entities.length > capacity) {
    const counts = countEntities(entities)
    return (
      <span aria-hidden="true" className={cn('flex items-center gap-2', className)}>
        <SegmentedBar counts={counts} height={8} label={label} className="min-w-6 flex-1" />
        <GlyphCounts counts={counts} className="shrink-0" />
      </span>
    )
  }

  return (
    <span aria-hidden="true" className={cn('flex items-center gap-0.5', className)}>
      {worstFirst(entities).map((entity) => (
        <EntityGlyph key={entityKey(entity)} status={displayOf(entity)} />
      ))}
    </span>
  )
}

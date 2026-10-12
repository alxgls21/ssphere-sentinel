import type { ReactNode } from 'react'
import { StatusGlyph } from '@/ui/status'
import type { GlyphShape } from '@/ui/status'

interface EmptyStateProps {
  title: string
  hint?: ReactNode
  /** A positive empty state ("Nothing needs attention") uses the OK glyph. */
  glyph?: GlyphShape
}

export function EmptyState({ title, hint, glyph }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-24 flex-col items-start justify-center gap-1 p-3">
      <p className="type-title flex items-center gap-2 text-fg">
        {glyph ? <StatusGlyph status={glyph} size={16} /> : null}
        {title}
      </p>
      {hint ? <p className="type-body text-fg-muted">{hint}</p> : null}
    </div>
  )
}

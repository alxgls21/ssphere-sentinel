import type { HealthStatus } from '@/api/types'
import { cn } from '@/lib/cn'
import { StatusGlyph, type GlyphSize } from './StatusGlyph'
import { STATUS_TEXT, STATUS_TINT, STATUS_WORD } from './style'

interface StatusTagProps {
  status: HealthStatus
  /** A more specific domain word (ONLINE, OFFLINE, UNHEALTHY, RESTARTING, ...) replacing OK/WARN/CRIT. */
  word?: string
  /**
   * plain: glyph + word, no tint (dense lists, tooltips).
   * tag:   word on the status tint, a clean scan line down a table column.
   */
  variant?: 'plain' | 'tag'
  glyphSize?: GlyphSize
  className?: string
}

/** Glyph + word + color: the only way to show a health state as text. Never color alone. */
export function StatusTag({
  status,
  word,
  variant = 'plain',
  glyphSize = 10,
  className,
}: StatusTagProps) {
  const text = word ?? STATUS_WORD[status]
  return (
    <span
      className={cn(
        'type-tag inline-flex items-center gap-1.5 whitespace-nowrap',
        STATUS_TEXT[status],
        variant === 'tag' && cn('min-w-[6ch] rounded-sm px-1.5 py-0.5', STATUS_TINT[status]),
        className,
      )}
      data-status={status}
    >
      <StatusGlyph status={status} size={glyphSize} />
      <span>{text}</span>
    </span>
  )
}

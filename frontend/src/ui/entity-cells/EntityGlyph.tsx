import type { DisplayStatus } from '@/lib/status'
import { StatusGlyph } from '@/ui/status'

/**
 * One status mark in a 10px slot: healthy is the quiet 6px dot, everything
 * else its full 10px shape, so a strip of mostly-OK entities recedes and the
 * exceptions stand out.
 */
export function EntityGlyph({ status }: { status: DisplayStatus }) {
  return (
    <span className="flex size-2.5 shrink-0 items-center justify-center">
      <StatusGlyph status={status} size={status === 'healthy' ? 6 : 10} />
    </span>
  )
}

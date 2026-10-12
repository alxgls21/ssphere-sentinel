import type { Freshness } from '@/app/live'
import { cn } from '@/lib/cn'
import { STATUS_TEXT } from '@/ui/status'

/**
 * The 8x14 block cursor that encodes connection state:
 *   live      solid
 *   fetching  solid, with a stepped blink (a request is in flight)
 *   paused    hollow
 *   stale / no data   hollow and struck through, in warning / critical
 * Decorative: the freshness chip and the status bar say the same in words.
 */
export function LiveCursor({ state, className }: { state: Freshness; className?: string }) {
  const struck = state === 'stale' || state === 'nodata'
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn(
        'relative inline-block h-3.5 w-2 shrink-0',
        state === 'live' && 'bg-primary',
        state === 'fetching' && 'animate-cursor bg-primary',
        state === 'paused' && 'border border-primary',
        struck &&
          cn('border border-current', STATUS_TEXT[state === 'stale' ? 'warning' : 'critical']),
        className,
      )}
    >
      {struck ? <span className="absolute inset-x-0 top-1/2 h-px bg-current" /> : null}
    </span>
  )
}

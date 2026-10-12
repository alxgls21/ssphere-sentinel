import { cn } from '@/lib/cn'
import { STATUS_TEXT, STATUS_TINT } from '@/ui/status'
import { LiveCursor } from './LiveCursor'
import { describeFreshness } from './freshness'
import { useFreshness } from './useFreshness'

/**
 * How fresh the screen is, in words: "updated 3s ago", "updating", "PAUSED 41s",
 * "STALE 52s" (warning on its tint), "NO DATA 2m" (critical on its tint). The
 * chip is a polite status region, but the ticking text is hidden from assistive
 * technology: what it hears changes only when the state does, never every second.
 */
export function FreshnessChip() {
  const { state, ageSeconds } = useFreshness()
  const { text, spoken } = describeFreshness(state, ageSeconds)
  const tone = state === 'stale' ? 'warning' : state === 'nodata' ? 'critical' : null
  return (
    <output
      data-state={state}
      className={cn(
        'type-tag inline-flex h-6 shrink-0 items-center rounded-sm px-2 whitespace-nowrap',
        tone ? cn(STATUS_TEXT[tone], STATUS_TINT[tone]) : 'text-fg-muted',
      )}
    >
      <span aria-hidden="true" className="tnum">
        {text}
      </span>
      <span className="sr-only">{spoken}</span>
    </output>
  )
}

/** The phone app bar has room for the cursor only; the state is still spoken. */
export function FreshnessCursor() {
  const { state, ageSeconds } = useFreshness()
  const { spoken } = describeFreshness(state, ageSeconds)
  return (
    <output className="inline-flex shrink-0 items-center">
      <LiveCursor state={state} />
      <span className="sr-only">{spoken}</span>
    </output>
  )
}

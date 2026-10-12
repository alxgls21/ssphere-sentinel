import type { CSSProperties } from 'react'
import { useLive, useLiveSnapshot } from '@/app/live'
import { useReducedMotion } from '../useReducedMotion'

/**
 * The topbar's bottom hairline, which doubles as the refresh progress line: a
 * 1px bar scales from 0 to 1 over the poll interval (transform only), starts
 * over on every successful load (the key), and freezes while paused. Under
 * reduced motion only the static track remains, and the status bar's
 * "next poll 12s" says the same in words.
 */
export function RefreshHairline() {
  const { pollMs, paused } = useLive()
  const { lastUpdatedAt } = useLiveSnapshot()
  const reduced = useReducedMotion()
  return (
    <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px bg-border">
      {reduced || lastUpdatedAt === null ? null : (
        <div
          key={lastUpdatedAt}
          className="animate-refresh h-full origin-left bg-primary"
          style={
            {
              '--refresh-ms': `${pollMs}ms`,
              animationPlayState: paused ? 'paused' : 'running',
            } as CSSProperties
          }
        />
      )}
    </div>
  )
}

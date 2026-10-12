import { useContext, useSyncExternalStore } from 'react'
import { LiveContext } from '@/app/live'
import { STALE_AFTER_SECONDS } from '@/lib/thresholds'

/** One shared one-second clock for every panel, so N panels do not run N timers. */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), 1000)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * True when what a panel shows is older than the stale threshold. Each panel
 * judges its own data, so a panel whose endpoint died says so even while the
 * rest of the screen is fresh. Not while polling is paused on purpose: the age
 * of a frozen screen grows by design.
 */
export function useStale(updatedAt: number | null): boolean {
  const paused = useContext(LiveContext)?.paused ?? false
  const read = () =>
    updatedAt !== null && !paused && Date.now() - updatedAt >= STALE_AFTER_SECONDS * 1000
  return useSyncExternalStore(subscribe, read, read)
}

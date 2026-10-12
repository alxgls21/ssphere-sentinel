import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { OverviewSummary } from '@/api/types'
import { computeFreshness, useLive, type Freshness } from '@/app/live'
import { useSummary } from '@/app/summary'
import type { Resource } from '@/hooks/useResource'
import { computeVerdict, type Verdict } from '@/lib/verdict'

const TICK_MS = 1000

/**
 * The freshness of the screen (live, stale, no data), re-evaluated every
 * second against the client clock. It returns a string, so a component only
 * re-renders when the state itself changes, not on every tick.
 */
export function useFreshness(): Freshness {
  const { store, paused } = useLive()
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribe = store.subscribe(onChange)
      const timer = setInterval(onChange, TICK_MS)
      return () => {
        unsubscribe()
        clearInterval(timer)
      }
    },
    [store],
  )
  const read = () =>
    computeFreshness({ now: Date.now(), snapshot: store.getSnapshot(), paused }).state
  return useSyncExternalStore(subscribe, read, read)
}

export interface SummaryState {
  summary: Resource<OverviewSummary>
  freshness: Freshness
  /** What is on screen is old or failed to refresh: still shown, but dimmed. */
  stale: boolean
}

/** The shared summary plus how far to trust it. Every tile and the verdict read the same thing. */
export function useSummaryState(): SummaryState {
  const summary = useSummary()
  const freshness = useFreshness()
  const stale = freshness === 'stale' || freshness === 'nodata' || summary.error !== null
  return { summary, freshness, stale }
}

export interface FleetStatus extends SummaryState {
  verdict: Verdict
}

export function useFleetStatus(): FleetStatus {
  const state = useSummaryState()
  const { data } = state.summary
  const { freshness } = state
  const verdict = useMemo(() => computeVerdict(data, freshness), [data, freshness])
  return { ...state, verdict }
}

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Freshness } from '@/lib/freshness'
import { POLL_MS, NO_DATA_AFTER_SECONDS, STALE_AFTER_SECONDS } from '@/lib/thresholds'

export type { Freshness }

/** What each live resource reports about itself. */
export interface ResourceReport {
  updatedAt: number | null
  failed: boolean
  fetching: boolean
}

export interface LiveSnapshot {
  /** Most recent successful load across all live resources (client clock). */
  lastUpdatedAt: number | null
  /** Every registered resource has failed and none has data. */
  allFailed: boolean
  /** Any resource has a request in flight. */
  fetching: boolean
  resources: number
}

const EMPTY: LiveSnapshot = { lastUpdatedAt: null, allFailed: false, fetching: false, resources: 0 }

/**
 * Tiny external store of resource reports. Panels report into it; the
 * freshness chip, status bar and verdict read from it. Kept outside React
 * state so a panel finishing a fetch never re-renders unrelated panels.
 */
export class LiveStore {
  private reports = new Map<string, ResourceReport>()
  private listeners = new Set<() => void>()
  private snapshot: LiveSnapshot = EMPTY

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): LiveSnapshot => this.snapshot

  report(id: string, report: ResourceReport): void {
    const previous = this.reports.get(id)
    if (
      previous &&
      previous.updatedAt === report.updatedAt &&
      previous.failed === report.failed &&
      previous.fetching === report.fetching
    )
      return
    this.reports.set(id, report)
    this.recompute()
  }

  remove(id: string): void {
    if (this.reports.delete(id)) this.recompute()
  }

  private recompute(): void {
    const all = [...this.reports.values()]
    const updated = all.flatMap((r) => (r.updatedAt === null ? [] : [r.updatedAt]))
    const next: LiveSnapshot = {
      lastUpdatedAt: updated.length ? Math.max(...updated) : null,
      allFailed: all.length > 0 && all.every((r) => r.failed && r.updatedAt === null),
      fetching: all.some((r) => r.fetching),
      resources: all.length,
    }
    const prev = this.snapshot
    if (
      prev.lastUpdatedAt === next.lastUpdatedAt &&
      prev.allFailed === next.allFailed &&
      prev.fetching === next.fetching &&
      prev.resources === next.resources
    )
      return
    this.snapshot = next
    this.listeners.forEach((l) => l())
  }
}

export interface LiveControls {
  /** Poll interval for live panels (ms). */
  pollMs: number
  /** Polling frozen by the operator (key p). */
  paused: boolean
  togglePause: () => void
  /** Increments on every "refresh now" (key r); live resources refetch when it changes. */
  refreshToken: number
  refresh: () => void
  store: LiveStore
}

export const LiveContext = createContext<LiveControls | null>(null)

export function useLive(): LiveControls {
  const live = useContext(LiveContext)
  if (!live) throw new Error('useLive must be used inside <LiveProvider>')
  return live
}

export function useLiveSnapshot(): LiveSnapshot {
  const { store } = useLive()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export interface FreshnessInput {
  now: number
  snapshot: LiveSnapshot
  paused: boolean
}

/**
 * How far to trust the screen. A dead dashboard must never look healthy:
 *   older than STALE_AFTER_SECONDS  -> stale
 *   older than NO_DATA_AFTER_SECONDS, or every resource failed -> nodata
 * Pause is reported as such unless the data has also gone stale.
 */
export function computeFreshness({ now, snapshot, paused }: FreshnessInput): {
  state: Freshness
  ageSeconds: number | null
} {
  if (snapshot.allFailed) return { state: 'nodata', ageSeconds: null }
  if (snapshot.lastUpdatedAt === null)
    return { state: snapshot.fetching ? 'fetching' : 'live', ageSeconds: null }
  const ageSeconds = Math.max(0, Math.floor((now - snapshot.lastUpdatedAt) / 1000))
  // While paused the age grows by design, so only the NO DATA bound applies.
  if (ageSeconds >= NO_DATA_AFTER_SECONDS && !paused) return { state: 'nodata', ageSeconds }
  if (paused) return { state: 'paused', ageSeconds }
  if (ageSeconds >= STALE_AFTER_SECONDS) return { state: 'stale', ageSeconds }
  return { state: snapshot.fetching ? 'fetching' : 'live', ageSeconds }
}

export const DEFAULT_POLL_MS = POLL_MS

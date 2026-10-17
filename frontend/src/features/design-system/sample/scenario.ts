import type { SentinelApi } from '@/api/client'
import type { OverviewSummary } from '@/api/types'
import { LiveStore, type LiveControls } from '@/app/live'
import { DEFAULT_PREFS, type PrefsApi } from '@/app/prefs'
import type { ShellApi } from '@/app/shell'
import type { Resource } from '@/hooks/useResource'
import { POLL_MS } from '@/lib/thresholds'
import { SAMPLE_TIME } from './data'
import { noop } from './noop'

/**
 * The contexts the shared components read, built from static values. The
 * gallery has no data source of its own, so every method refuses.
 */

const refuse = (name: string) => () =>
  Promise.reject(new Error(`The design-system gallery has no ${name}`))

export const GALLERY_API: SentinelApi = {
  source: 'mock',
  getScopeOptions: refuse('getScopeOptions'),
  getOverviewSummary: refuse('getOverviewSummary'),
  listAttention: refuse('listAttention'),
  getFleetLoad: refuse('getFleetLoad'),
  getHealthBreakdown: refuse('getHealthBreakdown'),
  getEntityIndex: refuse('getEntityIndex'),
  listServers: refuse('listServers'),
  listContainers: refuse('listContainers'),
  listTargets: refuse('listTargets'),
  getTarget: refuse('getTarget'),
  getTargetSeries: refuse('getTargetSeries'),
  listDevices: refuse('listDevices'),
  getDevice: refuse('getDevice'),
  getDeviceSeries: refuse('getDeviceSeries'),
  getInterfaceSeries: refuse('getInterfaceSeries'),
  getServer: refuse('getServer'),
  getServerSeries: refuse('getServerSeries'),
}

/** Used only when the page is mounted without the app's PrefsProvider. */
export const FALLBACK_PREFS: PrefsApi = {
  ...DEFAULT_PREFS,
  setTz: noop,
  toggleTz: noop,
  setSingleKeyShortcuts: noop,
  setMotion: noop,
}

/** Nothing here opens an overlay or speaks: the verdict only needs somewhere to announce into. */
export const GALLERY_SHELL: ShellApi = {
  sidebarCollapsed: false,
  toggleSidebar: noop,
  mobileNavOpen: false,
  setMobileNavOpen: noop,
  paletteOpen: false,
  openPalette: noop,
  closePalette: noop,
  shortcutsOpen: false,
  openShortcuts: noop,
  closeShortcuts: noop,
  announce: noop,
  flashStatus: noop,
}

/**
 * The state of the shared summary a scenario puts on screen:
 *   ready           data, fresh
 *   loading         first load in flight
 *   error           the load failed and there is nothing to show
 *   refresh-failed  data on screen, the latest refresh failed (dimmed, named stale)
 *   no-data         data on screen but every source has failed: the verdict reads NO DATA
 */
export type ScenarioKind = 'ready' | 'loading' | 'error' | 'refresh-failed' | 'no-data'

export function summaryResource(
  kind: ScenarioKind,
  summary: OverviewSummary,
): Resource<OverviewSummary> {
  const base = {
    data: undefined,
    error: null,
    isRefreshing: false,
    updatedAt: null,
    refetch: noop,
  }
  const loaded = { ...base, data: summary, updatedAt: SAMPLE_TIME }
  switch (kind) {
    case 'ready':
    case 'no-data':
      return { ...loaded, status: 'success' }
    case 'refresh-failed':
      return { ...loaded, status: 'success', error: new Error('Request failed: 503') }
    case 'loading':
      return { ...base, status: 'loading' }
    case 'error':
      return { ...base, status: 'error', error: new Error('Request failed: 503') }
  }
}

/**
 * A fresh store reports "live" for ever, which is what a static page wants: no
 * report means no age to grow stale. NO DATA is the one state that needs a
 * report, and "every resource failed" never ages out. A component that loads
 * for itself (the alerts tile) reports into its store and keeps it fresh by
 * polling, exactly as it does in the app.
 */
export function liveControls(kind: ScenarioKind): LiveControls {
  const store = new LiveStore()
  if (kind === 'no-data')
    store.report('gallery', { updatedAt: null, failed: true, fetching: false })
  return {
    pollMs: POLL_MS,
    paused: false,
    togglePause: noop,
    refreshToken: 0,
    refresh: noop,
    store,
  }
}

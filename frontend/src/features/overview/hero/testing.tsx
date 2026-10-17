import { render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiContext } from '@/api/context'
import { createTestApi } from '@/test/render'
import type { OverviewSummary, StatusCounts } from '@/api/types'
import { AlertsContext, type AlertsState } from '@/app/alerts'
import { engine, overview } from '@/features/alerts/testing'
import { LiveContext, LiveStore, type LiveControls } from '@/app/live'
import { ShellContext, type ShellApi } from '@/app/shell'
import { SummaryContext } from '@/app/summary'
import type { Resource } from '@/hooks/useResource'

/** Test support for the hero: never imported by the app. */

export const counts = (over: Partial<StatusCounts> = {}): StatusCounts => ({
  healthy: 0,
  warning: 0,
  critical: 0,
  unknown: 0,
  idle: 0,
  ...over,
})

/**
 * The reference story: 16 servers (13 ok, 2 warn, 1 crit) and 68 containers
 * (62 ok, 1 warn, 2 crit, 3 idle): 3 critical, 3 warning, 75 ok of 81 counted, 3 idle.
 */
export function makeSummary(over: Partial<OverviewSummary> = {}): OverviewSummary {
  return {
    generatedAt: '2026-10-12T14:05:12Z',
    servers: { total: 16, counts: counts({ healthy: 13, warning: 2, critical: 1 }) },
    containers: { total: 68, counts: counts({ healthy: 62, warning: 1, critical: 2, idle: 3 }) },
    targets: { total: 0, counts: counts() },
    devices: { total: 0, counts: counts() },
    ...over,
  }
}

export function makeResource(
  over: Partial<Resource<OverviewSummary>> = {},
): Resource<OverviewSummary> {
  return {
    status: 'success',
    data: makeSummary(),
    error: null,
    isRefreshing: false,
    updatedAt: Date.now(),
    refetch: vi.fn(),
    ...over,
  }
}

/** A shell whose controls do nothing and whose live region is the given spy. */
export function makeShell(announce: ShellApi['announce'] = vi.fn()): ShellApi {
  return {
    sidebarCollapsed: false,
    toggleSidebar: () => {},
    mobileNavOpen: false,
    setMobileNavOpen: () => {},
    paletteOpen: false,
    openPalette: () => {},
    closePalette: () => {},
    shortcutsOpen: false,
    openShortcuts: () => {},
    closeShortcuts: () => {},
    announce,
    flashStatus: () => {},
  }
}

/** A resource that has loaded, as a test holds it. */
export function loaded<T>(data: T, over: Partial<Resource<T>> = {}): Resource<T> {
  return {
    status: 'success',
    data,
    error: null,
    isRefreshing: false,
    updatedAt: Date.now(),
    refetch: vi.fn(),
    ...over,
  }
}

/** The shared alert figures: seven open incidents, the engine running. */
export function makeAlerts(over: Partial<AlertsState> = {}): AlertsState {
  return { overview: loaded(overview()), engine: loaded(engine()), ...over }
}

interface Contexts {
  summary: Resource<OverviewSummary>
  alerts: AlertsState
  api: SentinelApi
  store: LiveStore
  pollMs: number
  paused: boolean
  shell: ShellApi
}

/** The same contexts as the app, as a plain function so this file exports no component. */
function withContexts(
  children: ReactNode,
  { summary, alerts, api, store, pollMs, paused, shell }: Contexts,
): ReactElement {
  const live: LiveControls = {
    pollMs,
    paused,
    togglePause: () => {},
    refreshToken: 0,
    refresh: () => {},
    store,
  }
  return (
    <MemoryRouter>
      <ApiContext.Provider value={api}>
        <LiveContext.Provider value={live}>
          <ShellContext.Provider value={shell}>
            <SummaryContext.Provider value={summary}>
              <AlertsContext.Provider value={alerts}>{children}</AlertsContext.Provider>
            </SummaryContext.Provider>
          </ShellContext.Provider>
        </LiveContext.Provider>
      </ApiContext.Provider>
    </MemoryRouter>
  )
}

interface HarnessOptions {
  summary?: Resource<OverviewSummary>
  alerts?: AlertsState
  api?: SentinelApi
  /** Poll interval seen by the live layer. */
  pollMs?: number
  paused?: boolean
}

/**
 * Renders under the same contexts as the app, with the summary resource held
 * by the test: `update` swaps it (a new poll), `store` is the freshness store
 * (report an old updatedAt to age the screen) and `announce` records what the
 * shell would have spoken.
 */
export function renderHero(ui: ReactElement, options: HarnessOptions = {}) {
  const { api = createTestApi(), pollMs = 1000, paused = false, alerts = makeAlerts() } = options
  const store = new LiveStore()
  const announce = vi.fn()
  const shell = makeShell(announce)
  const wrap = (summary: Resource<OverviewSummary>) =>
    withContexts(ui, { summary, alerts, api, store, pollMs, paused, shell })
  const result = render(wrap(options.summary ?? makeResource()))
  return {
    ...result,
    store,
    announce,
    update: (summary: Resource<OverviewSummary>) => result.rerender(wrap(summary)),
  }
}

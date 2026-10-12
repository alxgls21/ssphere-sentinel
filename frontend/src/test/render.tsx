import { render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiContext } from '@/api/context'
import { LiveProvider } from '@/app/LiveProvider'
import { PrefsProvider } from '@/app/PrefsProvider'
import { ShellContext, type ShellApi } from '@/app/shell'
import { SummaryProvider } from '@/app/SummaryProvider'

const unstubbed = (name: string) => () =>
  Promise.reject(new Error(`test API: ${name} was not stubbed`))

/** A SentinelApi whose methods reject unless a test stubs them. */
export function createTestApi(overrides: Partial<SentinelApi> = {}): SentinelApi {
  return {
    source: 'mock',
    getScopeOptions: unstubbed('getScopeOptions'),
    getOverviewSummary: unstubbed('getOverviewSummary'),
    listAttention: unstubbed('listAttention'),
    getNetworkSeries: unstubbed('getNetworkSeries'),
    getFleetLoad: unstubbed('getFleetLoad'),
    getHealthBreakdown: unstubbed('getHealthBreakdown'),
    listAlerts: unstubbed('listAlerts'),
    listEvents: unstubbed('listEvents'),
    getEntityIndex: unstubbed('getEntityIndex'),
    listServers: unstubbed('listServers'),
    getServer: unstubbed('getServer'),
    getServerSeries: unstubbed('getServerSeries'),
    ...overrides,
  }
}

/** A recording ShellApi: every action is a vi.fn, so tests can assert announce() / flashStatus() calls. */
export function createFakeShell(overrides: Partial<ShellApi> = {}): ShellApi {
  return {
    sidebarCollapsed: false,
    toggleSidebar: vi.fn(),
    mobileNavOpen: false,
    setMobileNavOpen: vi.fn(),
    paletteOpen: false,
    openPalette: vi.fn(),
    closePalette: vi.fn(),
    shortcutsOpen: false,
    openShortcuts: vi.fn(),
    closeShortcuts: vi.fn(),
    announce: vi.fn(),
    flashStatus: vi.fn(),
    ...overrides,
  }
}

interface RenderAppOptions {
  api?: SentinelApi
  route?: string
  /** Include the shared SummaryProvider (needs getOverviewSummary stubbed). */
  withSummary?: boolean
  /** Poll interval; the default never fires during a test. */
  pollMs?: number
  /** Provide a ShellContext (panels call useShell for announce / flashStatus). Pass your own to assert on it. */
  withShell?: boolean | ShellApi
}

/** Renders inside the same providers as the app, with a controllable API and route. */
export function renderApp(
  ui: ReactElement,
  {
    api = createTestApi(),
    route = '/',
    withSummary = false,
    pollMs = 3_600_000,
    withShell = false,
  }: RenderAppOptions = {},
) {
  const shell = withShell === true ? createFakeShell() : withShell || null

  function Wrapper({ children }: { children: ReactNode }) {
    const content = withSummary ? <SummaryProvider>{children}</SummaryProvider> : children
    return (
      <MemoryRouter initialEntries={[route]}>
        <ApiContext.Provider value={api}>
          <PrefsProvider>
            <LiveProvider pollMs={pollMs}>
              {shell ? (
                <ShellContext.Provider value={shell}>{content}</ShellContext.Provider>
              ) : (
                content
              )}
            </LiveProvider>
          </PrefsProvider>
        </ApiContext.Provider>
      </MemoryRouter>
    )
  }
  return { ...render(ui, { wrapper: Wrapper }), fakeShell: shell }
}

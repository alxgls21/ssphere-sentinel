import { Fragment, useMemo, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { ApiContext } from '@/api/context'
import { createMockApi } from '@/api/mock/client'
import { LiveProvider } from './LiveProvider'
import { PrefsProvider } from './PrefsProvider'
import { useMockScenario } from './scenario'
import { ShellProvider } from '@/shell/ShellProvider'
import { SummaryProvider } from './SummaryProvider'

/**
 * Supplies the data source. Swap `createMockApi` for an HTTP client here when
 * the backend exposes read APIs; nothing else needs to change.
 *
 * Changing the mock scenario remounts everything below (via `key`) so every
 * screen replays its loading state from scratch.
 */
function ApiProvider({ children }: { children: ReactNode }) {
  const scenario = useMockScenario()
  const api = useMemo(() => createMockApi({ scenario }), [scenario])
  return (
    <ApiContext.Provider value={api}>
      <Fragment key={scenario}>{children}</Fragment>
    </ApiContext.Provider>
  )
}

/**
 * Router > data source > preferences > live layer (pause, refresh, freshness) > shared summary >
 * app frame state (sidebar, overlays, announcer).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <ApiProvider>
        <PrefsProvider>
          <LiveProvider>
            <SummaryProvider>
              <ShellProvider>{children}</ShellProvider>
            </SummaryProvider>
          </LiveProvider>
        </PrefsProvider>
      </ApiProvider>
    </BrowserRouter>
  )
}

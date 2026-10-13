import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { ApiContext } from '@/api/context'
import { composeDemoApi } from '@/api/demo'
import { createConsoleHttp, type ConsoleHttp } from '@/api/http'
import { createMockApi } from '@/api/mock/client'
import { ConfigurationError, resolveApiMode, type ApiMode } from '@/config/runtime'
import { ShellProvider } from '@/shell/ShellProvider'
import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/auth'
import { createSessionSignals } from './auth/signals'
import { LiveProvider } from './LiveProvider'
import { ModeContext } from './mode'
import { PrefsProvider } from './PrefsProvider'
import { useMockScenario } from './scenario'
import { SummaryProvider } from './SummaryProvider'

/**
 * Supplies the data source. In `http` mode the scope comes from the console API
 * and every other screen reads demo data kept apart from it (see composeDemoApi);
 * in `mock` mode (development and tests only) everything is the sample fleet.
 *
 * Changing the mock scenario remounts everything below (via `key`) so every
 * screen replays its loading state from scratch.
 */
function ApiProvider({ http, children }: { http: ConsoleHttp | null; children: ReactNode }) {
  const scenario = useMockScenario()
  const api = useMemo(() => {
    const demo = createMockApi({ scenario })
    return http ? composeDemoApi(demo, http) : demo
  }, [scenario, http])
  return (
    <ApiContext.Provider value={api}>
      <Fragment key={scenario}>{children}</Fragment>
    </ApiContext.Provider>
  )
}

/**
 * The live layer, the shared summary and the frame state only exist for a
 * signed-in user: nothing polls, and no shared state survives, on the sign-in
 * page or after sign-out.
 */
function SessionScope({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status !== 'authenticated') return <>{children}</>
  return (
    <LiveProvider>
      <SummaryProvider>
        <ShellProvider>{children}</ShellProvider>
      </SummaryProvider>
    </LiveProvider>
  )
}

function Services({ mode, children }: { mode: ApiMode; children: ReactNode }) {
  // The HTTP layer reports a 401 or 403 from any request; the auth state decides what that means.
  const [signals] = useState(createSessionSignals)
  const http = useMemo(
    () =>
      mode === 'http'
        ? createConsoleHttp({
            onUnauthenticated: signals.expired.emit,
            onForbidden: signals.forbidden.emit,
          })
        : null,
    [mode, signals],
  )
  return (
    <AuthProvider client={http?.auth ?? null} signals={signals}>
      <ApiProvider http={http}>
        <PrefsProvider>
          <SessionScope>{children}</SessionScope>
        </PrefsProvider>
      </ApiProvider>
    </AuthProvider>
  )
}

function Misconfigured({ message }: { message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 text-fg">
      <div className="flex max-w-prose flex-col gap-2 rounded-sm border border-border bg-panel p-4">
        <h1 className="type-title">Console misconfigured</h1>
        <p role="alert" className="type-body text-fg-muted">
          {message}
        </p>
      </div>
    </main>
  )
}

/**
 * Router > auth > data source > preferences > (signed in only) live layer,
 * shared summary, app frame state. A wrong or forbidden mode setting stops
 * here with a message instead of falling back to another mode.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const resolved = useMemo((): { mode: ApiMode } | { error: string } => {
    try {
      const mode = resolveApiMode({
        PROD: import.meta.env.PROD,
        VITE_SENTINEL_API: import.meta.env.VITE_SENTINEL_API,
      })
      return { mode }
    } catch (error) {
      if (error instanceof ConfigurationError) return { error: error.message }
      throw error
    }
  }, [])
  if ('error' in resolved) return <Misconfigured message={resolved.error} />
  return (
    <BrowserRouter>
      <ModeContext.Provider value={resolved.mode}>
        <Services mode={resolved.mode}>{children}</Services>
      </ModeContext.Provider>
    </BrowserRouter>
  )
}

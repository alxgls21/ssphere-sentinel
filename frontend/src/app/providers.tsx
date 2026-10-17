import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { ApiContext } from '@/api/context'
import type { SentinelApi } from '@/api/client'
import { createConsoleHttp, type ConsoleHttp } from '@/api/http'
import { ConfigurationError, resolveApiMode, type ApiMode } from '@/config/runtime'
import { ShellProvider } from '@/shell/ShellProvider'
import { AuthProvider } from './auth/AuthProvider'
import { createConsoleApi } from './consoleApi'
import { useAuth } from './auth/auth'
import { createSessionSignals } from './auth/signals'
import { AlertsProvider } from './AlertsProvider'
import { LiveProvider } from './LiveProvider'
import { ModeContext } from './mode'
import { PrefsProvider } from './PrefsProvider'
import { LimitsProvider } from './LimitsProvider'
import { useMockScenario } from './scenario'
import { SummaryProvider } from './SummaryProvider'

/**
 * The sample fleet is loaded only by a development run with VITE_SENTINEL_API=mock. The test
 * is on the build-time setting, so a production bundle holds no import of it at all.
 */
const loadSampleFleet = () =>
  import.meta.env.VITE_SENTINEL_API === 'mock'
    ? import('@/api/mock/client').then((module) => module.createMockApi)
    : Promise.reject(new Error('The sample fleet is not part of this build.'))

/**
 * Supplies the data source: the console API, or, in `mock` mode (development and tests
 * only), the sample fleet. In mock mode nothing renders until the sample fleet has loaded.
 *
 * Changing the mock scenario remounts everything below (via `key`) so every
 * screen replays its loading state from scratch.
 */
function ApiProvider({ http, children }: { http: ConsoleHttp | null; children: ReactNode }) {
  const scenario = useMockScenario()
  const [createMock, setCreateMock] = useState<
    typeof import('@/api/mock/client').createMockApi | null
  >(null)
  useEffect(() => {
    if (http) return
    let live = true
    void loadSampleFleet().then((create) => live && setCreateMock(() => create))
    return () => {
      live = false
    }
  }, [http])
  const api = useMemo<SentinelApi | null>(() => {
    if (http) return createConsoleApi(http)
    return createMock ? createMock({ scenario }) : null
  }, [scenario, http, createMock])
  if (!api) return null
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
        <AlertsProvider>
          <ShellProvider>{children}</ShellProvider>
        </AlertsProvider>
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
        <LimitsProvider>
          <PrefsProvider>
            <SessionScope>{children}</SessionScope>
          </PrefsProvider>
        </LimitsProvider>
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

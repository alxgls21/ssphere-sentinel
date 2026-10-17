import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApi } from '@/api/context'
import { App } from './App'
import { useApiMode } from './mode'
import { AppProviders } from './providers'
import { useMockScenario } from './scenario'

vi.mock('@/features/overview/OverviewPage', () => ({ default: () => <p>overview screen</p> }))
vi.mock('@/features/servers/ServersListPage', () => ({ default: () => <p>servers screen</p> }))
vi.mock('@/features/servers/ServerDetailPage', () => ({ default: () => <p>server screen</p> }))

const session = (over: Record<string, unknown> = {}) => ({
  apiVersion: 1,
  serverTime: '2026-10-13T08:00:00.000Z',
  authenticated: false,
  reason: null,
  csrfToken: 'tok',
  user: null,
  access: null,
  thresholds: null,
  ...over,
})
const SIGNED_IN = session({
  authenticated: true,
  user: { username: 'alice', displayName: 'Alice Example' },
  access: { allCustomers: false },
})
const SCOPE = {
  customers: [{ id: 'c1', name: 'Acme' }],
  sites: [{ id: 's1', customerId: 'c1', name: 'DC' }],
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A console API in a function: who is signed in, and what each call sees. */
function stubApi(initial: Record<string, unknown>) {
  let current = initial
  let logoutFails = false
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/session/')) return reply(current)
      if (url.endsWith('/auth/login/')) {
        const body = JSON.parse(String(init?.body)) as { password: string }
        if (body.password !== 'right') {
          return reply(
            { error: { code: 'invalid_credentials', message: 'Invalid user name or password.' } },
            401,
          )
        }
        current = SIGNED_IN
        return reply(SIGNED_IN)
      }
      if (url.endsWith('/auth/logout/')) {
        if (logoutFails) throw new TypeError('offline')
        current = session()
        return reply(current)
      }
      if (url.endsWith('/scope/')) {
        return current.authenticated
          ? reply(SCOPE)
          : reply({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } }, 401)
      }
      return reply({ error: { code: 'not_found', message: 'Not found.' } }, 404)
    }),
  )
  return {
    calls,
    expire: () => (current = session()),
    failLogout: (fails: boolean) => (logoutFails = fails),
  }
}

function Probe() {
  const mode = useApiMode()
  const scenario = useMockScenario()
  return <p>{`mode=${mode} scenario=${scenario}`}</p>
}

function SourceProbe() {
  const api = useApi()
  return <p>{`source=${api.source} methods=${Object.keys(api).sort().join(',')}`}</p>
}

const open = (path: string) => window.history.pushState({}, '', path)
const here = () => window.location.pathname + window.location.search

beforeEach(() => {
  vi.stubEnv('PROD', false)
  vi.stubEnv('VITE_SENTINEL_API', '')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  window.history.pushState({}, '', '/')
})

describe('production safety', () => {
  it('refuses mock mode in a production build, and shows why instead of any screen', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_SENTINEL_API', 'mock')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(
      <AppProviders>
        <p>the app</p>
      </AppProviders>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/not allowed in a production build/)
    expect(screen.queryByText('the app')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a mode it does not know, in development too', () => {
    vi.stubEnv('VITE_SENTINEL_API', 'sample')
    render(
      <AppProviders>
        <p>the app</p>
      </AppProviders>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/"http" or "mock"/)
    expect(screen.queryByText('the app')).toBeNull()
  })

  it('uses the console API when nothing is set, in production as well', async () => {
    vi.stubEnv('PROD', true)
    const { calls } = stubApi(session())
    open('/')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(calls).toContain('GET /api/v1/console/session/')
  })

  it('does not let the URL switch to sample data: ?mock= means nothing with the console API', async () => {
    stubApi(SIGNED_IN)
    open('/probe?mock=error')
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    )
    // The tree is rebuilt once the session is known, so look again rather than hold on to the first element.
    await waitFor(() => expect(screen.getByText('mode=http scenario=normal')).toBeVisible())
  })
})

describe('the data source', () => {
  it('is the console API, with no method for what it does not serve', async () => {
    stubApi(SIGNED_IN)
    render(
      <AppProviders>
        <SourceProbe />
      </AppProviders>,
    )
    const probe = await screen.findByText(/^source=http /)
    for (const missing of ['listAlerts', 'listEvents', 'getNetworkSeries']) {
      expect(probe.textContent).not.toContain(missing)
    }
    expect(probe.textContent).toContain('getOverviewSummary')
  })

  it('is the sample fleet only when a development run asks for it, and nothing renders before it has loaded', async () => {
    vi.stubEnv('VITE_SENTINEL_API', 'mock')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(
      <AppProviders>
        <SourceProbe />
      </AppProviders>,
    )
    expect(screen.queryByText(/source=/)).toBeNull()
    expect(await screen.findByText(/^source=mock /)).toBeVisible()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('with the console API', () => {
  it('sends an anonymous visitor to the sign-in page and takes them back after signing in', async () => {
    const user = userEvent.setup()
    const { calls } = stubApi(session())
    open('/servers/abc?range=6h')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(here()).toBe('/login?next=%2Fservers%2Fabc%3Frange%3D6h')
    expect(screen.queryByText('server screen')).toBeNull()

    await user.type(screen.getByLabelText('User name'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'right')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('server screen')).toBeVisible()
    expect(here()).toBe('/servers/abc?range=6h')
    const login = calls.indexOf('POST /api/v1/console/auth/login/')
    expect(login).toBeGreaterThan(-1)
  })

  it('refuses a wrong password without leaving the page, and keeps the screens locked', async () => {
    const user = userEvent.setup()
    stubApi(session())
    open('/')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    await user.type(await screen.findByLabelText('User name'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid user name or password.')
    expect(screen.queryByText('overview screen')).toBeNull()
    expect(here()).toBe('/login')
  })

  it('opens the page straight away for a visitor who is already signed in', async () => {
    stubApi(SIGNED_IN)
    open('/')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByText('overview screen')).toBeVisible()
  })

  it('does not let a signed-in user sit on the sign-in page, nor follow a foreign next', async () => {
    stubApi(SIGNED_IN)
    open(`/login?next=${encodeURIComponent('https://evil.example/')}`)
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByText('overview screen')).toBeVisible()
    expect(here()).toBe('/')
  })

  it('signs out from the account menu and leaves nothing of the page behind', async () => {
    const user = userEvent.setup()
    stubApi(SIGNED_IN)
    open('/servers')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    await screen.findByText('servers screen')
    await user.click(await screen.findByRole('button', { name: 'Account alice' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(here()).toBe('/login')
    expect(screen.queryByText('servers screen')).toBeNull()
  })

  it('does not claim a sign-out that failed: nothing is shown, and retrying ends the session', async () => {
    const user = userEvent.setup()
    const api = stubApi(SIGNED_IN)
    open('/servers')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    await screen.findByText('servers screen')
    api.failLogout(true)
    await user.click(await screen.findByRole('button', { name: 'Account alice' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign-out failed' })).toBeVisible()
    expect(screen.queryByText('servers screen')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()

    api.failLogout(false)
    await user.click(screen.getByRole('button', { name: 'Try sign-out again' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(here()).toBe('/login')
  })

  it('treats a session that ended on the server as expired, and says so on the sign-in page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = stubApi(SIGNED_IN)
      open('/servers')
      render(
        <AppProviders>
          <App />
        </AppProviders>,
      )
      await screen.findByText('servers screen')
      api.expire()
      await vi.advanceTimersByTimeAsync(61_000)
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
      expect(here()).toBe('/login?next=%2Fservers&reason=expired')
      expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent(
        'session ended',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows that the server cannot be reached, with a retry, and nothing else', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')))
    open('/')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByRole('heading', { name: 'Cannot reach the server' })).toBeVisible()
    expect(screen.queryByText('overview screen')).toBeNull()
    stubApi(SIGNED_IN)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('overview screen')).toBeVisible()
  })

  it('stops an account without console access at its own page', async () => {
    stubApi(session({ reason: 'no_console_access' }))
    open('/servers')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByRole('heading', { name: 'No console access' })).toBeVisible()
    expect(screen.queryByText('servers screen')).toBeNull()
  })
})

describe('mock mode (development and tests only)', () => {
  it('has no sign-in: the screens open, and no request leaves the page', async () => {
    vi.stubEnv('VITE_SENTINEL_API', 'mock')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    open('/servers')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByText('servers screen')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Account/ })).toBeNull()
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled())
  })

  it('sends /login to the application, since there is nobody to sign in', async () => {
    vi.stubEnv('VITE_SENTINEL_API', 'mock')
    open('/login?next=%2Fservers')
    render(
      <AppProviders>
        <App />
      </AppProviders>,
    )
    expect(await screen.findByText('servers screen')).toBeVisible()
  })
})

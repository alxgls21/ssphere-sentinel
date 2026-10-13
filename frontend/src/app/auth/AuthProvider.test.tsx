import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthClient, ConsoleSession } from '@/api/auth'
import { ApiError } from '@/api/errors'
import { AuthProvider, REVALIDATE_MS } from './AuthProvider'
import { useAuth } from './auth'
import { createSessionSignals } from './signals'

const ALICE: ConsoleSession = {
  authenticated: true,
  reason: null,
  user: { username: 'alice', displayName: 'Alice Example' },
  allCustomers: false,
}
const ANON: ConsoleSession = { authenticated: false, reason: null, user: null, allCustomers: false }
const DENIED: ConsoleSession = { ...ANON, reason: 'no_console_access' }

function client(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    getSession: vi.fn(async () => ANON),
    signIn: vi.fn(async () => ALICE),
    signOut: vi.fn(async () => ANON),
    ...overrides,
  }
}

function Probe() {
  const auth = useAuth()
  return (
    <div>
      <output aria-label="status">{auth.status}</output>
      <output aria-label="user">{auth.user?.username ?? 'nobody'}</output>
      <output aria-label="signed-out">{String(auth.signedOut)}</output>
      <output aria-label="error">{auth.error ?? ''}</output>
      <button onClick={() => void auth.signIn('alice', 'pw').catch(() => {})}>in</button>
      <button onClick={() => void auth.signOut()}>out</button>
      <button onClick={auth.refresh}>refresh</button>
    </div>
  )
}

const status = () => screen.getByLabelText('status').textContent

afterEach(() => vi.useRealTimers())

describe('AuthProvider', () => {
  it('asks the server before it says anything, then reports who is signed in', async () => {
    const c = client({ getSession: vi.fn(async () => ALICE) })
    render(
      <AuthProvider client={c}>
        <Probe />
      </AuthProvider>,
    )
    expect(status()).toBe('checking')
    await waitFor(() => expect(status()).toBe('authenticated'))
    expect(screen.getByLabelText('user')).toHaveTextContent('alice')
  })

  it('reports nobody when the server says nobody', async () => {
    render(
      <AuthProvider client={client()}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('anonymous'))
  })

  it('reports an account without console access as its own state, never as signed in', async () => {
    render(
      <AuthProvider client={client({ getSession: vi.fn(async () => DENIED) })}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('denied'))
  })

  it('says the server is unreachable, and asks again on request', async () => {
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Cannot reach the server.', null, 'network'))
      .mockResolvedValue(ALICE)
    const user = userEvent.setup()
    render(
      <AuthProvider client={client({ getSession })}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('unreachable'))
    expect(screen.getByLabelText('error')).toHaveTextContent('Cannot reach the server.')
    await user.click(screen.getByRole('button', { name: 'refresh' }))
    await waitFor(() => expect(status()).toBe('authenticated'))
  })

  it('signs in with the credentials and becomes authenticated', async () => {
    const c = client()
    const user = userEvent.setup()
    render(
      <AuthProvider client={c}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('anonymous'))
    await user.click(screen.getByRole('button', { name: 'in' }))
    await waitFor(() => expect(status()).toBe('authenticated'))
    expect(c.signIn).toHaveBeenCalledWith('alice', 'pw')
  })

  it('stays anonymous when the sign-in is refused', async () => {
    const c = client({
      signIn: vi.fn(async () => {
        throw new ApiError('Invalid user name or password.', 401, 'invalid_credentials')
      }),
    })
    const user = userEvent.setup()
    render(
      <AuthProvider client={c}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('anonymous'))
    await user.click(screen.getByRole('button', { name: 'in' }))
    await waitFor(() => expect(c.signIn).toHaveBeenCalled())
    expect(status()).toBe('anonymous')
  })

  it('signs out, and remembers it was deliberate', async () => {
    const c = client({ getSession: vi.fn(async () => ALICE) })
    const user = userEvent.setup()
    render(
      <AuthProvider client={c}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('authenticated'))
    await user.click(screen.getByRole('button', { name: 'out' }))
    await waitFor(() => expect(status()).toBe('anonymous'))
    expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
    expect(screen.getByLabelText('signed-out')).toHaveTextContent('true')
  })

  it('does not report a sign-out that did not happen, hides the user, and lets it be retried', async () => {
    const signOut = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Cannot reach the server.', null, 'network'))
      .mockResolvedValue(ANON)
    const c = client({ getSession: vi.fn(async () => ALICE), signOut })
    const user = userEvent.setup()
    render(
      <AuthProvider client={c}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('authenticated'))
    await user.click(screen.getByRole('button', { name: 'out' }))
    await waitFor(() => expect(status()).toBe('signout-failed'))
    expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
    expect(screen.getByLabelText('error')).toHaveTextContent('Cannot reach the server.')
    expect(screen.getByLabelText('signed-out')).toHaveTextContent('false')

    await user.click(screen.getByRole('button', { name: 'out' }))
    await waitFor(() => expect(status()).toBe('anonymous'))
    expect(signOut).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('signed-out')).toHaveTextContent('true')
  })

  it('shows nothing of the session while the server is being told', async () => {
    let finish!: () => void
    const signOut = vi.fn(
      () => new Promise<ConsoleSession>((resolve) => (finish = () => resolve(ANON))),
    )
    const user = userEvent.setup()
    render(
      <AuthProvider client={client({ getSession: vi.fn(async () => ALICE), signOut })}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('authenticated'))
    await user.click(screen.getByRole('button', { name: 'out' }))
    expect(status()).toBe('signing-out')
    expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
    await act(async () => finish())
    await waitFor(() => expect(status()).toBe('anonymous'))
  })

  it('does not let the periodic check bring a failed sign-out back to life', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const getSession = vi.fn(async () => ALICE)
    const signOut = vi
      .fn()
      .mockRejectedValue(new ApiError('Cannot reach the server.', null, 'network'))
    render(
      <AuthProvider client={client({ getSession, signOut })}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(status()).toBe('authenticated'))
    act(() => screen.getByRole('button', { name: 'out' }).click())
    await waitFor(() => expect(status()).toBe('signout-failed'))
    const calls = getSession.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(REVALIDATE_MS * 3))
    expect(getSession.mock.calls.length).toBe(calls)
    expect(status()).toBe('signout-failed')
  })

  describe('an expired session', () => {
    it('is noticed when any request reports it, and only for a signed-in user', async () => {
      const signals = createSessionSignals()
      render(
        <AuthProvider client={client({ getSession: vi.fn(async () => ALICE) })} signals={signals}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      act(() => signals.expired.emit())
      expect(status()).toBe('expired')
      expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
      // A second report changes nothing.
      act(() => signals.expired.emit())
      expect(status()).toBe('expired')
    })

    it('is noticed by the periodic check, without any data request', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const getSession = vi.fn().mockResolvedValueOnce(ALICE).mockResolvedValue(ANON)
      render(
        <AuthProvider client={client({ getSession })}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      await act(() => vi.advanceTimersByTimeAsync(REVALIDATE_MS + 100))
      await waitFor(() => expect(status()).toBe('expired'))
    })

    it('keeps the screen when only the periodic check failed to reach the server', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const getSession = vi
        .fn()
        .mockResolvedValueOnce(ALICE)
        .mockRejectedValue(new ApiError('Cannot reach the server.', null, 'network'))
      render(
        <AuthProvider client={client({ getSession })}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      await act(() => vi.advanceTimersByTimeAsync(REVALIDATE_MS + 100))
      expect(getSession).toHaveBeenCalledTimes(2)
      expect(status()).toBe('authenticated')
    })

    it('asks the server again when a request says the account may not use the console', async () => {
      const signals = createSessionSignals()
      const getSession = vi.fn().mockResolvedValueOnce(ALICE).mockResolvedValue(DENIED)
      render(
        <AuthProvider client={client({ getSession })} signals={signals}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      act(() => signals.forbidden.emit())
      await waitFor(() => expect(status()).toBe('denied'))
    })
  })

  it('has no sign-in at all without a client (mock mode): signed in, nobody in particular', () => {
    render(
      <AuthProvider client={null}>
        <Probe />
      </AuthProvider>,
    )
    expect(status()).toBe('authenticated')
    expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
  })
})

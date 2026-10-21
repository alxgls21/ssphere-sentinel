import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, type AuthClient, type ConsoleSession } from '@/api/auth'
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
    getSetup: vi.fn(async () => false),
    createFirstAdministrator: vi.fn(async () => ALICE),
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
      <output aria-label="capabilities">
        {Object.entries(auth.capabilities)
          .filter(([, granted]) => granted)
          .map(([name]) => name)
          .join(',')}
      </output>
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

  describe('an older session check', () => {
    /** A revalidation that has been sent but not answered, which the test answers when it chooses. */
    function pendingCheck() {
      let answer!: (session: ConsoleSession) => void
      let fail!: (error: Error) => void
      const promise = new Promise<ConsoleSession>((resolve, reject) => {
        answer = resolve
        fail = reject
      })
      return { promise, answer, fail }
    }

    async function signedInWithPendingCheck(over: Partial<AuthClient> = {}) {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const pending = pendingCheck()
      const getSession = vi
        .fn<AuthClient['getSession']>()
        .mockResolvedValueOnce(ALICE)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(ALICE)
      const signals = createSessionSignals()
      render(
        <AuthProvider client={client({ getSession, ...over })} signals={signals}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      // The periodic check goes out and is not answered yet.
      await act(() => vi.advanceTimersByTimeAsync(REVALIDATE_MS + 100))
      expect(getSession).toHaveBeenCalledTimes(2)
      return { pending, signals, getSession }
    }

    it('cannot bring a session back after a failed sign-out', async () => {
      const signOut = vi
        .fn()
        .mockRejectedValue(new ApiError('Cannot reach the server.', null, 'network'))
      const { pending } = await signedInWithPendingCheck({ signOut })
      act(() => screen.getByRole('button', { name: 'out' }).click())
      await waitFor(() => expect(status()).toBe('signout-failed'))

      await act(async () => pending.answer(ALICE))

      expect(status()).toBe('signout-failed')
      expect(screen.getByLabelText('user')).toHaveTextContent('nobody')
    })

    it('cannot bring a session back while the sign-out is still in flight', async () => {
      const signOut = vi.fn(() => new Promise<ConsoleSession>(() => {}))
      const { pending } = await signedInWithPendingCheck({ signOut })
      act(() => screen.getByRole('button', { name: 'out' }).click())
      expect(status()).toBe('signing-out')

      await act(async () => pending.answer(ALICE))

      expect(status()).toBe('signing-out')
    })

    it('cannot undo a completed sign-out', async () => {
      const { pending } = await signedInWithPendingCheck()
      act(() => screen.getByRole('button', { name: 'out' }).click())
      await waitFor(() => expect(status()).toBe('anonymous'))

      await act(async () => pending.answer(ALICE))

      expect(status()).toBe('anonymous')
      expect(screen.getByLabelText('signed-out')).toHaveTextContent('true')
    })

    it('cannot bring back a session that a request reported as expired', async () => {
      const { pending, signals } = await signedInWithPendingCheck()
      act(() => signals.expired.emit())
      expect(status()).toBe('expired')

      await act(async () => pending.answer(ALICE))

      expect(status()).toBe('expired')
    })

    it('is not asked at all once a sign-out has failed, so a "forbidden" report cannot revive the session either', async () => {
      const signOut = vi
        .fn()
        .mockRejectedValue(new ApiError('Cannot reach the server.', null, 'network'))
      const { signals, getSession } = await signedInWithPendingCheck({ signOut })
      act(() => screen.getByRole('button', { name: 'out' }).click())
      await waitFor(() => expect(status()).toBe('signout-failed'))
      const asked = getSession.mock.calls.length

      await act(async () => signals.forbidden.emit())

      expect(getSession.mock.calls.length).toBe(asked)
      expect(status()).toBe('signout-failed')
    })

    it('cannot sign out a user who has since signed in', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const pending = pendingCheck()
      const getSession = vi
        .fn<AuthClient['getSession']>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(ALICE)
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(
        <AuthProvider client={client({ getSession })}>
          <Probe />
        </AuthProvider>,
      )
      // The first check is slow; meanwhile the user signs in.
      await user.click(screen.getByRole('button', { name: 'in' }))
      await waitFor(() => expect(status()).toBe('authenticated'))

      await act(async () => pending.answer(ANON))

      expect(status()).toBe('authenticated')
      expect(screen.getByLabelText('user')).toHaveTextContent('alice')
    })

    it('still lets the newest check decide when two overlap', async () => {
      const first = pendingCheck()
      const second = pendingCheck()
      const getSession = vi
        .fn<AuthClient['getSession']>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const user = userEvent.setup()
      render(
        <AuthProvider client={client({ getSession })}>
          <Probe />
        </AuthProvider>,
      )
      await user.click(screen.getByRole('button', { name: 'refresh' }))
      expect(getSession).toHaveBeenCalledTimes(2)

      await act(async () => second.answer(ALICE))
      await waitFor(() => expect(status()).toBe('authenticated'))
      await act(async () => first.answer(ANON))

      expect(status()).toBe('authenticated')
    })
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

  describe('first-run setup', () => {
    const FIRST = { code: 'K7QX-M2P9-A4TR', username: 'root', email: '', password: 'pw' }
    function SetupProbe() {
      const auth = useAuth()
      const [required, setRequired] = useState('unasked')
      return (
        <div>
          <output aria-label="status">{auth.status}</output>
          <output aria-label="required">{required}</output>
          <button onClick={() => void auth.checkSetup().then((r) => setRequired(String(r)))}>
            check
          </button>
          <button onClick={() => void auth.completeSetup(FIRST).catch(() => {})}>create</button>
        </div>
      )
    }

    it('asks the server whether setup is required', async () => {
      const user = userEvent.setup()
      const getSetup = vi.fn(async () => true)
      render(
        <AuthProvider client={client({ getSetup })}>
          <SetupProbe />
        </AuthProvider>,
      )
      await user.click(screen.getByRole('button', { name: 'check' }))
      await waitFor(() => expect(screen.getByLabelText('required')).toHaveTextContent('true'))
      expect(getSetup).toHaveBeenCalledTimes(1)
    })

    it('says nothing is required without a server (mock mode)', async () => {
      const user = userEvent.setup()
      render(
        <AuthProvider client={null}>
          <SetupProbe />
        </AuthProvider>,
      )
      await user.click(screen.getByRole('button', { name: 'check' }))
      await waitFor(() => expect(screen.getByLabelText('required')).toHaveTextContent('false'))
    })

    it('signs the new administrator in with what the server answered', async () => {
      const user = userEvent.setup()
      const createFirstAdministrator = vi.fn(async () => ALICE)
      render(
        <AuthProvider client={client({ createFirstAdministrator })}>
          <SetupProbe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('anonymous'))
      await user.click(screen.getByRole('button', { name: 'create' }))
      await waitFor(() => expect(status()).toBe('authenticated'))
      expect(createFirstAdministrator).toHaveBeenCalledWith(FIRST)
    })

    it('stays anonymous when the server refuses, and lets the refusal reach the caller', async () => {
      const refusal = new ApiError('The setup code is not valid.', 400, 'invalid_code')
      const createFirstAdministrator = vi.fn(async () => {
        throw refusal
      })
      let caught: unknown
      function Catching() {
        const auth = useAuth()
        return (
          <button
            onClick={() => void auth.completeSetup(FIRST).catch((e: unknown) => (caught = e))}
          >
            go
          </button>
        )
      }
      render(
        <AuthProvider client={client({ createFirstAdministrator })}>
          <Probe />
          <Catching />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('anonymous'))
      await userEvent.click(screen.getByRole('button', { name: 'go' }))
      await waitFor(() => expect(caught).toBe(refusal))
      expect(status()).toBe('anonymous')
    })
  })

  describe('capabilities', () => {
    const GRANTED = {
      ...NO_CAPABILITIES,
      viewAlertRules: true,
      manageOwnNotifications: true,
    }
    const capabilities = () => screen.getByLabelText('capabilities').textContent

    it('carries what the server says the signed-in account may do', async () => {
      render(
        <AuthProvider
          client={client({ getSession: vi.fn(async () => ({ ...ALICE, capabilities: GRANTED })) })}
        >
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      expect(capabilities()).toBe('viewAlertRules,manageOwnNotifications')
    })

    it('offers nothing while the server is being asked, and to nobody', async () => {
      render(
        <AuthProvider client={client()}>
          <Probe />
        </AuthProvider>,
      )
      expect(capabilities()).toBe('')
      await waitFor(() => expect(status()).toBe('anonymous'))
      expect(capabilities()).toBe('')
    })

    it('offers nothing when the session carries none (an older server)', async () => {
      render(
        <AuthProvider client={client({ getSession: vi.fn(async () => ALICE) })}>
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('authenticated'))
      expect(capabilities()).toBe('')
    })

    it('offers nothing in mock mode, where there are no accounts', () => {
      render(
        <AuthProvider client={null}>
          <Probe />
        </AuthProvider>,
      )
      expect(capabilities()).toBe('')
    })

    it('takes the capabilities of a sign-in, and drops them at sign-out', async () => {
      const user = userEvent.setup()
      render(
        <AuthProvider
          client={client({
            signIn: vi.fn(async () => ({ ...ALICE, capabilities: GRANTED })),
            signOut: vi.fn(async () => ANON),
          })}
        >
          <Probe />
        </AuthProvider>,
      )
      await waitFor(() => expect(status()).toBe('anonymous'))
      await user.click(screen.getByRole('button', { name: 'in' }))
      await waitFor(() => expect(capabilities()).toBe('viewAlertRules,manageOwnNotifications'))
      await user.click(screen.getByRole('button', { name: 'out' }))
      await waitFor(() => expect(status()).toBe('anonymous'))
      expect(capabilities()).toBe('')
    })

    it('follows the server when its answer changes: a right taken away is not offered any more', async () => {
      vi.useFakeTimers()
      const getSession = vi
        .fn<AuthClient['getSession']>()
        .mockResolvedValueOnce({ ...ALICE, capabilities: GRANTED })
        .mockResolvedValue({
          ...ALICE,
          capabilities: { ...NO_CAPABILITIES, manageOwnNotifications: true },
        })
      render(
        <AuthProvider client={client({ getSession })}>
          <Probe />
        </AuthProvider>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(capabilities()).toBe('viewAlertRules,manageOwnNotifications')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REVALIDATE_MS + 10)
      })
      expect(capabilities()).toBe('manageOwnNotifications')
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

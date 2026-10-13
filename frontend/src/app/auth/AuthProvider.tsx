import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthClient, ConsoleSession, ConsoleUser } from '@/api/auth'
import { ApiError } from '@/api/errors'
import { AuthContext, type AuthApi, type AuthStatus } from './auth'
import type { SessionSignals } from './signals'

/** A signed-in tab asks the server again this often, so an expired session is noticed without a data request. */
export const REVALIDATE_MS = 60_000

interface State {
  status: AuthStatus
  user: ConsoleUser | null
  error: string | null
  signedOut: boolean
}

const CHECKING: State = { status: 'checking', user: null, error: null, signedOut: false }

function fromSession(session: ConsoleSession, previous: AuthStatus): State {
  if (session.authenticated && session.user) {
    return { status: 'authenticated', user: session.user, error: null, signedOut: false }
  }
  if (session.reason === 'no_console_access')
    return { status: 'denied', user: null, error: null, signedOut: false }
  // Was signed in a moment ago and no longer is: the session ran out (or was ended elsewhere).
  const wasIn = previous === 'authenticated' || previous === 'expired'
  return { status: wasIn ? 'expired' : 'anonymous', user: null, error: null, signedOut: false }
}

interface AuthProviderProps {
  /** null: no sign-in at all (mock mode). */
  client: AuthClient | null
  /** What the HTTP layer reports about the session (401 and 403 answers). */
  signals?: SessionSignals
  children: ReactNode
}

/**
 * The application's authentication state, from the console API's session.
 * Nothing else decides whether someone is signed in: not the URL, not storage.
 */
export function AuthProvider({ client, signals, children }: AuthProviderProps) {
  const [state, setState] = useState<State>(() =>
    client ? CHECKING : { status: 'authenticated', user: null, error: null, signedOut: false },
  )
  const statusRef = useRef(state.status)
  useEffect(() => {
    statusRef.current = state.status
  }, [state.status])

  const check = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) return
      try {
        const session = await client.getSession(signal)
        setState(fromSession(session, statusRef.current))
      } catch (error) {
        if (signal?.aborted) return
        // A failed revalidation of a signed-in tab keeps the screen: the next data request will say more.
        if (statusRef.current === 'authenticated') return
        setState({
          status: 'unreachable',
          user: null,
          error: error instanceof ApiError ? error.message : 'Cannot reach the server.',
          signedOut: false,
        })
      }
    },
    [client],
  )

  useEffect(() => {
    const controller = new AbortController()
    void check(controller.signal)
    return () => controller.abort()
  }, [check])

  useEffect(() => {
    if (!client || state.status !== 'authenticated') return
    const tick = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const timer = window.setInterval(tick, REVALIDATE_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [client, state.status, check])

  // The HTTP layer reports a 401 or 403 from any request through these.
  useEffect(() => {
    if (!signals) return
    const stopExpired = signals.expired.subscribe(() =>
      setState((current) =>
        current.status === 'authenticated'
          ? { status: 'expired', user: null, error: null, signedOut: false }
          : current,
      ),
    )
    const stopForbidden = signals.forbidden.subscribe(() => void check())
    return () => {
      stopExpired()
      stopForbidden()
    }
  }, [signals, check])

  const signIn = useCallback(
    async (username: string, password: string) => {
      if (!client) return
      const session = await client.signIn(username, password)
      setState(fromSession(session, 'anonymous'))
    },
    [client],
  )

  const signOut = useCallback(async () => {
    if (!client) return
    // Nothing of the application stays on screen while the server is being told, or if it cannot be.
    setState({ status: 'signing-out', user: null, error: null, signedOut: false })
    try {
      await client.signOut()
    } catch (error) {
      setState({
        status: 'signout-failed',
        user: null,
        error: error instanceof ApiError ? error.message : 'Cannot reach the server.',
        signedOut: false,
      })
      return
    }
    setState({ status: 'anonymous', user: null, error: null, signedOut: true })
  }, [client])

  const value = useMemo<AuthApi>(
    () => ({
      ...state,
      signIn,
      signOut,
      refresh: () => {
        if (statusRef.current === 'unreachable') setState(CHECKING)
        void check()
      },
    }),
    [state, signIn, signOut, check],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

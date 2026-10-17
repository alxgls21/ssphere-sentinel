import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AuthClient, ConsoleSession, ConsoleUser, PublishedThresholds } from '@/api/auth'
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
  /** The limits the server judges health by, from the signed-in session. */
  thresholds?: PublishedThresholds
}

/** While the server is being told to end the session, or could not be, no answer may show the app. */
const isSigningOut = (status: AuthStatus) => status === 'signing-out' || status === 'signout-failed'

const CHECKING: State = { status: 'checking', user: null, error: null, signedOut: false }

function fromSession(session: ConsoleSession, previous: AuthStatus): State {
  if (session.authenticated && session.user) {
    return {
      status: 'authenticated',
      user: session.user,
      error: null,
      signedOut: false,
      ...(session.thresholds ? { thresholds: session.thresholds } : {}),
    }
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
  // Read synchronously by async work that finishes later, so it sees the state as it is now.
  const statusRef = useRef(state.status)
  const commit = useCallback((next: State) => {
    statusRef.current = next.status
    setState(next)
  }, [])

  // Answers arrive in any order. A session check is only believed if nothing has changed since it was
  // sent: no newer check (`checkSeq`), and no sign-in, sign-out or expiry in between (`transitions`).
  const checkSeq = useRef(0)
  const transitions = useRef(0)

  const check = useCallback(
    async (signal?: AbortSignal) => {
      if (!client || isSigningOut(statusRef.current)) return
      const mine = { check: ++checkSeq.current, transition: transitions.current }
      const current = () =>
        mine.check === checkSeq.current &&
        mine.transition === transitions.current &&
        !isSigningOut(statusRef.current)
      try {
        const session = await client.getSession(signal)
        if (current()) commit(fromSession(session, statusRef.current))
      } catch (error) {
        if (signal?.aborted || !current()) return
        // A failed revalidation of a signed-in tab keeps the screen: the next data request will say more.
        if (statusRef.current === 'authenticated') return
        commit({
          status: 'unreachable',
          user: null,
          error: error instanceof ApiError ? error.message : 'Cannot reach the server.',
          signedOut: false,
        })
      }
    },
    [client, commit],
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
    const stopExpired = signals.expired.subscribe(() => {
      if (statusRef.current !== 'authenticated') return
      transitions.current += 1
      commit({ status: 'expired', user: null, error: null, signedOut: false })
    })
    const stopForbidden = signals.forbidden.subscribe(() => void check())
    return () => {
      stopExpired()
      stopForbidden()
    }
  }, [signals, check, commit])

  const signIn = useCallback(
    async (username: string, password: string) => {
      if (!client) return
      const mine = ++transitions.current
      const session = await client.signIn(username, password)
      // A sign-out or expiry that came in meanwhile has the last word.
      if (mine === transitions.current) commit(fromSession(session, 'anonymous'))
    },
    [client, commit],
  )

  const signOut = useCallback(async () => {
    if (!client) return
    const mine = ++transitions.current
    // Nothing of the application stays on screen while the server is being told, or if it cannot be.
    commit({ status: 'signing-out', user: null, error: null, signedOut: false })
    try {
      await client.signOut()
    } catch (error) {
      if (mine !== transitions.current) return
      commit({
        status: 'signout-failed',
        user: null,
        error: error instanceof ApiError ? error.message : 'Cannot reach the server.',
        signedOut: false,
      })
      return
    }
    if (mine === transitions.current) {
      commit({ status: 'anonymous', user: null, error: null, signedOut: true })
    }
  }, [client, commit])

  const value = useMemo<AuthApi>(
    () => ({
      ...state,
      thresholds: state.thresholds ?? null,
      signIn,
      signOut,
      refresh: () => {
        if (statusRef.current === 'unreachable') commit(CHECKING)
        void check()
      },
    }),
    [state, signIn, signOut, check, commit],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

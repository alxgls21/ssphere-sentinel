import { createContext, useContext } from 'react'
import type { ConsoleUser, PublishedThresholds } from '@/api/auth'

/**
 *   checking     asking the server who is signed in
 *   anonymous    nobody (never signed in, or signed out)
 *   expired      was signed in; the server no longer recognises the session
 *   denied       signed in, but the account may not use the console
 *   unreachable  the server could not be asked
 *   signing-out  the server is being told to end the session
 *   signout-failed  it could not be told: the session may still be live, so nothing is shown
 *   authenticated
 */
export type AuthStatus =
  | 'checking'
  | 'anonymous'
  | 'expired'
  | 'denied'
  | 'unreachable'
  | 'signing-out'
  | 'signout-failed'
  | 'authenticated'

export interface AuthApi {
  status: AuthStatus
  /** Set while authenticated against the real API; null in mock mode. */
  user: ConsoleUser | null
  /** The limits the server judges health by; null in mock mode and while nobody is signed in. */
  thresholds: PublishedThresholds | null
  /** True after an explicit sign-out: the sign-in page then does not remember where the user was. */
  signedOut: boolean
  /** Why the last check or sign-out failed, for the screens that say so. */
  error: string | null
  signIn: (username: string, password: string) => Promise<void>
  /** Ends the session. Never rejects: a failure is the `signout-failed` status, retried by calling this again. */
  signOut: () => Promise<void>
  /** Asks the server again (retry after "unreachable", revalidate on focus). */
  refresh: () => void
}

export const AuthContext = createContext<AuthApi | null>(null)

export function useAuth(): AuthApi {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>')
  return auth
}

/** For chrome that may render without a provider (the design gallery): nothing to show then. */
export const useOptionalAuth = (): AuthApi | null => useContext(AuthContext)

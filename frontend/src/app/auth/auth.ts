import { createContext, useContext } from 'react'
import type {
  ConsoleUser,
  FirstAdministrator,
  PublishedThresholds,
  SessionCapabilities,
} from '@/api/auth'

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
  /**
   * What the account may do, as the server last said (it asks again every minute). Nothing is
   * offered in mock mode and while nobody is signed in. It decides what a screen shows, never
   * what is allowed: the server checks every request.
   */
  capabilities: SessionCapabilities
  /** True after an explicit sign-out: the sign-in page then does not remember where the user was. */
  signedOut: boolean
  /** Why the last check or sign-out failed, for the screens that say so. */
  error: string | null
  signIn: (username: string, password: string) => Promise<void>
  /** Whether the installation has no user yet (first-run setup). False without a server (mock mode). */
  checkSetup: (signal?: AbortSignal) => Promise<boolean>
  /** Creates the first administrator, signed in on success. Rejects with the server's ApiError. */
  completeSetup: (input: FirstAdministrator) => Promise<void>
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

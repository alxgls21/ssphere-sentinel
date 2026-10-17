/**
 * Who is signed in, as the console API reports it. This is the contract the
 * app's authentication state depends on; src/api/http implements it over the
 * Django console API.
 */

export interface ConsoleUser {
  username: string
  displayName: string
}

/** The health limits the console API judges by, published with an authenticated session. */
export interface PublishedThresholds {
  resourceWarnPercent: number
  resourceCritPercent: number
  probeLossWarnPercent: number
  probeLatencyWarnMs: number
  targetCritFailures: number
}

/**
 * `reason` is only ever set on an anonymous answer: `no_console_access` means
 * the session is valid but the account may not use the console.
 */
export interface ConsoleSession {
  authenticated: boolean
  reason: 'no_console_access' | null
  user: ConsoleUser | null
  /** True when the account sees every customer (not only the ones it was granted). */
  allCustomers: boolean
  /** The limits behind the server's health verdicts. Absent for an anonymous session. */
  thresholds?: PublishedThresholds
}

export interface AuthClient {
  /** The current session. Always answers (an anonymous caller gets `authenticated: false`). */
  getSession(signal?: AbortSignal): Promise<ConsoleSession>
  /** Rejects with ApiError: 401 `invalid_credentials` (a locked account answers the same), 400 for a malformed request. */
  signIn(username: string, password: string, signal?: AbortSignal): Promise<ConsoleSession>
  /** Ends the session; resolves with the anonymous session. */
  signOut(signal?: AbortSignal): Promise<ConsoleSession>
}

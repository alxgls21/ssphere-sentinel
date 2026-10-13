type Listener = () => void

/**
 * How the HTTP layer tells the authentication state about a request that
 * failed for a session reason, without either one importing the other.
 */
export interface SessionSignals {
  /** A request answered 401 `unauthenticated`. */
  expired: { emit: Listener; subscribe: (listener: Listener) => Listener }
  /** A request answered 403 `forbidden`: the account lost console access. */
  forbidden: { emit: Listener; subscribe: (listener: Listener) => Listener }
}

function channel() {
  const listeners = new Set<Listener>()
  return {
    emit: () => listeners.forEach((listener) => listener()),
    // Returns the unsubscribe function.
    subscribe: (listener: Listener): Listener => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export const createSessionSignals = (): SessionSignals => ({
  expired: channel(),
  forbidden: channel(),
})

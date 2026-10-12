import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_POLL_MS, LiveContext, LiveStore, type LiveControls } from './live'

interface LiveProviderProps {
  children: ReactNode
  /** Override the poll interval (tests use a very large value). */
  pollMs?: number
}

/** Owns pause, refresh-now and the freshness store for every live panel. */
export function LiveProvider({ children, pollMs = DEFAULT_POLL_MS }: LiveProviderProps) {
  const [store] = useState(() => new LiveStore())

  const [paused, setPaused] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const togglePause = useCallback(() => setPaused((value) => !value), [])
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), [])

  const value = useMemo<LiveControls>(
    () => ({ pollMs, paused, togglePause, refreshToken, refresh, store }),
    [pollMs, paused, togglePause, refreshToken, refresh, store],
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

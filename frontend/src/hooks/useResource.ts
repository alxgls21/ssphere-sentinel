import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { isAbortError, toError } from '@/api/errors'

export type ResourceStatus = 'loading' | 'success' | 'error'

export interface Resource<T> {
  /**
   * loading: first load in flight. success: data present (it may be stale, see
   * `error`). error: the load failed and there is no data to show.
   */
  status: ResourceStatus
  data: T | undefined
  /** Set when the latest attempt failed. With `status: 'success'` the data shown is stale. */
  error: Error | null
  /** A reload is in flight while earlier data (if any) stays visible. */
  isRefreshing: boolean
  /** Epoch ms of the last successful load. */
  updatedAt: number | null
  refetch: () => void
}

export interface ResourceOptions {
  /** Reload this often while the tab is visible and polling is not paused. */
  refreshMs?: number
  /** Freeze polling (the in-flight request still completes). `refetch()` always works. */
  paused?: boolean
  /**
   * While the tab is hidden, keep polling at this (slower) rate instead of stopping. For the
   * resource behind the tab title and favicon: a wall of background tabs must stay true.
   */
  hiddenRefreshMs?: number
  /** On a key change, keep showing the previous data while the new key loads. */
  keepPreviousData?: boolean
}

interface State<T> {
  key: string
  data: T | undefined
  error: Error | null
  updatedAt: number | null
  fetching: boolean
}

type Action<T> =
  | { type: 'start'; key: string; keepPreviousData: boolean; manual: boolean }
  | { type: 'success'; key: string; data: T; at: number }
  | { type: 'failure'; key: string; error: Error }

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case 'start': {
      if (action.key === state.key) {
        // An explicit retry of a load that failed with nothing to show must visibly start over:
        // the error gives way to the loading state instead of staying put while the retry runs.
        const clearError = action.manual && state.data === undefined
        return { ...state, fetching: true, error: clearError ? null : state.error }
      }
      return {
        key: action.key,
        data: action.keepPreviousData ? state.data : undefined,
        error: null,
        updatedAt: action.keepPreviousData ? state.updatedAt : null,
        fetching: true,
      }
    }
    case 'success':
      return action.key === state.key
        ? { ...state, data: action.data, error: null, updatedAt: action.at, fetching: false }
        : state
    case 'failure':
      return action.key === state.key ? { ...state, error: action.error, fetching: false } : state
  }
}

/**
 * Loads one resource and keeps it fresh. `key` identifies the request (like a
 * query key): when it changes the resource reloads. `fetcher` may close over
 * anything; the latest one is always used. Failed refreshes keep the last good
 * data so a flaky API never blanks a monitoring screen.
 *
 * Small on purpose. If caching, deduplication or retries are needed later,
 * swap the body for TanStack Query behind this same signature.
 */
export function useResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  { refreshMs, paused = false, hiddenRefreshMs, keepPreviousData = false }: ResourceOptions = {},
): Resource<T> {
  const [state, dispatch] = useReducer(reducer<T>, {
    key,
    data: undefined,
    error: null,
    updatedAt: null,
    fetching: true,
  })
  const [nonce, setNonce] = useState(0)

  const fetcherRef = useRef(fetcher)
  const pausedRef = useRef(paused)
  const resumeRef = useRef<() => void>(() => {})
  const manualRef = useRef(false)
  useEffect(() => {
    fetcherRef.current = fetcher
    pausedRef.current = paused
  })

  // Un-pausing catches up with the poll that was skipped while frozen.
  useEffect(() => {
    if (!paused) resumeRef.current()
  }, [paused])

  useEffect(() => {
    let cancelled = false
    let waiting = false
    let lastLoadAt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller = new AbortController()
    const keepsPollingHidden = hiddenRefreshMs !== undefined

    const schedule = () => {
      if (refreshMs == null || cancelled) return
      const delay =
        document.hidden && keepsPollingHidden ? Math.max(refreshMs, hiddenRefreshMs) : refreshMs
      timer = setTimeout(() => {
        if (pausedRef.current || (document.hidden && !keepsPollingHidden)) waiting = true
        else void load()
      }, delay)
    }

    const load = async () => {
      lastLoadAt = Date.now()
      controller = new AbortController()
      const { signal } = controller
      const manual = manualRef.current
      manualRef.current = false
      dispatch({ type: 'start', key, keepPreviousData, manual })
      try {
        const data = await fetcherRef.current(signal)
        if (!cancelled) dispatch({ type: 'success', key, data, at: Date.now() })
      } catch (error) {
        if (!cancelled && !isAbortError(error))
          dispatch({ type: 'failure', key, error: toError(error) })
      }
      schedule()
    }

    const resume = () => {
      if (document.hidden || pausedRef.current) return
      // Back in view: catch up now if a poll was skipped, or if the slow hidden cadence left the data
      // older than the normal interval.
      const overdue = refreshMs != null && Date.now() - lastLoadAt >= refreshMs
      if (waiting || (keepsPollingHidden && overdue)) {
        waiting = false
        clearTimeout(timer)
        void load()
      }
    }
    resumeRef.current = resume

    document.addEventListener('visibilitychange', resume)
    void load()
    return () => {
      resumeRef.current = () => {}
      cancelled = true
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
    }
    // `nonce` is not read inside the effect: bumping it (refetch) restarts the effect on purpose.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [key, refreshMs, hiddenRefreshMs, keepPreviousData, nonce])

  const refetch = useCallback(() => {
    manualRef.current = true
    setNonce((n) => n + 1)
  }, [])

  // Until the effect restarts for a new key, `state.key` lags behind `key`.
  const stale = state.key !== key
  const data = stale && !keepPreviousData ? undefined : state.data
  const error = stale ? null : state.error
  const status: ResourceStatus = data !== undefined ? 'success' : error ? 'error' : 'loading'

  return {
    status,
    data,
    error,
    isRefreshing: (state.fetching || stale) && data !== undefined,
    updatedAt: stale && !keepPreviousData ? null : state.updatedAt,
    refetch,
  }
}

import { useEffect, useRef } from 'react'
import { useLive } from '@/app/live'
import { useResource, type Resource, type ResourceOptions } from './useResource'

/**
 * useResource wired into the live layer: polls at the shared interval, honors
 * pause (p) and refresh-now (r), and reports its freshness so the topbar chip,
 * status bar and verdict can tell when the screen has gone stale.
 *
 * `id` names the panel in the freshness store; `key` identifies the request
 * (include the scope and range in it).
 */
export function useLiveResource<T>(
  id: string,
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: Pick<ResourceOptions, 'keepPreviousData' | 'hiddenRefreshMs'> = {},
): Resource<T> {
  const { pollMs, paused, refreshToken, store } = useLive()
  const resource = useResource(key, fetcher, { refreshMs: pollMs, paused, ...options })
  const { refetch, updatedAt, error, isRefreshing, status } = resource

  // Refresh now: refetch whenever the shared token changes (but not on mount).
  const lastToken = useRef(refreshToken)
  useEffect(() => {
    if (lastToken.current === refreshToken) return
    lastToken.current = refreshToken
    refetch()
  }, [refreshToken, refetch])

  useEffect(() => {
    store.report(id, {
      updatedAt,
      failed: error !== null,
      fetching: isRefreshing || status === 'loading',
    })
  }, [store, id, updatedAt, error, isRefreshing, status])
  useEffect(() => () => store.remove(id), [store, id])

  return resource
}

import { useLive } from '@/app/live'
import { useResource } from './useResource'

/**
 * The short histories behind the trend marks of a list page, read on the list's own rhythm. A reading
 * that fails is only a row without a trend: it never blocks the list, raises no banner and never
 * touches the freshness of the screen. `stale` says the newest answer is not the latest asked for.
 */
export function useListSeries<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): { data: T | undefined; stale: boolean } {
  const { pollMs, paused } = useLive()
  const resource = useResource(key, load, { refreshMs: pollMs, paused, keepPreviousData: true })
  return { data: resource.data, stale: resource.error !== null }
}

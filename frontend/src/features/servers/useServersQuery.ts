import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { parseQuery, writeQuery, type ServersQuery } from './serversModel'

/**
 * Search, filter and sort live in the URL (?q=&status=&sort=&dir=), like the
 * range and scope: reload, back and a shared link show the same list.
 */
export function useServersQuery(): readonly [ServersQuery, (patch: Partial<ServersQuery>) => void] {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => parseQuery(params), [params])
  const update = useCallback(
    (patch: Partial<ServersQuery>) =>
      setParams((prev) => writeQuery(prev, { ...parseQuery(prev), ...patch }), { replace: true }),
    [setParams],
  )
  return [query, update] as const
}

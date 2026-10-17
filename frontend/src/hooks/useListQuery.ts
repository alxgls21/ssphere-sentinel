import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

/** List changes reset pagination; an explicit page patch keeps the requested page. */
export function useListQuery<Query extends { page: number }>(
  parseQuery: (params: URLSearchParams) => Query,
  writeQuery: (params: URLSearchParams, query: Query) => URLSearchParams,
): readonly [Query, (patch: Partial<Query>) => void] {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => parseQuery(params), [params, parseQuery])
  const update = useCallback(
    (patch: Partial<Query>) =>
      setParams((prev) => writeQuery(prev, { ...parseQuery(prev), page: 1, ...patch }), {
        replace: true,
      }),
    [setParams, parseQuery, writeQuery],
  )
  return [query, update] as const
}

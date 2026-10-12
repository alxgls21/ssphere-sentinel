import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

/** The query parameters that make up the operator's view (see app/viewState). */
const VIEW_PARAMS = ['range', 'customer', 'site', 'mock'] as const

/**
 * The search string to carry from one screen to the next, so going to Servers
 * keeps the scope, range and mock scenario the topbar still shows.
 */
export function useViewSearch(): string {
  const [params] = useSearchParams()
  const next = new URLSearchParams()
  for (const key of VIEW_PARAMS) {
    const value = params.get(key)
    if (value) next.set(key, value)
  }
  const text = next.toString()
  return text ? `?${text}` : ''
}

/**
 * A link target for another screen that keeps the operator's view (scope, range,
 * mock scenario). `extra` adds or replaces query parameters, e.g. { focus: id }
 * to open a screen on one entity. Use it for every in-app link: a bare path
 * silently resets the filters the topbar still shows.
 */
export function useViewTo(): (
  pathname: string,
  extra?: Readonly<Record<string, string>>,
) => { pathname: string; search: string } {
  const search = useViewSearch()
  return useCallback(
    (pathname, extra) => {
      const params = new URLSearchParams(search)
      for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)
      const text = params.toString()
      return { pathname, search: text ? `?${text}` : '' }
    },
    [search],
  )
}

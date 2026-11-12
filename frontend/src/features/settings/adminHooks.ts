import type { MouseEvent } from 'react'
import { useLocation, useNavigate, type To } from 'react-router'

/** The hooks the administration pages share (kept apart from the components for fast refresh). */

/** A row opens its record, unless the click landed on a link or a button of its own. */
export function useRowOpen() {
  const navigate = useNavigate()
  const location = useLocation()
  return (to: To) => (event: MouseEvent<HTMLTableRowElement>) => {
    const inner = (event.target as HTMLElement).closest('a,button,[tabindex]')
    if (inner && inner !== event.currentTarget && event.currentTarget.contains(inner)) return
    void navigate(to, { state: { list: location.search } })
  }
}

/** The list as it was left (search, filter, sort), carried in the history state by the row that opened a record. */
export function useListBack(pathname: string, fallback: string): To {
  const location = useLocation()
  const list = (location.state as { list?: string } | null)?.list
  return { pathname, search: list ?? fallback }
}

/** What the page that opened this one left in the history state: a creation, a deletion. */
export function useArrivalState<T extends object>(): T {
  const location = useLocation()
  return ((location.state as T | null) ?? {}) as T
}

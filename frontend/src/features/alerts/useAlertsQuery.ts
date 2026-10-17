import { useListQuery } from '@/hooks/useListQuery'
import { parseQuery, writeQuery, type AlertsQuery } from './alertsModel'

/**
 * Search, filters, sort and page live in the URL (?q=&status=&severity=&kind=&sort=&dir=&page=),
 * like the range and scope: reload, back and a shared link show the same list. Changing what the
 * list shows starts it again from the first page; only a patch that names the page keeps it.
 */
export function useAlertsQuery(): readonly [AlertsQuery, (patch: Partial<AlertsQuery>) => void] {
  return useListQuery(parseQuery, writeQuery)
}

import { useListQuery } from '@/hooks/useListQuery'
import { parseQuery, writeQuery, type SnmpQuery } from './snmpModel'

/**
 * Search, filter, sort and page live in the URL (?q=&status=&sort=&dir=&page=), like the range and
 * scope: reload, back and a shared link show the same list. Changing what the list shows starts it
 * again from the first page; only a patch that names the page keeps it.
 */
export function useSnmpQuery(): readonly [SnmpQuery, (patch: Partial<SnmpQuery>) => void] {
  return useListQuery(parseQuery, writeQuery)
}

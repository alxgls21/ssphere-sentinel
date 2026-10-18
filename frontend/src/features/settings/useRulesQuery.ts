import { useListQuery } from '@/hooks/useListQuery'
import { parseQuery, writeQuery, type RulesQuery } from './rulesModel'

/** Search, filters, sort and page live in the URL, like every list: reload, back and a shared link agree. */
export function useRulesQuery(): readonly [RulesQuery, (patch: Partial<RulesQuery>) => void] {
  return useListQuery(parseQuery, writeQuery)
}

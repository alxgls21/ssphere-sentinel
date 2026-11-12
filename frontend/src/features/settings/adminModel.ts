import type {
  AgentOption,
  CustomerRecord,
  RecordListOptions,
  RecordSortKey,
  ScopeOptions,
  SiteRecord,
  SortDirection,
} from '@/api/types'
import type { FieldSelectOption } from '@/ui/controls'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'

/**
 * What the administration lists and forms share: the query of a list of records (search, sort,
 * page), the choices a form offers (sites by customer, customers, agents by server), a whole
 * number typed into a field, and the words for what still belongs to a record. Pure, so it is
 * tested without a screen.
 */

export const ADMIN_PAGE_SIZE = 50

export interface RecordsQuery {
  q: string
  sort: RecordSortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_RECORDS_QUERY: RecordsQuery = { q: '', sort: 'name', dir: 'asc', page: 1 }
export const RECORD_SORT_KEYS: readonly RecordSortKey[] = ['name', 'created']
export const RECORD_SORT_LABEL: Record<RecordSortKey, string> = { name: 'Name', created: 'Created' }
/** Names A to Z; the most recently created first. */
export const RECORD_FIRST_DIR: Record<RecordSortKey, SortDirection> = {
  name: 'asc',
  created: 'desc',
}

export function parseRecordsQuery(params: URLSearchParams): RecordsQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(RECORD_SORT_KEYS, sort) ? sort : DEFAULT_RECORDS_QUERY.sort
  return {
    q: params.get('q') ?? '',
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : RECORD_FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeRecordsQuery(params: URLSearchParams, query: RecordsQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_RECORDS_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === RECORD_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === DEFAULT_RECORDS_QUERY.page)
  return next
}

export const nextRecordsSort = (
  query: RecordsQuery,
  key: RecordSortKey,
): Pick<RecordsQuery, 'sort' | 'dir'> => nextListSort(query, key, RECORD_FIRST_DIR)

export const recordsRequest = (query: RecordsQuery, q: string): RecordListOptions => ({
  q,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

/** The site choices: none first, then every site the account may see, named with its customer. */
export function siteChoices(scope: ScopeOptions, none: string): FieldSelectOption<string>[] {
  const customers = new Map(scope.customers.map((customer) => [customer.id, customer.name]))
  return [
    { value: '', label: none },
    ...scope.sites.map((site) => ({
      value: site.id,
      label: `${customers.get(site.customerId) ?? 'Unknown customer'} / ${site.name}`,
    })),
  ]
}

/** The customer choices: a prompt first, then every customer the account may see. */
export function customerChoices(scope: ScopeOptions): FieldSelectOption<string>[] {
  return [
    { value: '', label: 'Choose a customer' },
    ...scope.customers.map((customer) => ({ value: customer.id, label: customer.name })),
  ]
}

/** The agent choices: none first, then every agent of a visible server, named by its server, its state said. */
export function agentChoices(agents: readonly AgentOption[]): FieldSelectOption<string>[] {
  return [
    { value: '', label: 'No agent (nothing measures it)' },
    ...agents.map((agent) => ({
      value: agent.id,
      label: `${agent.serverName} (${agent.name}${agent.enabled ? '' : ', disabled'}${agent.status === 'online' ? '' : `, ${agent.status}`})`,
    })),
  ]
}

/** A whole number typed into a field, within `min` to `max`; a problem sentence otherwise. */
export function wholeField(
  text: string,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  const trimmed = text.trim()
  if (!/^\d{1,9}$/.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) {
    return { error: `Expected a whole number from ${min} to ${max}.` }
  }
  return { value: Number(trimmed) }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** "2 sites, 1 monitored domain": what still belongs to a customer, or '' when nothing does. */
export function customerHolds(record: CustomerRecord): string {
  return [
    record.sites > 0 ? plural(record.sites, 'site', 'sites') : null,
    record.domains > 0 ? plural(record.domains, 'monitored domain', 'monitored domains') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** "1 server, 3 network targets": what still belongs to a site, or '' when nothing does. */
export function siteHolds(record: SiteRecord): string {
  return [
    record.servers > 0 ? plural(record.servers, 'server', 'servers') : null,
    record.devices > 0 ? plural(record.devices, 'device', 'devices') : null,
    record.targets > 0 ? plural(record.targets, 'network target', 'network targets') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

export const tooLong = (limit: number) => `At most ${limit} characters.`

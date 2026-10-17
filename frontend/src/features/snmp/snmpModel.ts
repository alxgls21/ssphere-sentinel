import type {
  DeviceListItem,
  DeviceListOptions,
  DeviceSortKey,
  DeviceStatusFilter,
  SortDirection,
} from '@/api/types'
import { EMPTY } from '@/lib/format'
import { isCurrentDevice, responseText } from '@/lib/devices'

/**
 * What the SNMP inventory asks for and the words it uses. Pure, so it is tested without a screen.
 * Which rows, in what order and on which page is the console API's answer.
 */

export type StatusFilter = DeviceStatusFilter
export type SortKey = DeviceSortKey

export interface SnmpQuery {
  q: string
  status: StatusFilter
  sort: SortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_QUERY: SnmpQuery = {
  q: '',
  status: 'all',
  sort: 'status',
  dir: 'desc',
  page: 1,
}

/** The console API refuses a page number above this. */
export const MAX_PAGE = 10_000

/** Devices asked for at a time. The console API serves at most 200. */
export const SNMP_PAGE_SIZE = 50

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'critical',
  'warning',
  'unknown',
  'idle',
  'healthy',
]
export const SORT_KEYS: readonly SortKey[] = ['status', 'name', 'response', 'polled']

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'ALL',
  critical: 'CRIT',
  warning: 'WARN',
  unknown: 'UNKN',
  idle: 'IDLE',
  healthy: 'OK',
}

export const SORT_LABEL: Record<SortKey, string> = {
  status: 'Status',
  name: 'Device',
  response: 'Response',
  polled: 'Last poll',
}

/**
 * What a column sorts by first: the worst, the slowest, the oldest poll (`polled` descending is the
 * oldest first, the one to look at). Names read A to Z.
 */
export const FIRST_DIR: Record<SortKey, SortDirection> = {
  status: 'desc',
  name: 'asc',
  response: 'desc',
  polled: 'desc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

/** A page number from the URL: a whole number from 1, anything else is the first page. */
function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

export function parseQuery(params: URLSearchParams): SnmpQuery {
  const status = params.get('status')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(SORT_KEYS, sort) ? sort : DEFAULT_QUERY.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(STATUS_FILTERS, status) ? status : DEFAULT_QUERY.status,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeQuery(params: URLSearchParams, query: SnmpQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (name: string, value: string, isDefault: boolean) => {
    if (isDefault) next.delete(name)
    else next.set(name, value)
  }
  set('q', query.q.trim(), query.q.trim() === '')
  set('status', query.status, query.status === DEFAULT_QUERY.status)
  set('sort', query.sort, query.sort === DEFAULT_QUERY.sort)
  set('dir', query.dir, query.dir === FIRST_DIR[query.sort])
  set('page', String(query.page), query.page === DEFAULT_QUERY.page)
  return next
}

/** Clicking a column header: the same column flips direction, another starts at its natural one. */
export function nextSort(query: SnmpQuery, key: SortKey): Pick<SnmpQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

export const isDefaultView = (query: SnmpQuery): boolean =>
  query.q.trim() === '' && query.status === 'all'

/** What the request carries: the query and the debounced search. */
export const requestOf = (query: SnmpQuery, q: string): DeviceListOptions => ({
  q,
  status: query.status,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: SNMP_PAGE_SIZE,
})

/** The page of one device. A path segment, so the id is encoded. */
export const devicePath = (id: string): string => `/snmp/${encodeURIComponent(id)}`

/** The page of the server an agent runs on, for a link the API has already authorized by giving its id. */
export const agentServerPath = (serverId: string): string =>
  `/servers/${encodeURIComponent(serverId)}`

/** The response time of a row, as the present value only where the API judged the device from a current poll. */
export function responseCell(item: DeviceListItem): { text: string; note?: string } {
  if (isCurrentDevice(item) && item.reason === 'ok') return { text: responseText(item) }
  return {
    text: EMPTY,
    note:
      item.state === null
        ? 'Not a current reading: it has not been polled yet.'
        : item.reason === 'unreachable'
          ? 'No response: the latest poll could not reach the device.'
          : `Not a current reading: ${item.reason.replace('_', ' ')}.`,
  }
}

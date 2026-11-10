import { nextListSort, parseBasicListQuery, writeBasicListQuery } from '@/lib/listQuery'
export { MAX_PAGE } from '@/lib/listQuery'
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

export function parseQuery(params: URLSearchParams): SnmpQuery {
  return parseBasicListQuery(params, STATUS_FILTERS, SORT_KEYS, DEFAULT_QUERY, FIRST_DIR)
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeQuery(params: URLSearchParams, query: SnmpQuery): URLSearchParams {
  return writeBasicListQuery(params, query, DEFAULT_QUERY, FIRST_DIR)
}

/** Clicking a column header: the same column flips direction, another starts at its natural one. */
export function nextSort(query: SnmpQuery, key: SortKey): Pick<SnmpQuery, 'sort' | 'dir'> {
  return nextListSort(query, key, FIRST_DIR)
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

export { agentServerPath } from '@/lib/paths'

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

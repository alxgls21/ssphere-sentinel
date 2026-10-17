import type {
  SortDirection,
  TargetListItem,
  TargetListOptions,
  TargetSortKey,
  TargetStatusFilter,
} from '@/api/types'
import { EMPTY, formatLatency } from '@/lib/format'
import { isCurrent, lossText, measuredAgo, reasonSentence, type TargetLimits } from '@/lib/targets'

/**
 * What the Network inventory asks for and the words it uses. Pure, so it is tested without a
 * screen. Which rows, in what order and on which page is the console API's answer.
 */

export type StatusFilter = TargetStatusFilter
export type SortKey = TargetSortKey

export interface NetworkQuery {
  q: string
  status: StatusFilter
  sort: SortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_QUERY: NetworkQuery = {
  q: '',
  status: 'all',
  sort: 'status',
  dir: 'desc',
  page: 1,
}

/** The console API refuses a page number above this. */
export const MAX_PAGE = 10_000

/** Targets asked for at a time. The console API serves at most 200. */
export const NETWORK_PAGE_SIZE = 50

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'critical',
  'warning',
  'unknown',
  'idle',
  'healthy',
]
export const SORT_KEYS: readonly SortKey[] = ['status', 'name', 'latency', 'loss', 'measured']

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
  name: 'Target',
  latency: 'Latency',
  loss: 'Loss / failed',
  measured: 'Measured',
}

/**
 * What a column sorts by first: the worst, the slowest, the lossiest, the oldest measurement
 * (`measured` descending is the oldest first, the one to look at). Names read A to Z.
 */
export const FIRST_DIR: Record<SortKey, SortDirection> = {
  status: 'desc',
  name: 'asc',
  latency: 'desc',
  loss: 'desc',
  measured: 'desc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

/** A page number from the URL: a whole number from 1, anything else is the first page. */
function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

export function parseQuery(params: URLSearchParams): NetworkQuery {
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
export function writeQuery(params: URLSearchParams, query: NetworkQuery): URLSearchParams {
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
export function nextSort(query: NetworkQuery, key: SortKey): Pick<NetworkQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

export const isDefaultView = (query: NetworkQuery): boolean =>
  query.q.trim() === '' && query.status === 'all'

/** What the request carries: the query and the debounced search. */
export const requestOf = (query: NetworkQuery, q: string): TargetListOptions => ({
  q,
  status: query.status,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: NETWORK_PAGE_SIZE,
})

/** The page of one target. A path segment, so the id is encoded. */
export const targetPath = (id: string): string => `/network/${encodeURIComponent(id)}`

/** The page of the server an agent runs on, for a link the API has already authorized by giving its id. */
export const agentServerPath = (serverId: string): string =>
  `/servers/${encodeURIComponent(serverId)}`

/* -------------------------------------------------------------- the values */

/** A cell that is a current reading, or nothing and the reason why. */
export interface ReadingCell {
  text: string
  /** Why there is no current reading, and what the last measurement said. */
  note?: string
}

/** What a value the API did not judge from a current measurement says in place of one. */
function notCurrent(item: TargetListItem, nowMs: number, limits: TargetLimits): ReadingCell {
  const last = item.latest
    ? ` Last measurement ${measuredAgo(item.latest, nowMs)}: ${
        item.latest.success ? formatLatency(item.latest.latencyMs) : 'no answer'
      }, ${lossText(item.target.protocol, item.latest.lossPercent)}.`
    : ''
  return {
    text: EMPTY,
    note: `Not a current reading. ${reasonSentence(item, nowMs, limits)}${last}`,
  }
}

export function latencyCell(
  item: TargetListItem,
  nowMs: number,
  limits: TargetLimits,
): ReadingCell {
  if (!isCurrent(item) || item.latest === null) return notCurrent(item, nowMs, limits)
  return {
    text: item.latest.latencyMs === null ? 'no answer' : formatLatency(item.latest.latencyMs),
  }
}

/** `2.0% lost` for an ICMP target, `2.0% failed` for a TCP one. */
export function lossCell(item: TargetListItem, nowMs: number, limits: TargetLimits): ReadingCell {
  if (!isCurrent(item) || item.latest === null) return notCurrent(item, nowMs, limits)
  return { text: lossText(item.target.protocol, item.latest.lossPercent) }
}

/** The assigned agent as the API lets the console name it. */
export function agentText(item: TargetListItem): string {
  const { agent, agentAssigned } = item.target
  if (agent) return agent.status === 'online' ? agent.name : `${agent.name} (${agent.status})`
  return agentAssigned ? 'assigned' : 'none assigned'
}

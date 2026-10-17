import type { ServerListItem, ServerSortKey, ServerStatusFilter, SortDirection } from '@/api/types'
import { EMPTY, formatAge, formatDuration } from '@/lib/format'
import { readingOf, reportsLoad, uptimeOf } from '@/lib/serverList'
import { displayStatus, type DisplayStatus } from '@/lib/status'
import { DEFAULT_RESOURCE_LIMITS, resourceLevel, type ResourceLimits } from '@/lib/thresholds'

/**
 * What the Servers list asks for and the words it uses. Pure, so it is tested without a
 * screen. Which rows, in what order and on which page is the data source's answer (the
 * console API's; see lib/serverList for the same rules over sample data).
 */

/* ------------------------------------------------------------------- query */

export type StatusFilter = ServerStatusFilter
export type SortKey = ServerSortKey
export type SortDir = SortDirection

export interface ServersQuery {
  q: string
  status: StatusFilter
  sort: SortKey
  dir: SortDir
  /** 1-based. */
  page: number
}

export const DEFAULT_QUERY: ServersQuery = {
  q: '',
  status: 'all',
  sort: 'status',
  dir: 'desc',
  page: 1,
}

/** The console API refuses a page number above this. */
export const MAX_PAGE = 10_000

/** Servers asked for at a time. The console API serves at most 200; the list pages through them. */
export const SERVERS_PAGE_SIZE = 50

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'critical',
  'warning',
  'unknown',
  'healthy',
]
export const SORT_KEYS: readonly SortKey[] = [
  'status',
  'name',
  'cpu',
  'memory',
  'disk',
  'uptime',
  'seen',
]

export const SORT_LABEL: Record<SortKey, string> = {
  status: 'Status',
  name: 'Hostname',
  cpu: 'CPU',
  memory: 'RAM',
  disk: 'Disk',
  uptime: 'Uptime',
  seen: 'Last heartbeat',
}

/** What a column sorts by first: the worst, the biggest, the oldest. Names read A to Z. */
export const FIRST_DIR: Record<SortKey, SortDir> = {
  status: 'desc',
  name: 'asc',
  cpu: 'desc',
  memory: 'desc',
  disk: 'desc',
  uptime: 'desc',
  seen: 'desc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

/** A page number from the URL: a whole number from 1, anything else is the first page. */
function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

export function parseQuery(params: URLSearchParams): ServersQuery {
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
export function writeQuery(params: URLSearchParams, query: ServersQuery): URLSearchParams {
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
export function nextSort(query: ServersQuery, key: SortKey): Pick<ServersQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

export const isDefaultView = (query: ServersQuery): boolean =>
  query.q.trim() === '' && query.status === 'all'

/* -------------------------------------------------------------- the values */

/**
 * What the status tag shows: the health, or offline for a server whose agent stopped
 * reporting. The health still decides (the severity edge, the status filter and the sort).
 */
export const serverDisplay = (item: ServerListItem): DisplayStatus =>
  displayStatus(item.health, item.server.status === 'offline')

/**
 * The domain word for the status tag: what is wrong, not just how bad. The health is the
 * server's; the word only names what is behind it, and only from a current reading.
 */
export function stateWord(
  item: ServerListItem,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): string {
  const { server, health } = item
  if (server.status === 'offline') return 'OFFLINE'
  if (health === 'unknown') return 'UNKNOWN'
  if (health === 'healthy') return 'ONLINE'
  const telemetry = reportsLoad(item) ? server.telemetry : null
  if (telemetry) {
    const worst = (
      [
        ['HIGH CPU', telemetry.cpuPercent],
        ['HIGH MEM', telemetry.memoryPercent],
        ['DISK', telemetry.diskPercent],
      ] as const
    )
      .filter(([, percent]) => resourceLevel(percent, limits) !== 'ok')
      .sort((a, b) => b[1] - a[1])[0]
    if (worst) return worst[0]
  }
  return 'DEGRADED'
}

/** Why a server has no load figures, for the cells that would otherwise be blank. */
export function noLoadReason(item: ServerListItem): string | null {
  switch (readingOf(item)) {
    case 'current':
      return null
    case 'offline':
      return 'Offline: the agent stopped reporting, so there is no current reading.'
    case 'stale':
      return 'Stale: the newest reading is older than the offline window, so it is not shown as the present value.'
    case 'missing':
      return 'No reading yet: the agent reports, but no telemetry has arrived.'
    case 'never':
      return 'Never reported: this server is enrolled but its agent has not sent a heartbeat.'
  }
}

/** The one sentence a row shows in place of three meters. */
export function noLoadSentence(item: ServerListItem): string {
  switch (readingOf(item)) {
    case 'offline':
      return 'No current reading: the agent stopped reporting'
    case 'stale':
      return 'No current reading: the last one is stale'
    case 'missing':
      return 'No reading yet: no telemetry received'
    default:
      return 'No reading: never reported'
  }
}

export function heartbeatText(item: ServerListItem, nowMs: number): string {
  const seen = item.server.lastSeenAt
  return seen === null ? 'never' : `${formatAge(seen, nowMs)} ago`
}

export const uptimeText = (item: ServerListItem): string => {
  const seconds = uptimeOf(item)
  return seconds === null ? EMPTY : formatDuration(seconds)
}

/* ------------------------------------------------------------- search/sort */

export {
  countByHealth,
  filterServers,
  loadOf,
  matchesSearch,
  matchesStatus,
  readingOf,
  reportsLoad,
  seenAtOf,
  sortServers,
  uptimeOf,
  type Reading,
} from '@/lib/serverList'

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'ALL',
  critical: 'CRIT',
  warning: 'WARN',
  unknown: 'UNKN',
  healthy: 'OK',
}

/** The page of one server. A path segment, so the id is encoded. */
export const serverPath = (id: string): string => `/servers/${encodeURIComponent(id)}`

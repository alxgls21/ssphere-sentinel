import type { HealthStatus, ServerListItem } from '@/api/types'
import { EMPTY, formatAge, formatDuration } from '@/lib/format'
import { compareSeverity, countStatuses, displayStatus, type DisplayStatus } from '@/lib/status'
import { resourceLevel } from '@/lib/thresholds'

/**
 * Everything the Servers list decides: which rows, in what order, and the
 * words it uses. Pure, so it is tested without a screen. The data source gives
 * the whole fleet; narrowing it is the UI's job until the backend paginates.
 */

/* ------------------------------------------------------------------- query */

export type StatusFilter = 'all' | 'critical' | 'warning' | 'unknown' | 'healthy'
export type SortKey = 'status' | 'name' | 'cpu' | 'memory' | 'disk' | 'uptime' | 'seen'
export type SortDir = 'asc' | 'desc'

export interface ServersQuery {
  q: string
  status: StatusFilter
  sort: SortKey
  dir: SortDir
}

export const DEFAULT_QUERY: ServersQuery = { q: '', status: 'all', sort: 'status', dir: 'desc' }

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

/** What an offline or never-reported server still tells us: nothing about load. */
export const reportsLoad = (item: ServerListItem): boolean =>
  item.server.status === 'online' || item.server.status === 'warning'

export function loadOf(item: ServerListItem, metric: 'cpu' | 'memory' | 'disk'): number | null {
  const telemetry = item.server.telemetry
  if (!telemetry || !reportsLoad(item)) return null
  return metric === 'cpu'
    ? telemetry.cpuPercent
    : metric === 'memory'
      ? telemetry.memoryPercent
      : telemetry.diskPercent
}

export const uptimeOf = (item: ServerListItem): number | null =>
  reportsLoad(item) ? (item.server.telemetry?.uptimeSeconds ?? null) : null

export const seenAtOf = (item: ServerListItem): number | null =>
  item.server.lastSeenAt === null ? null : Date.parse(item.server.lastSeenAt)

/**
 * What the status tag shows: the health, or offline for a server whose agent stopped
 * reporting. The health still decides (the severity edge, the status filter and the sort).
 */
export const serverDisplay = (item: ServerListItem): DisplayStatus =>
  displayStatus(item.health, item.server.status === 'offline')

/** The domain word for the status tag: what is wrong, not just how bad. */
export function stateWord(item: ServerListItem): string {
  const { server, health } = item
  if (server.status === 'offline') return 'OFFLINE'
  if (health === 'unknown') return 'UNKNOWN'
  if (health === 'healthy') return 'ONLINE'
  const telemetry = server.telemetry
  if (telemetry) {
    const worst = (
      [
        ['HIGH CPU', telemetry.cpuPercent],
        ['HIGH MEM', telemetry.memoryPercent],
        ['DISK', telemetry.diskPercent],
      ] as const
    )
      .filter(([, percent]) => resourceLevel(percent) !== 'ok')
      .sort((a, b) => b[1] - a[1])[0]
    if (worst) return worst[0]
  }
  return 'DEGRADED'
}

/** Why a server has no load figures, for the cells that would otherwise be blank. */
export function noLoadReason(item: ServerListItem): string | null {
  if (reportsLoad(item)) return null
  return item.server.status === 'offline'
    ? 'Offline: the agent stopped reporting, so there is no current reading.'
    : 'Never reported: this server is enrolled but its agent has not sent a heartbeat.'
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

const haystack = (item: ServerListItem): string =>
  [
    item.server.name,
    item.server.hostname,
    item.server.ipAddress ?? '',
    item.server.operatingSystem,
    item.siteName ?? '',
    item.customerName ?? '',
  ]
    .join(' ')
    .toLowerCase()

/** Every word must appear somewhere (name, hostname, address, OS, site, customer). */
export function matchesSearch(item: ServerListItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = haystack(item)
  return words.every((word) => text.includes(word))
}

export const matchesStatus = (item: ServerListItem, filter: StatusFilter): boolean =>
  filter === 'all' || item.health === filter

export function filterServers(
  items: readonly ServerListItem[],
  query: Pick<ServersQuery, 'q' | 'status'>,
): ServerListItem[] {
  return items.filter((item) => matchesStatus(item, query.status) && matchesSearch(item, query.q))
}

function sortValue(item: ServerListItem, key: SortKey): number | null {
  switch (key) {
    case 'cpu':
      return loadOf(item, 'cpu')
    case 'memory':
      return loadOf(item, 'memory')
    case 'disk':
      return loadOf(item, 'disk')
    case 'uptime':
      return uptimeOf(item)
    case 'seen':
      // Oldest heartbeat first when "desc": the silent ones are the ones to look at.
      return seenAtOf(item) === null ? null : -(seenAtOf(item) as number)
    default:
      return null
  }
}

const byName = (a: ServerListItem, b: ServerListItem) =>
  a.server.name.localeCompare(b.server.name, 'en', { numeric: true })

/**
 * Sorted copy. Rows without a value (offline, never reported) go last in either
 * direction, so a descending CPU sort never leads with blanks. Ties fall back to
 * the name, so the order is total and stable from one refresh to the next.
 */
export function sortServers(
  items: readonly ServerListItem[],
  { sort, dir }: Pick<ServersQuery, 'sort' | 'dir'>,
): ServerListItem[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    if (sort === 'name') return sign * byName(a, b)
    if (sort === 'status') {
      // compareSeverity ranks the worst first; "desc" keeps the worst on top.
      const order = compareSeverity(a.health, b.health)
      return (dir === 'desc' ? 1 : -1) * order || byName(a, b)
    }
    const x = sortValue(a, sort)
    const y = sortValue(b, sort)
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1
    return sign * (x - y) || byName(a, b)
  })
}

export function countByHealth(items: readonly ServerListItem[]): Record<HealthStatus, number> {
  return countStatuses(items.map((item) => item.health))
}

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'ALL',
  critical: 'CRIT',
  warning: 'WARN',
  unknown: 'UNKN',
  healthy: 'OK',
}

/** The page of one server. A path segment, so the id is encoded. */
export const serverPath = (id: string): string => `/servers/${encodeURIComponent(id)}`

import type {
  HealthStatus,
  PageInfo,
  ServerList,
  ServerListItem,
  ServerListOptions,
  StatusCounts,
} from '@/api/types'
import { compareSeverity, countStatuses } from './status'

/**
 * How a server list is read and, for a source that cannot do it itself, narrowed: what a
 * reading is worth, search, status filter, order and paging. The console API does all of
 * this on the server; the sample data uses the same rules, so both answer a query alike.
 */

/**
 * What a server's resource reading is:
 *
 *   current   fresh, from a host that is reporting: the present value
 *   stale     the last one received, older than the offline window: never the present value
 *   missing   the host reports (heartbeats) but no telemetry has arrived
 *   offline   the agent stopped reporting
 *   never     enrolled, never reported
 */
export type Reading = 'current' | 'stale' | 'missing' | 'offline' | 'never'

export function readingOf(item: ServerListItem): Reading {
  const { status, telemetry } = item.server
  if (status === 'offline') return 'offline'
  if (status === 'unknown') return 'never'
  if (!telemetry) return 'missing'
  return telemetry.stale === true ? 'stale' : 'current'
}

/** Only a current reading may be shown as the present load. */
export const reportsLoad = (item: ServerListItem): boolean => readingOf(item) === 'current'

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

export const matchesStatus = (
  item: ServerListItem,
  filter: NonNullable<ServerListOptions['status']>,
): boolean => filter === 'all' || item.health === filter

export function filterServers(
  items: readonly ServerListItem[],
  query: { q: string; status: NonNullable<ServerListOptions['status']> },
): ServerListItem[] {
  return items.filter((item) => matchesStatus(item, query.status) && matchesSearch(item, query.q))
}

type SortKey = NonNullable<ServerListOptions['sort']>
type SortDir = NonNullable<ServerListOptions['dir']>

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
 * Sorted copy. Rows without a value (offline, never reported, a stale reading) go last in
 * either direction, so a descending CPU sort never leads with blanks. Ties fall back to the
 * name, so the order is total and stable from one refresh to the next.
 */
export function sortServers(
  items: readonly ServerListItem[],
  { sort, dir }: { sort: SortKey; dir: SortDir },
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

/* ------------------------------------------------------------------ paging */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

const whole = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback

/**
 * The answer to a list query over `items` (the whole scope): the requested page of what
 * matches, and the counts and totals that go with it. A page past the end is empty, as the
 * console API answers it, and still says how many pages there are.
 */
export function queryServers(
  items: readonly ServerListItem[],
  generatedAt: string,
  options: ServerListOptions = {},
): ServerList {
  const q = options.q ?? ''
  const status = options.status ?? 'all'
  const searched = items.filter((item) => matchesSearch(item, q))
  const matching = searched.filter((item) => matchesStatus(item, status))
  const ordered = sortServers(matching, {
    sort: options.sort ?? 'status',
    dir: options.dir ?? ((options.sort ?? 'status') === 'name' ? 'asc' : 'desc'),
  })
  const size = Math.min(whole(options.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const number = whole(options.page, 1)
  const counts: StatusCounts = countByHealth(searched)
  const page: PageInfo = {
    number,
    size,
    total: ordered.length,
    pages: Math.max(1, Math.ceil(ordered.length / size)),
  }
  return {
    generatedAt,
    items: ordered.slice((number - 1) * size, number * size),
    page,
    counts,
    scopeTotal: q.trim() === '' ? searched.length : items.length,
  }
}

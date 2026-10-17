import type {
  IncidentCounts,
  IncidentItem,
  IncidentEntityKind,
  IncidentKindFilter,
  IncidentListOptions,
  IncidentSeverityFilter,
  IncidentSortKey,
  IncidentStatusFilter,
  SortDirection,
} from '@/api/types'
import { EMPTY, formatAge, formatClock, type Timezone } from '@/lib/format'
import { CLOSE_REASON_TEXT, allCount, endedCount, openCount } from '@/lib/incidents'

/**
 * What the Alerts screen asks for and the words it uses. Pure, so it is tested without a screen.
 * Which incidents, in what order and on which page is the console API's answer; so are the counts
 * the status chips show.
 */

export interface AlertsQuery {
  q: string
  status: IncidentStatusFilter
  severity: IncidentSeverityFilter
  kind: IncidentKindFilter
  sort: IncidentSortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

/** The screen opens on what is open now, the worst first, the newest first among equals. */
export const DEFAULT_QUERY: AlertsQuery = {
  q: '',
  status: 'open',
  severity: 'all',
  kind: 'all',
  sort: 'severity',
  dir: 'desc',
  page: 1,
}

/** The console API refuses a page number above this. */
export const MAX_PAGE = 10_000

/** Incidents asked for at a time. The console API serves at most 200. */
export const ALERTS_PAGE_SIZE = 50

/**
 * Open is active and acknowledged together; history is recovered and closed together. Active,
 * acknowledged, recovered and closed are each one filter of their own.
 */
export const STATUS_FILTERS: readonly IncidentStatusFilter[] = [
  'open',
  'active',
  'acknowledged',
  'ended',
  'recovered',
  'closed',
  'all',
]

export const STATUS_FILTER_LABEL: Record<IncidentStatusFilter, string> = {
  open: 'OPEN',
  active: 'ACTIVE',
  acknowledged: 'ACKNOWLEDGED',
  ended: 'HISTORY',
  recovered: 'RECOVERED',
  closed: 'CLOSED',
  all: 'ALL',
}

/** What each filter holds, for the chips' titles. An acknowledged incident is open. */
export const STATUS_FILTER_HINT: Record<IncidentStatusFilter, string> = {
  open: 'Active and acknowledged: not yet ended',
  active: 'Open and not yet acknowledged',
  acknowledged: 'Seen by someone, and still open',
  ended: 'Recovered and closed',
  recovered: 'Ended: the recovery was confirmed',
  closed: 'Ended without a recovery',
  all: 'Every incident',
}

/** The number a status chip carries: the API's counts, never the rows on the page. */
export function filterCount(filter: IncidentStatusFilter, counts: IncidentCounts): number {
  switch (filter) {
    case 'open':
      return openCount(counts)
    case 'ended':
      return endedCount(counts)
    case 'all':
      return allCount(counts)
    default:
      return counts[filter]
  }
}

export const SEVERITY_FILTERS: readonly IncidentSeverityFilter[] = ['all', 'critical', 'warning']
export const SEVERITY_FILTER_LABEL: Record<IncidentSeverityFilter, string> = {
  all: 'ALL',
  critical: 'CRIT',
  warning: 'WARN',
}

export const KIND_FILTERS: readonly IncidentKindFilter[] = [
  'all',
  'server',
  'container',
  'target',
  'device',
  'interface',
]
export const KIND_FILTER_LABEL: Record<IncidentKindFilter, string> = {
  all: 'All kinds',
  server: 'Servers',
  container: 'Containers',
  target: 'Network targets',
  device: 'SNMP devices',
  interface: 'Interfaces',
}

export const SORT_KEYS: readonly IncidentSortKey[] = [
  'severity',
  'status',
  'opened',
  'started',
  'name',
]
export const SORT_LABEL: Record<IncidentSortKey, string> = {
  severity: 'Severity',
  status: 'Status',
  opened: 'Opened',
  started: 'Started',
  name: 'Entity',
}

/** What a column sorts by first: the most pressing, the newest. Names read A to Z. */
export const FIRST_DIR: Record<IncidentSortKey, SortDirection> = {
  severity: 'desc',
  status: 'desc',
  opened: 'desc',
  started: 'desc',
  name: 'asc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

/** A page number from the URL: a whole number from 1, anything else is the first page. */
function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

export function parseQuery(params: URLSearchParams): AlertsQuery {
  const status = params.get('status')
  const severity = params.get('severity')
  const kind = params.get('kind')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(SORT_KEYS, sort) ? sort : DEFAULT_QUERY.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(STATUS_FILTERS, status) ? status : DEFAULT_QUERY.status,
    severity: isOneOf(SEVERITY_FILTERS, severity) ? severity : DEFAULT_QUERY.severity,
    kind: isOneOf(KIND_FILTERS, kind) ? kind : DEFAULT_QUERY.kind,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeQuery(params: URLSearchParams, query: AlertsQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (name: string, value: string, isDefault: boolean) => {
    if (isDefault) next.delete(name)
    else next.set(name, value)
  }
  set('q', query.q.trim(), query.q.trim() === '')
  set('status', query.status, query.status === DEFAULT_QUERY.status)
  set('severity', query.severity, query.severity === DEFAULT_QUERY.severity)
  set('kind', query.kind, query.kind === DEFAULT_QUERY.kind)
  set('sort', query.sort, query.sort === DEFAULT_QUERY.sort)
  set('dir', query.dir, query.dir === FIRST_DIR[query.sort])
  set('page', String(query.page), query.page === DEFAULT_QUERY.page)
  return next
}

/** Clicking a column header: the same column flips direction, another starts at its natural one. */
export function nextSort(
  query: AlertsQuery,
  key: IncidentSortKey,
): Pick<AlertsQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

/** Nothing narrows the list beyond the screen's own opening view. */
export const isDefaultView = (query: AlertsQuery): boolean =>
  query.q.trim() === '' &&
  query.status === DEFAULT_QUERY.status &&
  query.severity === 'all' &&
  query.kind === 'all'

/** What the request carries: the query and the debounced search. */
export const requestOf = (query: AlertsQuery, q: string): IncidentListOptions => ({
  q,
  status: query.status,
  severity: query.severity,
  kind: query.kind,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ALERTS_PAGE_SIZE,
})

export const isKind = (value: string): value is IncidentEntityKind =>
  (KIND_FILTERS as readonly string[]).includes(value) && value !== 'all'

/** What happened last to an incident, in a few words and with its time: who saw it, how it ended. */
export function lastChange(item: IncidentItem, nowMs: number, tz: Timezone) {
  const ago = (iso: string | null) => (iso ? `${formatAge(iso, nowMs)} ago` : null)
  const at = (iso: string | null) => (iso ? formatClock(Date.parse(iso), tz) : undefined)
  switch (item.status) {
    case 'active':
      return { text: EMPTY, title: 'Not acknowledged yet.' }
    case 'acknowledged':
      return {
        text: `${item.acknowledgedBy ?? 'acknowledged'} · ${ago(item.acknowledgedAt) ?? EMPTY}`,
        title: `Acknowledged${item.acknowledgedBy ? ` by ${item.acknowledgedBy}` : ''} at ${at(item.acknowledgedAt) ?? EMPTY}. Still open.`,
      }
    case 'recovered':
      return {
        text: `recovered ${ago(item.recoveredAt) ?? EMPTY}`,
        title: `The recovery began at ${at(item.recoveredAt) ?? EMPTY} and was confirmed.`,
      }
    case 'closed':
      return {
        text: `closed ${ago(item.closedAt) ?? EMPTY}`,
        title:
          `${item.closeReason ? CLOSE_REASON_TEXT[item.closeReason] : 'Monitoring of it ended.'} ${at(item.closedAt) ?? ''}`.trim(),
      }
  }
}

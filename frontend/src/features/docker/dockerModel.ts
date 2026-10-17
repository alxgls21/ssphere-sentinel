import type { ContainerListItem, ContainerListOptions, SortDirection } from '@/api/types'

/**
 * What the Docker inventory asks for and the words it uses. Pure, so it is tested without a
 * screen. Which rows, in what order and on which page is the data source's answer (the console
 * API's; see lib/containerList for the same rules over sample data).
 */

/* ------------------------------------------------------------------- query */

export type StatusFilter = NonNullable<ContainerListOptions['status']>
export type SortKey = NonNullable<ContainerListOptions['sort']>

export interface DockerQuery {
  q: string
  status: StatusFilter
  sort: SortKey
  dir: SortDirection
  /** 1-based. */
  page: number
  /** Only the containers of this server (its id). */
  server: string | null
  /** A container to point at (its id, `<server id>:<Docker id>`): its server is the one shown. */
  focus: string | null
}

export const DEFAULT_QUERY: DockerQuery = {
  q: '',
  status: 'all',
  sort: 'status',
  dir: 'desc',
  page: 1,
  server: null,
  focus: null,
}

/** The console API refuses a page number above this. */
export const MAX_PAGE = 10_000

/** Containers asked for at a time. The console API serves at most 200. */
export const DOCKER_PAGE_SIZE = 50

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'critical',
  'warning',
  'unknown',
  'idle',
  'healthy',
]
export const SORT_KEYS: readonly SortKey[] = ['status', 'name', 'server', 'started']

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
  name: 'Name',
  server: 'Host',
  started: 'Started',
}

/** What a column sorts by first: the worst, the newest. Names read A to Z. */
export const FIRST_DIR: Record<SortKey, SortDirection> = {
  status: 'desc',
  name: 'asc',
  server: 'asc',
  started: 'desc',
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

/** A page number from the URL: a whole number from 1, anything else is the first page. */
function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

/** An id the console API would accept: it takes at most 36 characters of an id, and refuses the rest. */
const ID = /^[A-Za-z0-9-]{1,36}$/

/** The Docker part of a container id: `<server id>:<Docker id>`. An id without a colon is all Docker id. */
export const dockerIdOf = (id: string): string => id.slice(id.indexOf(':') + 1)

/** The server a container id names, or null when it names none. */
export function serverOfId(id: string): string | null {
  const at = id.indexOf(':')
  const server = at < 0 ? '' : id.slice(0, at)
  return ID.test(server) ? server : null
}

export function parseQuery(params: URLSearchParams): DockerQuery {
  const status = params.get('status')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const server = params.get('server')
  const focus = params.get('focus')
  const key = isOneOf(SORT_KEYS, sort) ? sort : DEFAULT_QUERY.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(STATUS_FILTERS, status) ? status : DEFAULT_QUERY.status,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : FIRST_DIR[key],
    page: wholePage(params.get('page')),
    server: server !== null && ID.test(server) ? server : null,
    focus: focus !== null && focus.length <= 200 ? focus : null,
  }
}

/** Writes a query into URL params, omitting defaults to keep links short. Other params are kept. */
export function writeQuery(params: URLSearchParams, query: DockerQuery): URLSearchParams {
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
  set('server', query.server ?? '', query.server === null)
  set('focus', query.focus ?? '', query.focus === null)
  return next
}

/** Clicking a column header: the same column flips direction, another starts at its natural one. */
export function nextSort(query: DockerQuery, key: SortKey): Pick<DockerQuery, 'sort' | 'dir'> {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: FIRST_DIR[key] }
}

/** The server whose containers are listed: the one asked for, or the one a pointed-at container runs on. */
export const serverOf = (query: DockerQuery): string | null =>
  query.server ?? (query.focus === null ? null : serverOfId(query.focus))

export const isDefaultView = (query: DockerQuery): boolean =>
  query.q.trim() === '' && query.status === 'all' && query.server === null && query.focus === null

/** What the request carries: the query, minus what only the screen uses. */
export const requestOf = (query: DockerQuery, q: string): ContainerListOptions => {
  const server = serverOf(query)
  return {
    q,
    status: query.status,
    sort: query.sort,
    dir: query.dir,
    page: query.page,
    pageSize: DOCKER_PAGE_SIZE,
    ...(server === null ? {} : { server }),
  }
}

/* -------------------------------------------------------------- the values */

/**
 * A container with no current state: the API serves `unknown` when its host is not reporting,
 * its Docker is unavailable or its Docker report is out of date, and the container list does
 * not say which. The screen says the same, and no more.
 */
export const hasNoState = (item: ContainerListItem): boolean => item.container.state === 'unknown'

export const NO_CURRENT_STATE =
  'No current state: the host is not reporting, its Docker is unavailable or its Docker report is out of date. The last stored state is not shown as current.'

/** The Docker health check as the API gives it: `none` means the image defines no check. */
export const healthText = (item: ContainerListItem): string =>
  item.container.health === 'none' ? 'no check' : item.container.health

/** The page of the server a container runs on. A path segment, so the id is encoded. */
export const hostPath = (id: string): string => `/servers/${encodeURIComponent(id)}`

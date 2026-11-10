import type { SortDirection } from '@/api/types'

/** The console API accepts pages 1 through 10,000. */
export const MAX_PAGE = 10_000

export const positiveWhole = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback

/** A page number from the URL: a whole number from 1, anything else is the first page. */
export function wholePage(value: string | null): number {
  const page = value !== null && /^\d{1,5}$/.test(value) ? Number(value) : 1
  return page >= 1 && page <= MAX_PAGE ? page : 1
}

/** The current column flips direction; a new column starts in its natural direction. */
export function nextListSort<Key extends string>(
  query: { sort: Key; dir: SortDirection },
  key: Key,
  firstDir: Record<Key, SortDirection>,
): { sort: Key; dir: SortDirection } {
  if (query.sort === key) return { sort: key, dir: query.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: key, dir: firstDir[key] }
}

export interface BasicListQuery<Status extends string, Key extends string> {
  q: string
  status: Status
  sort: Key
  dir: SortDirection
  page: number
}

export const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value)

export function setQueryParam(
  params: URLSearchParams,
  name: string,
  value: string,
  isDefault: boolean,
): void {
  if (isDefault) params.delete(name)
  else params.set(name, value)
}

export function parseBasicListQuery<Status extends string, Key extends string>(
  params: URLSearchParams,
  statuses: readonly Status[],
  keys: readonly Key[],
  defaults: BasicListQuery<Status, Key>,
  firstDir: Record<Key, SortDirection>,
): BasicListQuery<Status, Key> {
  const status = params.get('status')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(keys, sort) ? sort : defaults.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(statuses, status) ? status : defaults.status,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : firstDir[key],
    page: wholePage(params.get('page')),
  }
}

/** Write the common list fields while preserving unrelated URL parameters. */
export function writeBasicListQuery<Status extends string, Key extends string>(
  params: URLSearchParams,
  query: BasicListQuery<Status, Key>,
  defaults: BasicListQuery<Status, Key>,
  firstDir: Record<Key, SortDirection>,
): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (name: string, value: string, isDefault: boolean) =>
    setQueryParam(next, name, value, isDefault)
  set('q', query.q.trim(), query.q.trim() === '')
  set('status', query.status, query.status === defaults.status)
  set('sort', query.sort, query.sort === defaults.sort)
  set('dir', query.dir, query.dir === firstDir[query.sort])
  set('page', String(query.page), query.page === defaults.page)
  return next
}

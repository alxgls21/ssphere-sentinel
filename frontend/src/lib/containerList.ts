import type {
  ContainerList,
  ContainerListItem,
  ContainerListOptions,
  PageInfo,
  StatusCounts,
} from '@/api/types'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './serverList'
import { compareSeverity, countStatuses } from './status'

/**
 * How a container list is narrowed, ordered and paged, for a source that cannot do it itself.
 * The console API does all of this on the server; the sample data applies the same rules, so
 * both answer a query alike. Pure, and tested.
 */

type SortKey = NonNullable<ContainerListOptions['sort']>
type SortDir = NonNullable<ContainerListOptions['dir']>

const compareText = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

/** Every word must appear in the name, image, Docker id, server, site or customer name. */
export function matchesSearch(item: ContainerListItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const { container } = item
  const text = [
    container.name,
    container.image,
    container.id,
    item.serverName,
    item.siteName ?? '',
    item.customerName ?? '',
  ]
    .join('\n')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

const byName = (a: ContainerListItem, b: ContainerListItem) =>
  compareText(a.container.name, b.container.name)
const byServer = (a: ContainerListItem, b: ContainerListItem) =>
  compareText(a.serverName, b.serverName)

/**
 * Sorted copy. Containers that never started go last in either direction when sorting by
 * start. Ties fall back to the name, then the host, then the id, so the order is total and
 * stable from one refresh to the next.
 */
export function sortContainers(
  items: readonly ContainerListItem[],
  { sort, dir }: { sort: SortKey; dir: SortDir },
): ContainerListItem[] {
  const sign = dir === 'asc' ? 1 : -1
  const ties = (a: ContainerListItem, b: ContainerListItem) =>
    byName(a, b) || byServer(a, b) || compareText(a.container.id, b.container.id)
  return [...items].sort((a, b) => {
    if (sort === 'name') return sign * byName(a, b) || ties(a, b)
    if (sort === 'server') return sign * byServer(a, b) || ties(a, b)
    if (sort === 'started') {
      const x = a.container.startedAt === null ? null : Date.parse(a.container.startedAt)
      const y = b.container.startedAt === null ? null : Date.parse(b.container.startedAt)
      if (x === null || y === null) return x === y ? ties(a, b) : x === null ? 1 : -1
      return sign * (x - y) || ties(a, b)
    }
    // status: the worst first when "desc".
    return (dir === 'desc' ? 1 : -1) * compareSeverity(a.status, b.status) || ties(a, b)
  })
}

const whole = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback

/**
 * The answer to a list query over `items` (every container in the scope): the requested page of
 * what matches, and the counts and totals that go with it. A page past the end is empty, as the
 * console API answers it, and still says how many pages there are.
 */
export function queryContainers(
  items: readonly ContainerListItem[],
  generatedAt: string,
  options: ContainerListOptions = {},
): ContainerList {
  const q = options.q ?? ''
  const status = options.status ?? 'all'
  const inServer = options.server
    ? items.filter((item) => item.container.serverId === options.server)
    : items
  const searched = inServer.filter((item) => matchesSearch(item, q))
  const matching = status === 'all' ? searched : searched.filter((item) => item.status === status)
  const sort = options.sort ?? 'status'
  const dir = options.dir ?? (sort === 'status' || sort === 'started' ? 'desc' : 'asc')
  const ordered = sortContainers(matching, { sort, dir })
  const size = Math.min(whole(options.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const number = whole(options.page, 1)
  const counts: StatusCounts = countStatuses(searched.map((item) => item.status))
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
    scopeTotal: q.trim() === '' ? searched.length : inServer.length,
  }
}

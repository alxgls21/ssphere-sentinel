import { ChevronDown, ChevronUp } from 'lucide-react'
import { Link } from 'react-router'
import type { ContainerListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { containerWord, startedText } from '@/lib/containers'
import { EMPTY, formatClock, type Timezone } from '@/lib/format'
import { PlaceName } from '@/ui/PlaceName'
import { Tooltip } from '@/ui/controls'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import {
  NO_CURRENT_STATE,
  SORT_LABEL,
  dockerIdOf,
  hasNoState,
  healthText,
  hostPath,
  nextSort,
  type DockerQuery,
  type SortKey,
} from './dockerModel'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface SortHeadProps {
  sortKey: SortKey
  query: DockerQuery
  onSort: (next: Pick<DockerQuery, 'sort' | 'dir'>) => void
  className?: string
}

/** A column header that sorts: a real button inside the th, with aria-sort on the th. */
function SortHead({ sortKey, query, onSort, className }: SortHeadProps) {
  const active = query.sort === sortKey
  const Arrow = query.dir === 'asc' ? ChevronUp : ChevronDown
  return (
    <th
      scope="col"
      aria-sort={active ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(HEAD, className)}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(query, sortKey))}
        className={cn(
          'type-label inline-flex h-full items-center gap-1 rounded-sm px-1 -outline-offset-2 hover:text-fg',
          active && 'text-fg',
        )}
      >
        {SORT_LABEL[sortKey].toUpperCase()}
        <span aria-hidden="true" className="inline-block size-3">
          {active ? <Arrow className="size-3" strokeWidth={1.5} /> : null}
        </span>
      </button>
    </th>
  )
}

interface DockerTableProps {
  rows: readonly ContainerListItem[]
  query: DockerQuery
  onSort: (next: Pick<DockerQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
}

/**
 * Every container as a real table: sortable headers, 28px rows, a 2px severity edge, and the
 * state and health exactly as the API gives them. A container with no current state says
 * so in words; it is never shown with a state it may no longer have. Columns drop out with
 * the room the panel has (container query).
 */
export function DockerTable({ rows, query, onSort, nowMs, tz }: DockerTableProps) {
  const viewTo = useViewTo()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Containers" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="status" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              IMAGE
            </th>
            <SortHead sortKey="server" query={query} onSort={onSort} className="px-1" />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @5xl:table-cell')}>
              SITE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @2xl:table-cell')}>
              STATE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              HEALTH
            </th>
            <SortHead sortKey="started" query={query} onSort={onSort} className="pr-3 text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const { container } = item
            const started = container.startedAt === null ? null : Date.parse(container.startedAt)
            const age = startedText(item, nowMs)
            const unknown = hasNoState(item)
            return (
              <tr
                key={container.id}
                aria-current={query.focus === container.id ? 'true' : undefined}
                className={cn(
                  'relative h-(--row-h) transition-colors duration-(--dur-fast) hover:bg-hover',
                  query.focus === container.id && 'bg-hover',
                )}
              >
                <td className={cn(CELL, 'relative pr-2 pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.status])}
                  />
                  <StatusTag status={item.status} word={containerWord(item)} variant="tag" />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the name inside is the text */}
                <td className={cn(CELL, 'min-w-32 px-1')}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="type-data-strong min-w-0 truncate">{container.name}</span>
                    <span
                      className="type-data hidden shrink-0 text-fg-faint @6xl:inline"
                      title={container.id}
                    >
                      {dockerIdOf(container.id).slice(0, 12)}
                    </span>
                  </span>
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data hidden max-w-72 truncate px-3 text-fg-muted @4xl:table-cell',
                  )}
                  title={container.image}
                >
                  {container.image}
                </td>
                <td className={cn(CELL, 'max-w-48 px-1')}>
                  <Link
                    to={viewTo(hostPath(container.serverId))}
                    className="type-data block truncate rounded-sm -outline-offset-2 hover:underline"
                  >
                    {item.serverName}
                  </Link>
                </td>
                <td className={cn(CELL, 'hidden max-w-56 px-3 @5xl:table-cell')}>
                  {item.siteName && item.customerName ? (
                    <PlaceName
                      customer={item.customerName}
                      site={item.siteName}
                      className="type-body text-fg-muted"
                    />
                  ) : (
                    <span aria-hidden="true" className="type-data text-fg-faint">
                      {EMPTY}
                    </span>
                  )}
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 @2xl:table-cell')}>
                  {unknown ? (
                    <Tooltip content={NO_CURRENT_STATE}>
                      <span className="text-fg-muted">unknown</span>
                    </Tooltip>
                  ) : (
                    container.state
                  )}
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @3xl:table-cell')}>
                  {healthText(item)}
                </td>
                <td className={cn(CELL, 'type-data tnum pr-3 text-right')}>
                  {started === null || age === EMPTY ? (
                    <span aria-label="not known">{EMPTY}</span>
                  ) : (
                    <Tooltip content={formatClock(started, tz)}>
                      <span>{age} ago</span>
                    </Tooltip>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

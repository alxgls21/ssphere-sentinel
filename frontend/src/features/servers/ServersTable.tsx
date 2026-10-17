import { ChevronDown, ChevronUp } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { ServerListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EMPTY, formatClock, type Timezone } from '@/lib/format'
import { PlaceName } from '@/ui/PlaceName'
import { Tooltip } from '@/ui/controls'
import { useResourceLimits } from '@/ui/meters'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { LoadCell } from './LoadCell'
import {
  SORT_LABEL,
  heartbeatText,
  nextSort,
  noLoadReason,
  noLoadSentence,
  reportsLoad,
  serverPath,
  seenAtOf,
  serverDisplay,
  stateWord,
  uptimeText,
  type ServersQuery,
  type SortKey,
} from './serversModel'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface SortHeadProps {
  sortKey: SortKey
  query: ServersQuery
  onSort: (next: Pick<ServersQuery, 'sort' | 'dir'>) => void
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

interface ServersTableProps {
  rows: readonly ServerListItem[]
  query: ServersQuery
  onSort: (next: Pick<ServersQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
}

/**
 * The fleet as a real table: sortable headers, 28px rows, a 2px severity edge,
 * a link on every hostname (the row is a bigger target for the pointer). Columns
 * drop out with the room the panel has (container query), so a tablet loses
 * SITE and UPTIME before it loses a number.
 */
export function ServersTable({ rows, query, onSort, nowMs, tz }: ServersTableProps) {
  const viewTo = useViewTo()
  const navigate = useNavigate()
  const location = useLocation()
  const limits = useResourceLimits()

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Servers" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="status" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              SITE
            </th>
            <SortHead sortKey="cpu" query={query} onSort={onSort} className="w-36 @4xl:w-44" />
            <SortHead sortKey="memory" query={query} onSort={onSort} className="w-36 @4xl:w-44" />
            <SortHead sortKey="disk" query={query} onSort={onSort} className="w-36 @4xl:w-44" />
            <SortHead
              sortKey="uptime"
              query={query}
              onSort={onSort}
              className="hidden text-right @3xl:table-cell"
            />
            <SortHead sortKey="seen" query={query} onSort={onSort} className="pr-3 text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const { server } = item
            const to = viewTo(serverPath(server.id))
            const reason = noLoadReason(item)
            const seen = seenAtOf(item)
            return (
              <tr
                key={server.id}
                className="relative h-(--row-h) cursor-pointer transition-colors duration-(--dur-fast) hover:bg-hover"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('a,button')) return
                  void navigate(to, { state: { list: location.search } })
                }}
              >
                <td className={cn(CELL, 'relative pr-2 pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.health])}
                  />
                  <StatusTag
                    status={serverDisplay(item)}
                    word={stateWord(item, limits)}
                    variant="tag"
                  />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'min-w-36 px-1')}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <Link
                      to={to}
                      state={{ list: location.search }}
                      className="type-data-strong min-w-0 truncate rounded-sm -outline-offset-2 hover:underline"
                    >
                      {server.name}
                    </Link>
                    <span className="type-data hidden shrink-0 text-fg-faint @6xl:inline">
                      {server.ipAddress ?? ''}
                    </span>
                  </span>
                </td>
                <td className={cn(CELL, 'hidden max-w-56 px-3 @4xl:table-cell')}>
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
                {reportsLoad(item) ? (
                  (['cpu', 'memory', 'disk'] as const).map((metric) => (
                    <td key={metric} className={cn(CELL, 'px-3')}>
                      <LoadCell item={item} metric={metric} />
                    </td>
                  ))
                ) : (
                  // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the sentence inside is the text
                  <td colSpan={3} className={cn(CELL, 'px-3')}>
                    <Tooltip content={reason ?? ''}>
                      <span className="type-body text-fg-muted">{noLoadSentence(item)}</span>
                    </Tooltip>
                  </td>
                )}
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @3xl:table-cell')}>
                  {uptimeText(item)}
                </td>
                <td className={cn(CELL, 'type-data tnum pr-3 text-right')}>
                  {seen === null ? (
                    heartbeatText(item, nowMs)
                  ) : (
                    <Tooltip content={formatClock(seen, tz)}>
                      <span>{heartbeatText(item, nowMs)}</span>
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

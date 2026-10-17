/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A value that is not a current reading, and the status word, carry their reason in a tooltip. They
   take a tab stop so a keyboard user can open it, and name the same sentence for a screen reader. */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { TargetListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EMPTY, formatClock, type Timezone } from '@/lib/format'
import {
  PROTOCOL_LABEL,
  endpointText,
  measuredAgo,
  protocolText,
  reasonSentence,
  reasonWord,
  type TargetLimits,
} from '@/lib/targets'
import { PlaceName } from '@/ui/PlaceName'
import { Tooltip } from '@/ui/controls'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import {
  SORT_LABEL,
  agentText,
  latencyCell,
  lossCell,
  nextSort,
  targetPath,
  type NetworkQuery,
  type SortKey,
} from './networkModel'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface SortHeadProps {
  sortKey: SortKey
  query: NetworkQuery
  onSort: (next: Pick<NetworkQuery, 'sort' | 'dir'>) => void
  className?: string
  /** What the header means, where its short words do not say it. */
  title?: string
}

/** A column header that sorts: a real button inside the th, with aria-sort on the th. */
function SortHead({ sortKey, query, onSort, className, title }: SortHeadProps) {
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
        title={title}
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

/** A cell that is a current reading, or a dash with the reason in a tooltip. */
function Reading({ text, note }: { text: string; note?: string }) {
  return note ? (
    <Tooltip content={note}>
      <span tabIndex={0} aria-label={note} className="text-fg-muted">
        {text}
      </span>
    </Tooltip>
  ) : (
    <span>{text}</span>
  )
}

interface NetworkTableProps {
  rows: readonly TargetListItem[]
  query: NetworkQuery
  onSort: (next: Pick<NetworkQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
  limits: TargetLimits
}

/**
 * Every target as a real table: sortable headers, 28px rows, a 2px severity edge, a link on every
 * name. The status word is the API's reason; latency and loss are shown only where they are a
 * current reading, and the loss column is named for both protocols because the number means
 * lost packets for ICMP and failed connection attempts for TCP. Columns drop out with the room the
 * panel has (container query).
 */
export function NetworkTable({ rows, query, onSort, nowMs, tz, limits }: NetworkTableProps) {
  const viewTo = useViewTo()
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Network targets" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="status" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @2xl:table-cell')}>
              PROTOCOL
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @5xl:table-cell')}>
              SITE
            </th>
            <SortHead
              sortKey="latency"
              query={query}
              onSort={onSort}
              className="hidden text-right @xl:table-cell"
            />
            <SortHead
              sortKey="loss"
              query={query}
              onSort={onSort}
              className="hidden text-right @xl:table-cell"
              title="ICMP: probe packets lost. TCP: connection attempts that failed."
            />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              AGENT
            </th>
            <SortHead
              sortKey="measured"
              query={query}
              onSort={onSort}
              className="pr-3 text-right"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const { target } = item
            const to = viewTo(targetPath(target.id))
            const latency = latencyCell(item, nowMs, limits)
            const loss = lossCell(item, nowMs, limits)
            return (
              <tr
                key={target.id}
                className="relative h-(--row-h) cursor-pointer transition-colors duration-(--dur-fast) hover:bg-hover"
                onClick={(event) => {
                  // A link, button or tooltip trigger inside the row handles its own click.
                  const inner = (event.target as HTMLElement).closest('a,button,[tabindex]')
                  if (inner && inner !== event.currentTarget && event.currentTarget.contains(inner))
                    return
                  void navigate(to, { state: { list: location.search } })
                }}
              >
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the status word inside is the text */}
                <td className={cn(CELL, 'relative pr-2 pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.health])}
                  />
                  <Tooltip content={reasonSentence(item, nowMs, limits)}>
                    <span
                      tabIndex={0}
                      className="inline-flex"
                      aria-label={`${reasonWord(item.reason, target.protocol)}. ${reasonSentence(item, nowMs, limits)}`}
                    >
                      <StatusTag
                        status={item.health}
                        word={reasonWord(item.reason, target.protocol)}
                        variant="tag"
                      />
                    </span>
                  </Tooltip>
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'min-w-36 px-1')}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <Link
                      to={to}
                      state={{ list: location.search }}
                      className="type-data-strong min-w-0 truncate rounded-sm -outline-offset-2 hover:underline"
                    >
                      {target.name}
                    </Link>
                    <span className="type-data hidden shrink-0 text-fg-faint @6xl:inline">
                      {endpointText(item)}
                    </span>
                  </span>
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @2xl:table-cell')}>
                  <span title={PROTOCOL_LABEL[target.protocol]}>{protocolText(item)}</span>
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
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @xl:table-cell')}>
                  <Reading {...latency} />
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @xl:table-cell')}>
                  <Reading {...loss} />
                </td>
                <td className={cn(CELL, 'type-data hidden max-w-40 truncate px-3 @4xl:table-cell')}>
                  <span className={target.agent === null ? 'text-fg-muted' : undefined}>
                    {agentText(item)}
                  </span>
                </td>
                <td className={cn(CELL, 'type-data tnum pr-3 text-right')}>
                  {item.latest === null ? (
                    <span className="text-fg-muted">never</span>
                  ) : (
                    <Tooltip content={formatClock(Date.parse(item.latest.measuredAt), tz)}>
                      <span className={item.stale ? 'text-fg-muted' : undefined}>
                        {measuredAgo(item.latest, nowMs)}
                      </span>
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

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A time shown as an age carries its exact time in a tooltip. It takes a tab stop so a keyboard user
   can open it, and names the same text for a screen reader. */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { IncidentItem, IncidentSortKey } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EMPTY, formatAge, formatClock, type Timezone } from '@/lib/format'
import {
  KIND_LABEL,
  KIND_SHORT,
  conditionBrief,
  conditionText,
  incidentPath,
} from '@/lib/incidents'
import { PlaceName } from '@/ui/PlaceName'
import { Tooltip } from '@/ui/controls'
import { IncidentStatusTag, SeverityTag } from '@/ui/incidents'
import { STATUS_EDGE } from '@/ui/status'
import { AcknowledgeButton } from './AcknowledgeControls'
import { SORT_LABEL, lastChange, nextSort, type AlertsQuery } from './alertsModel'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface SortHeadProps {
  sortKey: IncidentSortKey
  label?: string
  query: AlertsQuery
  onSort: (next: Pick<AlertsQuery, 'sort' | 'dir'>) => void
  className?: string
}

/** A column header that sorts: a real button inside the th, with aria-sort on the th. */
function SortHead({
  sortKey,
  label = SORT_LABEL[sortKey],
  query,
  onSort,
  className,
}: SortHeadProps) {
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
        {label.toUpperCase()}
        <span aria-hidden="true" className="inline-block size-3">
          {active ? <Arrow className="size-3" strokeWidth={1.5} /> : null}
        </span>
      </button>
    </th>
  )
}

interface AlertsTableProps {
  rows: readonly IncidentItem[]
  query: AlertsQuery
  onSort: (next: Pick<AlertsQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
  busy: string | null
  onAcknowledge: (id: string) => void
}

/**
 * Every incident as a real table: sortable headers, 28px rows, a 2px severity edge, a link on every
 * entity name. Severity and status are separate columns: how bad it is, and where it stands. An
 * acknowledged incident reads as acknowledged and open. Times are the API's, shown as ages with the
 * exact time on hover. Columns drop out with the room the panel has (container query).
 */
export function AlertsTable({
  rows,
  query,
  onSort,
  nowMs,
  tz,
  busy,
  onAcknowledge,
}: AlertsTableProps) {
  const viewTo = useViewTo()
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Incidents" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="severity" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="status" query={query} onSort={onSort} className="px-1" />
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              <span className="@4xl:hidden">CONDITION</span>
              <span className="hidden @4xl:inline">RULE · CONDITION</span>
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @6xl:table-cell')}>
              SITE
            </th>
            <SortHead
              sortKey="opened"
              query={query}
              onSort={onSort}
              className="hidden text-right @xl:table-cell"
            />
            <SortHead
              sortKey="started"
              query={query}
              onSort={onSort}
              className="hidden text-right @7xl:table-cell"
            />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @5xl:table-cell')}>
              LATEST
            </th>
            <th scope="col" className={cn(HEAD, 'pr-3')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const to = viewTo(incidentPath(item.id))
            const latest = lastChange(item, nowMs, tz)
            return (
              <tr
                key={item.id}
                className="relative h-(--row-h) cursor-pointer transition-colors duration-(--dur-fast) hover:bg-hover"
                onClick={(event) => {
                  // A link, button or tooltip trigger inside the row handles its own click.
                  const inner = (event.target as HTMLElement).closest('a,button,[tabindex]')
                  if (inner && inner !== event.currentTarget && event.currentTarget.contains(inner))
                    return
                  void navigate(to, { state: { list: location.search } })
                }}
              >
                <td className={cn(CELL, 'relative pr-2 pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.severity])}
                  />
                  <SeverityTag severity={item.severity} />
                </td>
                <td className={cn(CELL, 'px-1')}>
                  <IncidentStatusTag status={item.status} />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'min-w-40 px-1')}>
                  <Link
                    to={to}
                    state={{ list: location.search }}
                    className="type-data-strong flex min-w-0 items-baseline gap-1.5 rounded-sm -outline-offset-2 hover:underline"
                  >
                    <span
                      title={KIND_LABEL[item.entity.kind]}
                      className="type-data shrink-0 text-fg-faint"
                    >
                      {KIND_SHORT[item.entity.kind]}
                    </span>
                    <span className="min-w-0 truncate">{item.entity.label}</span>
                  </Link>
                </td>
                <td
                  className={cn(
                    CELL,
                    'hidden max-w-52 truncate px-3 @3xl:table-cell @4xl:max-w-72',
                  )}
                >
                  <span className="type-body hidden @4xl:inline">{item.rule.name}</span>
                  <span aria-hidden="true" className="type-data hidden text-fg-faint @4xl:inline">
                    {' · '}
                  </span>
                  <span title={conditionText(item)} className="type-data text-fg-muted">
                    {conditionBrief(item)}
                  </span>
                </td>
                <td className={cn(CELL, 'hidden max-w-40 px-3 @6xl:table-cell')}>
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
                  <Tooltip content={`Opened ${formatClock(Date.parse(item.openedAt), tz)}`}>
                    <span tabIndex={0} aria-label={`Opened ${formatAge(item.openedAt, nowMs)} ago`}>
                      {formatAge(item.openedAt, nowMs)}
                    </span>
                  </Tooltip>
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @7xl:table-cell')}>
                  <Tooltip content={`Started ${formatClock(Date.parse(item.startedAt), tz)}`}>
                    <span
                      tabIndex={0}
                      aria-label={`Started ${formatAge(item.startedAt, nowMs)} ago`}
                    >
                      {formatAge(item.startedAt, nowMs)}
                    </span>
                  </Tooltip>
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data hidden max-w-40 truncate px-3 text-fg-muted @5xl:table-cell',
                  )}
                >
                  <span title={latest.title}>{latest.text}</span>
                </td>
                <td className={cn(CELL, 'pr-3 text-right')}>
                  {item.canAcknowledge ? (
                    <AcknowledgeButton
                      label={item.entity.label}
                      busy={busy === item.id}
                      onAcknowledge={() => onAcknowledge(item.id)}
                    />
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

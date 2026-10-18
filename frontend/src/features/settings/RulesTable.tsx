/* oxlint-disable jsx-a11y/no-noninteractive-tabindex --
   A time shown as an age carries its exact time in a tooltip. It takes a tab stop so a keyboard user
   can open it, and names the same text for a screen reader. */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { AlertRule, RuleSortKey } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { EMPTY, formatAge, formatClock, type Timezone } from '@/lib/format'
import { KIND_SHORT } from '@/lib/incidents'
import { Button, Tooltip } from '@/ui/controls'
import { SeverityTag } from '@/ui/incidents'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import {
  SORT_LABEL,
  TIMING_TITLE,
  conditionOf,
  nextSort,
  scopeText,
  timingOf,
  type RulesQuery,
} from './rulesModel'
import { rulePath } from './sections'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

interface SortHeadProps {
  sortKey: RuleSortKey
  query: RulesQuery
  onSort: (next: Pick<RulesQuery, 'sort' | 'dir'>) => void
  className?: string
}

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

interface RulesTableProps {
  rows: readonly AlertRule[]
  query: RulesQuery
  onSort: (next: Pick<RulesQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
  /** This account may change rules (and the rule says so too, per row). */
  mayEdit: boolean
  busy: string | null
  onToggle: (rule: AlertRule) => void
}

/**
 * Every rule as a real table: sortable headers, 28px rows, a link on each name. A rule that is off
 * is drawn apart by word and mark; the toggle is offered only for a rule this account may change.
 * Columns drop out with the room the panel has (container query).
 */
export function RulesTable({
  rows,
  query,
  onSort,
  nowMs,
  tz,
  mayEdit,
  busy,
  onToggle,
}: RulesTableProps) {
  const viewTo = useViewTo()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Alert rules" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD, 'pl-4')}>
              STATE
            </th>
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <SortHead
              sortKey="kind"
              query={query}
              onSort={onSort}
              className="hidden @5xl:table-cell"
            />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              FIRES WHEN
            </th>
            <SortHead sortKey="severity" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @7xl:table-cell')}>
              <span title={TIMING_TITLE}>DELAYS</span>
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @6xl:table-cell')}>
              SCOPE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @4xl:table-cell')}>
              OPEN
            </th>
            <SortHead
              sortKey="updated"
              query={query}
              onSort={onSort}
              className="hidden text-right @min-[90rem]:table-cell"
            />
            <th scope="col" className={cn(HEAD, 'pr-3')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rule) => {
            const to = viewTo(rulePath(rule.id))
            const may = mayEdit && rule.canEdit
            return (
              <tr
                key={rule.id}
                className="relative h-(--row-h) cursor-pointer transition-colors duration-(--dur-fast) hover:bg-hover"
                onClick={(event) => {
                  const inner = (event.target as HTMLElement).closest('a,button,[tabindex]')
                  if (inner && inner !== event.currentTarget && event.currentTarget.contains(inner))
                    return
                  void navigate(to, { state: { list: location.search } })
                }}
              >
                <td className={cn(CELL, 'relative pr-2 pl-4')}>
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute inset-y-0 left-0 w-0.5',
                      rule.enabled ? STATUS_EDGE[rule.severity] : STATUS_EDGE.idle,
                    )}
                  />
                  <StatusTag
                    status={rule.enabled ? 'healthy' : 'idle'}
                    word={rule.enabled ? 'ENABLED' : 'DISABLED'}
                    variant="tag"
                  />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-56 min-w-40 px-1')}>
                  <Link
                    to={to}
                    state={{ list: location.search }}
                    className="type-data-strong flex min-w-0 items-baseline gap-1.5 rounded-sm -outline-offset-2 hover:underline"
                  >
                    <span className="min-w-0 truncate">{rule.name}</span>
                    {rule.key ? (
                      <span
                        title={`Installed by Sentinel: ${rule.key}`}
                        className="type-data shrink-0 text-fg-faint"
                      >
                        default
                      </span>
                    ) : null}
                  </Link>
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @5xl:table-cell')}>
                  <span title={rule.kind}>{KIND_SHORT[rule.kind]}</span> {rule.kind}
                </td>
                <td
                  title={conditionOf(rule)}
                  className={cn(CELL, 'type-data hidden max-w-64 truncate px-3 @3xl:table-cell')}
                >
                  {conditionOf(rule)}
                </td>
                <td className={cn(CELL, 'px-3')}>
                  <SeverityTag severity={rule.severity} />
                </td>
                <td
                  className={cn(CELL, 'type-data tnum hidden px-3 text-fg-muted @7xl:table-cell')}
                >
                  <span title={TIMING_TITLE}>{timingOf(rule)}</span>
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-body hidden max-w-48 truncate px-3 text-fg-muted @6xl:table-cell',
                  )}
                >
                  <span title={scopeText(rule.scope)}>{scopeText(rule.scope)}</span>
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @4xl:table-cell')}>
                  {rule.openIncidents}
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data tnum hidden px-3 text-right @min-[90rem]:table-cell',
                  )}
                >
                  <Tooltip content={`Updated ${formatClock(Date.parse(rule.updatedAt), tz)}`}>
                    <span
                      tabIndex={0}
                      aria-label={`Updated ${formatAge(rule.updatedAt, nowMs)} ago`}
                    >
                      {formatAge(rule.updatedAt, nowMs)}
                    </span>
                  </Tooltip>
                </td>
                <td className={cn(CELL, 'pr-3 text-right')}>
                  {may ? (
                    <Button
                      size="sm"
                      aria-label={`${rule.enabled ? 'Disable' : 'Enable'} rule ${rule.name}`}
                      disabled={busy === rule.id}
                      aria-busy={busy === rule.id}
                      onClick={() => onToggle(rule)}
                    >
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  ) : (
                    <span aria-hidden="true" className="type-data text-fg-faint">
                      {EMPTY}
                    </span>
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

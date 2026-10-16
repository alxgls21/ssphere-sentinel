import { ChevronRight } from 'lucide-react'
import type { MouseEventHandler, ReactNode, RefObject } from 'react'
import { cn } from '@/lib/cn'
import { EMPTY, formatAge, formatClock, type Timezone } from '@/lib/format'
import { Button, Tooltip } from '@/ui/controls'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import {
  detailLead,
  displayed,
  kindLabel,
  rowKey,
  rowLabel,
  siteLabel,
  type QueueItem,
} from './queueModel'
import type { OrderLockBinding } from './useOrderLock'
import type { RowProps } from './useQueueNavigation'
import { PlaceName } from '@/ui/PlaceName'

/** Narrow containers show cards; only this many until the operator asks for all. */
const CARD_LIMIT = 5

const SITE_NOTE =
  'Servers and probe targets can be placed on a site in the admin. The sites shown here are samples.'
const NO_HISTORY =
  'No history: the backend stores no start time for this problem, only the latest sample.'

const AGE_BASIS: Record<NonNullable<QueueItem['ageBasis']>, string> = {
  'last-seen': 'Last seen',
  'failing-since': 'Failing since',
}

/*
 * Layout is container-driven, so the queue adapts to the room the Overview
 * gives it, not to the window:
 *   >= 40rem  every column
 *   <  40rem  no SITE column (it moves into the card below 28rem)
 *   <  30rem  DETAIL keeps only its lead phrase
 *   <  28rem  two-line cards (the same table, reflowed: the rows stay rows)
 */

const HEAD_CELL =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'

const CELL =
  'border-b border-border whitespace-nowrap @max-md:block @max-md:min-w-0 @max-md:border-0 @max-md:p-0'

interface QueueTableProps {
  rows: readonly QueueItem[]
  showSite: boolean
  /** The snapshot's own clock: ages are relative to when the data was made, so a frozen table stays consistent. */
  nowMs: number
  tz: Timezone
  activeIndex: number
  /** Rows that appeared critical since the previous snapshot. */
  newKeys: ReadonlySet<string>
  expanded: boolean
  onExpand: MouseEventHandler<HTMLButtonElement>
  scrollerRef: RefObject<HTMLDivElement | null>
  rowProps: (index: number) => RowProps
  /** Focus and pointer handlers for the order lock. */
  lock: OrderLockBinding
}

/**
 * The queue as a real table: 24px sticky header, 28px rows that scroll inside
 * the panel, one tab stop (the selected row) and a 2px severity edge at x=0.
 * Sorting is the API's; rows are drawn in the order given.
 */
export function QueueTable({
  rows,
  showSite,
  nowMs,
  tz,
  activeIndex,
  newKeys,
  expanded,
  onExpand,
  scrollerRef,
  rowProps,
  lock,
}: QueueTableProps) {
  const hasMore = !expanded && rows.length > CARD_LIMIT
  return (
    // The rows are the focusable elements; these handlers only watch where focus and the pointer are.
    <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto" {...lock}>
      <table
        aria-label="Needs attention"
        className="w-full border-separate border-spacing-0 @max-md:block"
      >
        <thead className="@max-md:hidden">
          <tr>
            <th scope="col" className={cn(HEAD_CELL, 'w-px pr-2 pl-5')}>
              SEV
            </th>
            <th scope="col" className={cn(HEAD_CELL, 'w-px px-1')}>
              ENTITY
            </th>
            <th scope="col" className={cn(HEAD_CELL, 'px-3')}>
              DETAIL
            </th>
            {showSite ? (
              <th scope="col" className={cn(HEAD_CELL, 'px-3 @min-md:@max-[40rem]:hidden')}>
                SITE
                <Tooltip content={SITE_NOTE}>
                  <button
                    type="button"
                    aria-label="Sample data"
                    className="cursor-help rounded-sm px-0.5 focus-visible:-outline-offset-2"
                  >
                    †
                  </button>
                </Tooltip>
              </th>
            ) : null}
            <th scope="col" className={cn(HEAD_CELL, 'px-3 text-right')}>
              AGE
            </th>
          </tr>
        </thead>
        <tbody className="@max-md:block">
          {rows.map((item, index) => {
            const key = rowKey(item)
            const selected = index === activeIndex
            const site = siteLabel(item)
            const lead = detailLead(item.detail)
            return (
              <tr
                key={key}
                aria-label={rowLabel(item, index + 1, rows.length, nowMs)}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'relative h-(--row-h) cursor-pointer scroll-mt-6 focus-visible:-outline-offset-2',
                  selected ? 'bg-primary-tint' : 'hover:bg-hover',
                  'transition-colors duration-(--dur-fast)',
                  '@max-md:grid @max-md:h-auto @max-md:grid-cols-[auto_minmax(0,1fr)_auto] @max-md:items-center @max-md:gap-x-2 @max-md:gap-y-1',
                  '@max-md:border-b @max-md:border-border @max-md:py-2 @max-md:pr-3 @max-md:pl-5',
                  !expanded && index >= CARD_LIMIT && '@max-md:hidden',
                )}
                {...rowProps(index)}
              >
                <td className={cn(CELL, 'pr-2 pl-5 @max-md:col-start-1 @max-md:row-start-1')}>
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.severity])}
                  />
                  {selected ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute top-1/2 left-0.5 size-4 -translate-y-1/2 text-primary"
                      strokeWidth={1.5}
                    />
                  ) : null}
                  {newKeys.has(key) ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 animate-crit-in"
                    />
                  ) : null}
                  <StatusTag status={displayed(item)} word={item.stateLabel} variant="tag" />
                </td>
                <td
                  className={cn(
                    CELL,
                    'px-1 @max-md:col-span-2 @max-md:col-start-2 @max-md:row-start-1',
                  )}
                >
                  <span className="block max-w-60 truncate @max-md:max-w-none">
                    <span className="type-data inline-block w-[4ch] text-fg-faint">
                      {kindLabel(item)}
                    </span>{' '}
                    <span className="type-data-strong" title={item.name}>
                      {item.name}
                    </span>
                  </span>
                </td>
                <td
                  className={cn(
                    CELL,
                    'w-full max-w-0 px-3 @max-md:col-start-1 @max-md:row-start-2 @max-md:w-auto @max-md:max-w-none',
                    // Card: line 1 severity + entity, line 2 detail + age, line 3 the (sample) site.
                    '@max-md:col-span-2',
                  )}
                >
                  <span className="type-body block truncate text-fg-muted" title={item.detail}>
                    {lead}
                    <span className="@min-md:@max-[30rem]:hidden">
                      {item.detail.slice(lead.length)}
                    </span>
                  </span>
                </td>
                {showSite ? (
                  <td
                    className={cn(
                      CELL,
                      'px-3 @min-md:@max-[40rem]:hidden @max-md:col-span-3 @max-md:col-start-1 @max-md:row-start-3 @max-md:px-0',
                      !site && '@max-md:hidden',
                    )}
                  >
                    {site ? (
                      <PlaceName
                        customer={item.customerName ?? ''}
                        site={item.siteName ?? ''}
                        className="type-body max-w-56 text-fg-muted @max-md:max-w-none @max-md:text-fg-faint"
                      />
                    ) : (
                      <span aria-hidden="true" className="type-data text-fg-faint @max-md:hidden">
                        {EMPTY}
                      </span>
                    )}
                  </td>
                ) : null}
                <td
                  className={cn(
                    CELL,
                    'px-3 text-right @max-md:col-start-3 @max-md:row-start-2 @max-md:px-0',
                  )}
                >
                  <Age item={item} nowMs={nowMs} tz={tz} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {hasMore ? (
        <div className="hidden p-3 @max-md:block">
          <Button className="w-full" onClick={onExpand}>
            View all {rows.length}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Age({ item, nowMs, tz }: { item: QueueItem; nowMs: number; tz: Timezone }): ReactNode {
  if (!item.ageIso) {
    return (
      <Tooltip content={NO_HISTORY}>
        <span className="type-data text-fg-faint">
          <span aria-hidden="true">{EMPTY}</span>
          <span className="sr-only">no history</span>
        </span>
      </Tooltip>
    )
  }
  const at = formatClock(Date.parse(item.ageIso), tz)
  const since = `${item.ageBasis ? AGE_BASIS[item.ageBasis] : 'Since'} ${at}`
  return (
    <Tooltip content={since}>
      <span className="type-data tnum text-fg-faint">{formatAge(item.ageIso, nowMs)}</span>
    </Tooltip>
  )
}

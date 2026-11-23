import { useEffect } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { DeliveryItem, DeliverySortKey, DeliveryStatus } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { formatInteger, type Timezone } from '@/lib/format'
import { incidentPath } from '@/lib/incidents'
import { Button, Chip, SearchField, Select } from '@/ui/controls'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { createSortHead } from '@/ui/SortHead'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { AgeCell, CELL, HEAD, NotPermitted, ROW, SEARCH_SETTLE_MS } from './AdminParts'
import {
  DELIVERY_HEALTH,
  DELIVERY_SORT_LABEL,
  DELIVERY_STATUSES,
  DELIVERY_WORD,
  KIND_WORD,
  deliveriesRequest,
  deliverySentence,
  nextDeliveriesSort,
  parseDeliveriesQuery,
  writeDeliveriesQuery,
  type DeliveriesQuery,
} from './deliveriesModel'
import { userPath } from './sections'

const SortHead = createSortHead<DeliverySortKey, DeliveriesQuery>(
  DELIVERY_SORT_LABEL,
  nextDeliveriesSort,
)

function Recipient({ item }: { item: DeliveryItem }) {
  const viewTo = useViewTo()
  const { recipient } = item
  return recipient.id === null ? (
    <span title="The account no longer exists">{recipient.username}</span>
  ) : (
    <Link
      to={viewTo(userPath(recipient.id))}
      className="rounded-sm text-primary underline underline-offset-2"
    >
      {recipient.username}
    </Link>
  )
}

function IncidentLink({ item }: { item: DeliveryItem }) {
  const viewTo = useViewTo()
  return (
    <Link
      to={viewTo(incidentPath(item.incident.id))}
      className="min-w-0 truncate rounded-sm text-primary underline underline-offset-2"
    >
      {item.incident.ruleName}
    </Link>
  )
}

function DeliveriesTable({
  rows,
  query,
  onSort,
  nowMs,
  tz,
}: {
  rows: readonly DeliveryItem[]
  query: DeliveriesQuery
  onSort: (next: Pick<DeliveriesQuery, 'sort' | 'dir'>) => void
  nowMs: number
  tz: Timezone
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Incident emails" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="status" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="recipient" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'px-3')}>
              INCIDENT
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              WHAT BECAME OF IT
            </th>
            <SortHead sortKey="created" query={query} onSort={onSort} className="pr-3 text-right" />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id} className={cn(ROW, 'cursor-default')}>
              <td className={cn(CELL, 'pr-2 pl-4')}>
                <StatusTag
                  status={DELIVERY_HEALTH[item.status]}
                  word={DELIVERY_WORD[item.status]}
                  variant="tag"
                />
              </td>
              <td className={cn(CELL, 'type-data max-w-40 truncate px-3')}>
                <Recipient item={item} />
              </td>
              <td className={cn(CELL, 'max-w-72 px-3')}>
                <span className="flex min-w-0 flex-col">
                  <IncidentLink item={item} />
                  <span className="type-data truncate text-fg-faint">
                    {KIND_WORD[item.kind]} · {item.incident.entityLabel}
                  </span>
                </span>
              </td>
              <td
                className={cn(
                  CELL,
                  'type-body hidden max-w-96 truncate px-3 text-fg-muted @3xl:table-cell',
                )}
                title={deliverySentence(item, tz, nowMs)}
              >
                {deliverySentence(item, tz, nowMs)}
              </td>
              <td className={cn(CELL, 'type-data tnum pr-3 text-right')}>
                <AgeCell iso={item.createdAt} nowMs={nowMs} tz={tz} what="Created" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DeliveriesCards({
  rows,
  nowMs,
  tz,
}: {
  rows: readonly DeliveryItem[]
  nowMs: number
  tz: Timezone
}) {
  return (
    <ul aria-label="Incident emails" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => (
        <li
          key={item.id}
          className="flex flex-col gap-1 border-b border-border py-2.5 pr-3 pl-4 last:border-b-0"
        >
          <span className="flex flex-wrap items-center gap-2">
            <StatusTag
              status={DELIVERY_HEALTH[item.status]}
              word={DELIVERY_WORD[item.status]}
              variant="tag"
            />
            <span className="type-data min-w-0 truncate">
              <Recipient item={item} />
            </span>
          </span>
          <span className="type-body flex min-w-0 gap-1">
            <IncidentLink item={item} />
            <span className="type-data shrink-0 text-fg-faint">· {KIND_WORD[item.kind]}</span>
          </span>
          <span className="type-body text-fg-muted">{deliverySentence(item, tz, nowMs)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Email log: every incident email, what became of it and why one did not go, searched,
 * filtered by state and kind, sorted and paged by the server. Offered to administrators only. It names
 * the recipient but never an address (the email does not record which one it went to; the account's page
 * has it), and a failure is a category in the server's words, never a mail server's message. Test emails
 * are not here: each account sees its own.
 */
export default function EmailLogPage() {
  const api = useApi()
  const { capabilities } = useAuth()
  const { tz } = usePrefs()
  const [query, update] = useListQuery(parseDeliveriesQuery, writeDeliveriesQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.viewDeliveryLog

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = deliveriesRequest(query, search)
  const resource = useResource(
    `deliveries:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listDeliveries({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  const list = resource.data ?? undefined
  const rows = list?.items ?? []
  const nowMs = list ? Date.parse(list.generatedAt) : 0
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="read the email log"
        hint="The log names every customer's incidents and every recipient, so the console offers it to administrators only. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const narrowed = query.incident !== '' || query.recipient !== ''
  const clear = () => update({ q: '', status: 'all', kind: 'all', incident: '', recipient: '' })
  const total = list
    ? DELIVERY_STATUSES.reduce((sum, status) => sum + list.counts[status], 0)
    : undefined

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Email log</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
      </header>

      {narrowed ? (
        <p className="type-body flex flex-wrap items-center gap-2 text-fg-muted">
          {query.incident !== ''
            ? 'Only the emails of one incident.'
            : 'Only the emails to one account.'}
          <Button size="sm" onClick={() => update({ incident: '', recipient: '' })}>
            Show all emails
          </Button>
        </p>
      ) : null}

      <search aria-label="Filter emails" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search emails"
          placeholder="Search recipient, rule, object"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by state</legend>
          <Chip
            pressed={query.status === 'all'}
            onPressedChange={() => update({ status: 'all' })}
            count={total}
          >
            ALL
          </Chip>
          {DELIVERY_STATUSES.map((status: DeliveryStatus) => (
            <Chip
              key={status}
              pressed={query.status === status}
              onPressedChange={(pressed) => update({ status: pressed ? status : 'all' })}
              count={list?.counts[status]}
            >
              {DELIVERY_WORD[status]}
            </Chip>
          ))}
        </fieldset>
        <Select
          label="Kind"
          value={query.kind}
          onChange={(kind) => update({ kind })}
          options={[
            { value: 'all', label: 'Opened and recovered' },
            { value: 'opened', label: 'Opened' },
            { value: 'recovered', label: 'Recovered' },
          ]}
        />
      </search>

      <Panel
        title="Incident emails"
        features="settings"
        scope="NOW"
        count={list ? matching : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && list !== undefined}
        error={resource.error}
        updatedAt={resource.updatedAt}
        onRetry={resource.refetch}
        isEmpty={nothingThere || noMatch}
        empty={
          nothingThere ? (
            <EmptyState
              title="No emails"
              hint="An email is queued when an incident opens or recovers and an account asks for it."
            />
          ) : (
            <EmptyState
              title="No email matches"
              hint={
                <>
                  Nothing matches the search and filters.{' '}
                  <Button size="sm" onClick={clear} className="ml-1">
                    Clear filters
                  </Button>
                </>
              }
            />
          )
        }
        skeleton={<ListSkeleton />}
        footer={
          <>
            <span className="truncate">
              {list
                ? `Kept for ${list.retentionDays} days. No address is recorded: the account’s page has its address. Test emails are not listed.`
                : null}
            </span>
            {list && list.page.pages > 1 ? (
              <Pager
                page={list.page}
                shown={rows.length}
                onPage={(number) => update({ page: number })}
              />
            ) : null}
          </>
        }
        flush
        className="min-h-[20rem] flex-1"
      >
        {wide ? (
          <DeliveriesTable rows={rows} query={query} onSort={update} nowMs={nowMs} tz={tz} />
        ) : (
          <DeliveriesCards rows={rows} nowMs={nowMs} tz={tz} />
        )}
      </Panel>
    </div>
  )
}

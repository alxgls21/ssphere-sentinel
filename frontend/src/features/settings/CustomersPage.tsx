import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { CustomerRecord, RecordSortKey } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import { Button, SearchField } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { createSortHead } from '@/ui/SortHead'
import { EmptyState } from '@/ui/states'
import {
  AgeCell,
  CELL,
  FlashNotice,
  HEAD,
  NAME_LINK,
  ROW,
  SEARCH_SETTLE_MS,
  NotPermitted,
  type Flash,
} from './AdminParts'
import { useArrivalState, useRowOpen } from './adminHooks'
import {
  RECORD_SORT_LABEL,
  nextRecordsSort,
  parseRecordsQuery,
  recordsRequest,
  writeRecordsQuery,
  type RecordsQuery,
} from './adminModel'
import { NEW_CUSTOMER_PATH, customerPath } from './sections'

const SortHead = createSortHead<RecordSortKey, RecordsQuery>(RECORD_SORT_LABEL, nextRecordsSort)

function CustomersTable({
  rows,
  query,
  onSort,
  nowMs,
}: {
  rows: readonly CustomerRecord[]
  query: RecordsQuery
  onSort: (next: Pick<RecordsQuery, 'sort' | 'dir'>) => void
  nowMs: number
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  const open = useRowOpen()
  const { tz } = usePrefs()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Customers" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="name" query={query} onSort={onSort} className="pl-4" />
            <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
              SITES
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @2xl:table-cell')}>
              SERVERS
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @2xl:table-cell')}>
              DEVICES
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @3xl:table-cell')}>
              TARGETS
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 text-right @3xl:table-cell')}>
              DOMAINS
            </th>
            <th scope="col" className={cn(HEAD, 'hidden max-w-64 px-3 @4xl:table-cell')}>
              NOTES
            </th>
            <SortHead
              sortKey="created"
              query={query}
              onSort={onSort}
              className="hidden pr-3 text-right @5xl:table-cell"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((customer) => {
            const to = viewTo(customerPath(customer.id))
            return (
              <tr key={customer.id} className={ROW} onClick={open(to)}>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-72 min-w-40 pr-2 pl-4')}>
                  <Link to={to} state={{ list: location.search }} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{customer.name}</span>
                  </Link>
                </td>
                <td className={cn(CELL, 'type-data tnum px-3 text-right')}>{customer.sites}</td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @2xl:table-cell')}>
                  {customer.servers}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @2xl:table-cell')}>
                  {customer.devices}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @3xl:table-cell')}>
                  {customer.targets}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden px-3 text-right @3xl:table-cell')}>
                  {customer.domains}
                </td>
                <td
                  title={customer.notes}
                  className={cn(
                    CELL,
                    'type-body hidden max-w-64 truncate px-3 text-fg-muted @4xl:table-cell',
                  )}
                >
                  {customer.notes}
                </td>
                <td className={cn(CELL, 'type-data tnum hidden pr-3 text-right @5xl:table-cell')}>
                  <AgeCell iso={customer.createdAt} nowMs={nowMs} tz={tz} what="Created" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CustomersCards({ rows }: { rows: readonly CustomerRecord[] }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Customers" className="min-h-0 flex-1 overflow-auto">
      {rows.map((customer) => (
        <li key={customer.id} className="border-b border-border last:border-b-0">
          <Link
            to={viewTo(customerPath(customer.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="type-data-strong min-w-0 truncate">{customer.name}</span>
            <span className="type-data text-fg-faint">
              {customer.sites} sites · {customer.servers} servers · {customer.devices} devices ·{' '}
              {customer.targets} targets · {customer.domains} domains
            </span>
            {customer.notes ? (
              <span className="type-body truncate text-fg-muted">{customer.notes}</span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Customers & sites: every customer the account may see, searched, sorted and paged by
 * the server, with what belongs to each. A customer opens on its own page, where its sites are.
 */
export default function CustomersPage() {
  const api = useApi()
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseRecordsQuery, writeRecordsQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.manageCustomers
  const arrival = useArrivalState<{ deleted?: string }>()
  const [flash, setFlash] = useState<Flash | null>(() =>
    arrival.deleted ? { tone: 'ok', text: `The customer “${arrival.deleted}” is deleted.` } : null,
  )

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = recordsRequest(query, search)
  const resource = useResource(
    `customers:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listCustomers({ ...asked, signal }) : null),
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
        what="change customers and sites"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on customers and sites, with access to every customer. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Customers & sites</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
        <Link to={viewTo(NEW_CUSTOMER_PATH)} className={`${buttonStyle('primary')} ml-auto`}>
          New customer
        </Link>
      </header>

      <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />

      <search aria-label="Filter customers" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search customers"
          placeholder="Search name, notes"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
      </search>

      <Panel
        title="Customers"
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
              title="No customers"
              hint="Everything monitored belongs to a customer's site: add the first customer, then its sites."
            />
          ) : (
            <EmptyState
              title="No customer matches"
              hint={
                <>
                  Nothing matches the search.{' '}
                  <Button size="sm" onClick={() => update({ q: '' })} className="ml-1">
                    Clear search
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
              A customer with sites or domains is not deleted: nothing goes along with it.
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
          <CustomersTable rows={rows} query={query} onSort={update} nowMs={nowMs} />
        ) : (
          <CustomersCards rows={rows} />
        )}
      </Panel>
    </div>
  )
}

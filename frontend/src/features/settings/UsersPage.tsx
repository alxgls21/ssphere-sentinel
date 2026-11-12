import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Account, AccountActiveFilter, AccountSortKey } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { EMPTY, formatInteger } from '@/lib/format'
import { Button, Chip, SearchField } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { createSortHead } from '@/ui/SortHead'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { AgeCell, CELL, HEAD, NAME_LINK, NotPermitted, ROW, SEARCH_SETTLE_MS } from './AdminParts'
import { useRowOpen } from './adminHooks'
import {
  ACTIVE_FILTERS,
  ACTIVE_LABEL,
  ROLE_LABEL,
  USER_SORT_LABEL,
  nextUsersSort,
  parseUsersQuery,
  scopeText,
  usersRequest,
  writeUsersQuery,
  type UsersQuery,
} from './usersModel'
import { NEW_USER_PATH, userPath } from './sections'

const SortHead = createSortHead<AccountSortKey, UsersQuery>(USER_SORT_LABEL, nextUsersSort)

function StateTags({ account }: { account: Account }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusTag
        status={account.active ? 'healthy' : 'idle'}
        word={account.active ? 'ACTIVE' : 'INACTIVE'}
        variant="tag"
      />
      {account.locked ? <StatusTag status="warning" word="LOCKED" variant="tag" /> : null}
      {account.self ? <StatusTag status="unknown" word="YOU" variant="tag" /> : null}
    </span>
  )
}

function UsersTable({
  rows,
  query,
  onSort,
  nowMs,
}: {
  rows: readonly Account[]
  query: UsersQuery
  onSort: (next: Pick<UsersQuery, 'sort' | 'dir'>) => void
  nowMs: number
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  const open = useRowOpen()
  const { tz } = usePrefs()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Accounts" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="username" query={query} onSort={onSort} className="pl-4" />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @2xl:table-cell')}>
              NAME
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              EMAIL
            </th>
            <th scope="col" className={cn(HEAD, 'px-3')}>
              ROLE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              SEES
            </th>
            <th scope="col" className={cn(HEAD, 'px-3')}>
              STATE
            </th>
            <SortHead
              sortKey="lastLogin"
              query={query}
              onSort={onSort}
              className="hidden pr-3 text-right @5xl:table-cell"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((account) => {
            const to = viewTo(userPath(account.id))
            return (
              <tr key={account.id} className={ROW} onClick={open(to)}>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-56 min-w-32 pr-2 pl-4')}>
                  <Link to={to} state={{ list: location.search }} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{account.username}</span>
                  </Link>
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-body hidden max-w-48 truncate px-3 text-fg-muted @2xl:table-cell',
                  )}
                >
                  {[account.firstName, account.lastName].filter(Boolean).join(' ') || EMPTY}
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data hidden max-w-56 truncate px-3 text-fg-muted @4xl:table-cell',
                  )}
                >
                  {account.email || EMPTY}
                </td>
                <td className={cn(CELL, 'type-data px-3')}>
                  {account.role ? ROLE_LABEL[account.role] : 'No console access'}
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @3xl:table-cell')}>
                  {scopeText(account)}
                </td>
                <td className={cn(CELL, 'px-3')}>
                  <StateTags account={account} />
                </td>
                <td className={cn(CELL, 'type-data tnum hidden pr-3 text-right @5xl:table-cell')}>
                  {account.lastLoginAt ? (
                    <AgeCell iso={account.lastLoginAt} nowMs={nowMs} tz={tz} what="Signed in" />
                  ) : (
                    'never'
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

function UsersCards({ rows }: { rows: readonly Account[] }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Accounts" className="min-h-0 flex-1 overflow-auto">
      {rows.map((account) => (
        <li key={account.id} className="border-b border-border last:border-b-0">
          <Link
            to={viewTo(userPath(account.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="type-data-strong min-w-0 truncate">{account.username}</span>
              <StateTags account={account} />
            </span>
            <span className="type-data text-fg-faint">
              {account.role ? ROLE_LABEL[account.role] : 'No console access'} · {scopeText(account)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Users & access: every account, searched, filtered, sorted and paged by the server,
 * with its role, what it sees and whether it is locked. Offered to administrators only.
 */
export default function UsersPage() {
  const api = useApi()
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseUsersQuery, writeUsersQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.manageUsers

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = usersRequest(query, search)
  const resource = useResource(
    `users:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listUsers({ ...asked, signal }) : null),
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
        what="manage accounts"
        hint="Accounts, roles, grants, passwords and lockouts are offered to administrators only. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const noMatch = list !== undefined && matching === 0
  const clear = () => update({ q: '', active: 'all' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Users & access</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
        <Link to={viewTo(NEW_USER_PATH)} className={`${buttonStyle('primary')} ml-auto`}>
          New user
        </Link>
      </header>

      <search aria-label="Filter accounts" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search accounts"
          placeholder="Search user name, name, email"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by state</legend>
          {ACTIVE_FILTERS.map((filter: AccountActiveFilter) => (
            <Chip
              key={filter}
              pressed={query.active === filter}
              onPressedChange={(pressed) => update({ active: pressed ? filter : 'all' })}
              count={
                list
                  ? filter === 'all'
                    ? list.counts.active + list.counts.inactive
                    : list.counts[filter]
                  : undefined
              }
            >
              {ACTIVE_LABEL[filter]}
            </Chip>
          ))}
        </fieldset>
      </search>

      <Panel
        title="Accounts"
        features="settings"
        scope="NOW"
        count={list ? matching : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && list !== undefined}
        error={resource.error}
        updatedAt={resource.updatedAt}
        onRetry={resource.refetch}
        isEmpty={noMatch}
        empty={
          <EmptyState
            title="No account matches"
            hint={
              <>
                Nothing matches the search and filter.{' '}
                <Button size="sm" onClick={clear} className="ml-1">
                  Clear filters
                </Button>
              </>
            }
          />
        }
        skeleton={<ListSkeleton />}
        footer={
          <>
            <span className="truncate">
              Accounts are deactivated, never deleted: the audit trail refers to them.
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
          <UsersTable rows={rows} query={query} onSort={update} nowMs={nowMs} />
        ) : (
          <UsersCards rows={rows} />
        )}
      </Panel>
    </div>
  )
}

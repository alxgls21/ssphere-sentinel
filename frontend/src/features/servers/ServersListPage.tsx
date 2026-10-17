import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import type { PageInfo } from '@/api/types'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { scopeKey, useScope } from '@/app/viewState'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useLiveResource } from '@/hooks/useLiveResource'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { formatInteger } from '@/lib/format'
import { Panel } from '@/ui/Panel'
import { Button, Chip, SearchField, Select, type SelectOption } from '@/ui/controls'
import { limitsOrigin, useResourceLimits } from '@/ui/meters'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusGlyph } from '@/ui/status'
import { ServerCards } from './ServerCards'
import { ServersTable } from './ServersTable'
import {
  FILTER_LABEL,
  FIRST_DIR,
  SORT_KEYS,
  SERVERS_PAGE_SIZE,
  SORT_LABEL,
  STATUS_FILTERS,
  isDefaultView,
  serverPath,
  type SortKey,
  type StatusFilter,
} from './serversModel'
import { useServersQuery } from './useServersQuery'

const SORT_OPTIONS: readonly SelectOption<SortKey>[] = SORT_KEYS.map((key) => ({
  value: key,
  label: SORT_LABEL[key],
}))

const FILTER_GLYPH: Partial<Record<StatusFilter, 'critical' | 'warning' | 'unknown' | 'healthy'>> =
  { critical: 'critical', warning: 'warning', unknown: 'unknown', healthy: 'healthy' }

const SKELETON_ROWS = 8

function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center px-3">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

/** How long the search must hold still before it is asked for: a request per keystroke is noise. */
const SEARCH_SETTLE_MS = 250

interface PagerProps {
  page: PageInfo
  shown: number
  onPage: (number: number) => void
}

/** Where this page sits among the matches, and the way to the others. */
function Pager({ page, shown, onPage }: PagerProps) {
  const first = (page.number - 1) * page.size + 1
  const last = first + shown - 1
  return (
    <nav aria-label="Pages" className="ml-auto flex shrink-0 items-center gap-2">
      <span className="type-data tnum" aria-live="polite">
        {shown > 0 ? `${first}–${last} of ${formatInteger(page.total)} · ` : ''}
        page {page.number} of {page.pages}
      </span>
      <Button size="sm" disabled={page.number <= 1} onClick={() => onPage(page.number - 1)}>
        Previous
      </Button>
      <Button
        size="sm"
        disabled={page.number >= page.pages}
        onClick={() => onPage(page.number + 1)}
      >
        Next
      </Button>
    </nav>
  )
}

/**
 * Servers: every monitored host, worst first, a page at a time. Search, status filter,
 * sort and page live in the URL; the console API does the narrowing, ordering and paging,
 * and its counts and totals are what the chips and the header say.
 */
export default function ServersListPage() {
  const api = useApi()
  const { pollMs } = useLive()
  const { tz } = usePrefs()
  const [scope] = useScope()
  const viewTo = useViewTo()
  const [params] = useSearchParams()
  const [query, update] = useServersQuery()
  const wide = useMediaQuery('(min-width: 48rem)')
  const limits = useResourceLimits()

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = {
    q: search,
    status: query.status,
    sort: query.sort,
    dir: query.dir,
    page: query.page,
  }
  const resource = useLiveResource(
    'servers',
    `servers:${scopeKey(scope)}:${JSON.stringify(asked)}`,
    (signal) => api.listServers({ scope, ...asked, pageSize: SERVERS_PAGE_SIZE, signal }),
    // A new query or scope keeps the previous rows, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const list = resource.data
  const rows = list?.items ?? []
  const nowMs = list ? Date.parse(list.generatedAt) : 0

  // A page past the last (matches went away while the list was open, or a stale link): go to the last one.
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  // The Overview's queue opens an entity with ?focus=<id>: a server has a page of its own.
  const focus = params.get('focus')
  if (focus) {
    return <Navigate replace to={viewTo(serverPath(focus))} />
  }

  const matching = list?.page.total ?? 0
  const nothingMonitored =
    resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', status: 'all' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="type-title">Servers</h1>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
      </header>

      <search aria-label="Filter servers" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search servers"
          placeholder="Search name, address, OS, site"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by status</legend>
          {STATUS_FILTERS.map((filter) => {
            const glyph = FILTER_GLYPH[filter]
            return (
              <Chip
                key={filter}
                pressed={query.status === filter}
                onPressedChange={(pressed) => update({ status: pressed ? filter : 'all' })}
                count={
                  list
                    ? filter === 'all'
                      ? sumCounts(list.counts)
                      : list.counts[filter]
                    : undefined
                }
                leading={glyph ? <StatusGlyph status={glyph} size={10} /> : undefined}
              >
                {FILTER_LABEL[filter]}
              </Chip>
            )
          })}
        </fieldset>
        {/* A table sorts from its headers; a card list has none, so it gets a menu. */}
        {wide ? null : (
          <Select
            label="Sort by"
            value={query.sort}
            onChange={(sort) => update({ sort, dir: FIRST_DIR[sort] })}
            options={SORT_OPTIONS}
            className="ml-auto"
          />
        )}
      </search>

      <Panel
        index={1}
        title="Servers"
        features="servers"
        scope="NOW"
        refreshMs={pollMs}
        count={list ? matching : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && list !== undefined}
        error={resource.error}
        updatedAt={resource.updatedAt}
        onRetry={resource.refetch}
        isEmpty={nothingMonitored || noMatch}
        empty={
          nothingMonitored ? (
            <EmptyState
              title="No servers monitored"
              hint="Install the agent on a host and it appears here after its first heartbeat."
            />
          ) : (
            <EmptyState
              title="No server matches"
              hint={
                <>
                  Nothing in this scope matches the search and filter.{' '}
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
              cell = 10% · warn at {limits.warn} · crit at {limits.crit} · {limitsOrigin(limits)}
            </span>
            {isDefaultView(query) ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={clear}
                className={list && list.page.pages > 1 ? undefined : 'ml-auto'}
              >
                Clear filters
              </Button>
            )}
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
          <ServersTable rows={rows} query={query} onSort={update} nowMs={nowMs} tz={tz} />
        ) : (
          <ServerCards rows={rows} nowMs={nowMs} />
        )}
      </Panel>
    </div>
  )
}

const sumCounts = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0)

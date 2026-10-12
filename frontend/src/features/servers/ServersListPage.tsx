import { useMemo } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { scopeKey, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { Panel } from '@/ui/Panel'
import { Button, Chip, SearchField, Select, type SelectOption } from '@/ui/controls'
import { EmptyState, Skeleton } from '@/ui/states'
import { StatusGlyph } from '@/ui/status'
import { ServerCards } from './ServerCards'
import { ServersTable } from './ServersTable'
import {
  FILTER_LABEL,
  FIRST_DIR,
  SORT_KEYS,
  SORT_LABEL,
  STATUS_FILTERS,
  countByHealth,
  filterServers,
  isDefaultView,
  serverPath,
  sortServers,
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

const FOOTER_NOTE = 'cell = 10% · warn at 80 · crit at 95 · UI defaults'

/**
 * Servers: every monitored host, worst first. Search, status filter and sort
 * live in the URL. Mock data until the backend has a read API (it already
 * stores every number shown here, one latest row per server).
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

  const resource = useLiveResource(
    'servers',
    `servers:${scopeKey(scope)}`,
    (signal) => api.listServers({ scope, signal }),
    // A scope change keeps the previous rows, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const items = resource.data?.items
  const nowMs = resource.data ? Date.parse(resource.data.generatedAt) : 0

  const rows = useMemo(
    () => (items ? sortServers(filterServers(items, query), query) : []),
    [items, query],
  )
  // The chip counts follow the search, not the status chip: they say what each chip would show.
  const counts = useMemo(
    () => countByHealth(items ? filterServers(items, { q: query.q, status: 'all' }) : []),
    [items, query.q],
  )

  // The Overview's queue opens an entity with ?focus=<id>: a server has a page of its own.
  const focus = params.get('focus')
  if (focus?.startsWith('srv-')) {
    return <Navigate replace to={viewTo(serverPath(focus))} />
  }

  const total = items?.length ?? 0
  const nothingMonitored = resource.status === 'success' && total === 0
  const noMatch = items !== undefined && total > 0 && rows.length === 0
  const clear = () => update({ q: '', status: 'all' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="type-title">Servers</h1>
        <p className="type-data text-fg-muted" aria-live="polite">
          {items ? `${rows.length} of ${total} shown` : null}
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
                count={items ? (filter === 'all' ? sumCounts(counts) : counts[filter]) : undefined}
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
        count={items ? rows.length : undefined}
        status={resource.status}
        refreshing={resource.isRefreshing && items !== undefined}
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
            <span className="truncate">{FOOTER_NOTE}</span>
            {isDefaultView(query) ? null : (
              <Button size="sm" variant="ghost" onClick={clear} className="ml-auto">
                Clear filters
              </Button>
            )}
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

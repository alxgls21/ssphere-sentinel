import { useEffect } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { useViewTo } from '@/app/viewSearch'
import { scopeKey, useScope } from '@/app/viewState'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useLiveResource } from '@/hooks/useLiveResource'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { formatInteger } from '@/lib/format'
import { Button, Chip, SearchField, Select, type SelectOption } from '@/ui/controls'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { StatusGlyph } from '@/ui/status'
import { NetworkCards } from './NetworkCards'
import { NetworkTable } from './NetworkTable'
import {
  FILTER_LABEL,
  FIRST_DIR,
  SORT_KEYS,
  SORT_LABEL,
  STATUS_FILTERS,
  isDefaultView,
  requestOf,
  type SortKey,
  targetPath,
  type StatusFilter,
} from './networkModel'
import { useNetworkQuery } from './useNetworkQuery'
import { useTargetLimits } from './useTargetLimits'

const SORT_OPTIONS: readonly SelectOption<SortKey>[] = SORT_KEYS.map((key) => ({
  value: key,
  label: SORT_LABEL[key],
}))

const FILTER_GLYPH: Partial<
  Record<StatusFilter, 'critical' | 'warning' | 'unknown' | 'idle' | 'healthy'>
> = {
  critical: 'critical',
  warning: 'warning',
  unknown: 'unknown',
  idle: 'idle',
  healthy: 'healthy',
}

/** How long the search must hold still before it is asked for: a request per keystroke is noise. */
const SEARCH_SETTLE_MS = 250

const sumCounts = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0)

/**
 * Network: every probe target in scope, worst first, a page at a time. Search, status filter, sort
 * and page live in the URL; the console API does the narrowing, ordering and paging, and its counts
 * and totals are what the chips and the header say. Health and its reason are the API's: a target
 * with no current measurement shows none of the numbers a reading would, and says why.
 */
export default function NetworkPage() {
  const api = useApi()
  const { pollMs } = useLive()
  const { tz } = usePrefs()
  const [scope] = useScope()
  const [query, update] = useNetworkQuery()
  const wide = useMediaQuery('(min-width: 48rem)')
  const limits = useTargetLimits()
  const viewTo = useViewTo()
  const [params] = useSearchParams()

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = requestOf(query, search)
  const resource = useLiveResource(
    'network',
    `network:${scopeKey(scope)}:${JSON.stringify(asked)}`,
    (signal) => api.listTargets({ scope, ...asked, signal }),
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

  // The Overview's queue opens a target with ?focus=<id>: a target has a page of its own.
  const focus = params.get('focus')
  if (focus) {
    return <Navigate replace to={viewTo(targetPath(focus))} />
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', status: 'all' })
  const unobserved = list?.counts.unknown ?? 0

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="type-title">Network</h1>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
      </header>

      <search aria-label="Filter targets" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search targets"
          placeholder="Search name, address, circuit, site"
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
        title="Targets"
        features="network"
        scope="NOW"
        refreshMs={pollMs}
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
              title="No network targets"
              hint="No probe target in this scope is configured. Add one in the admin and assign it an agent, and it appears here."
            />
          ) : (
            <EmptyState
              title="No target matches"
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
            {unobserved > 0 ? (
              <span className="truncate">
                {formatInteger(unobserved)} unknown: no agent, agent offline, no measurement or an
                out-of-date one
              </span>
            ) : null}
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
          <NetworkTable
            rows={rows}
            query={query}
            onSort={update}
            nowMs={nowMs}
            tz={tz}
            limits={limits}
          />
        ) : (
          <NetworkCards rows={rows} nowMs={nowMs} limits={limits} />
        )}
      </Panel>
    </div>
  )
}

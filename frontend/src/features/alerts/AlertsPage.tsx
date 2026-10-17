import { useEffect } from 'react'
import { useApi } from '@/api/context'
import type {
  IncidentKindFilter,
  IncidentSeverityFilter,
  IncidentSortKey,
  IncidentStatusFilter,
} from '@/api/types'
import { useAlerts } from '@/app/alerts'
import { useLive } from '@/app/live'
import { usePrefs } from '@/app/prefs'
import { scopeKey, useScope } from '@/app/viewState'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useLiveResource } from '@/hooks/useLiveResource'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { formatInteger } from '@/lib/format'
import { Button, Chip, SearchField, Select, type SelectOption } from '@/ui/controls'
import { EngineStatusBanner } from '@/ui/incidents'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { StatusGlyph } from '@/ui/status'
import { AckNoticeLine } from './AcknowledgeControls'
import { useAcknowledge } from './acknowledge'
import { AlertsCards } from './AlertsCards'
import { AlertsTable } from './AlertsTable'
import {
  FIRST_DIR,
  KIND_FILTERS,
  KIND_FILTER_LABEL,
  SEVERITY_FILTERS,
  SEVERITY_FILTER_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  STATUS_FILTERS,
  STATUS_FILTER_HINT,
  STATUS_FILTER_LABEL,
  filterCount,
  isDefaultView,
  requestOf,
} from './alertsModel'
import { useAlertsQuery } from './useAlertsQuery'

const SORT_OPTIONS: readonly SelectOption<IncidentSortKey>[] = SORT_KEYS.map((key) => ({
  value: key,
  label: SORT_LABEL[key],
}))

const KIND_OPTIONS: readonly SelectOption<IncidentKindFilter>[] = KIND_FILTERS.map((kind) => ({
  value: kind,
  label: KIND_FILTER_LABEL[kind],
}))

/** How long the search must hold still before it is asked for: a request per keystroke is noise. */
const SEARCH_SETTLE_MS = 250

const SEVERITY_GLYPH = { critical: 'critical', warning: 'warning' } as const

/**
 * Alerts: the incidents the alert engine opened in scope. Open ones (active and acknowledged) come
 * first, the worst first; history is one chip away. Search, filters, sort and page live in the URL;
 * the console API does the narrowing, ordering and paging, and its counts and totals are what the
 * chips and the header say. An acknowledged incident is still open. The engine's own state sits
 * above the list, so an empty list from an engine that is not running is not read as good news.
 */
export default function AlertsPage() {
  const api = useApi()
  const { pollMs } = useLive()
  const { tz } = usePrefs()
  const [scope] = useScope()
  const [query, update] = useAlertsQuery()
  const alerts = useAlerts()
  const wide = useMediaQuery('(min-width: 48rem)')

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = requestOf(query, search)
  const resource = useLiveResource(
    'alerts',
    `alerts:${scopeKey(scope)}:${JSON.stringify(asked)}`,
    (signal) => api.listIncidents({ scope, ...asked, signal }),
    // A new query or scope keeps the previous rows, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const list = resource.data
  const rows = list?.items ?? []
  const nowMs = list ? Date.parse(list.generatedAt) : 0

  // Whatever came of an attempt, what is on screen may have changed: read it again, and the shell's count.
  const ack = useAcknowledge({
    onSettled: () => {
      resource.refetch()
      alerts?.overview.refetch()
    },
  })

  // A page past the last (matches went away while the list was open, or a stale link): go to the last one.
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', status: 'open', severity: 'all', kind: 'all' })
  const engineWord = alerts?.engine.data?.state
  const engineNotRunning = engineWord !== undefined && engineWord !== 'running'
  const engineUnknown = alerts !== null && alerts.engine.data === undefined

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="type-title">Alerts</h1>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
      </header>

      {alerts ? <EngineStatusBanner resource={alerts.engine} /> : null}
      <AckNoticeLine notice={ack.notice} onDismiss={ack.dismiss} />

      <search aria-label="Filter incidents" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            label="Search incidents"
            placeholder="Search object, rule, site, customer"
            value={query.q}
            onChange={(q) => update({ q })}
            className="w-full sm:w-80"
          />
          <Select
            label="Kind"
            value={query.kind}
            onChange={(kind) => update({ kind })}
            options={KIND_OPTIONS}
          />
          <fieldset className="flex min-w-0 flex-wrap gap-1">
            <legend className="sr-only">Filter by severity</legend>
            {SEVERITY_FILTERS.map((filter: IncidentSeverityFilter) => {
              const glyph = filter === 'all' ? undefined : SEVERITY_GLYPH[filter]
              return (
                <Chip
                  key={filter}
                  pressed={query.severity === filter}
                  onPressedChange={(pressed) => update({ severity: pressed ? filter : 'all' })}
                  leading={glyph ? <StatusGlyph status={glyph} size={10} /> : undefined}
                >
                  {SEVERITY_FILTER_LABEL[filter]}
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
        </div>
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by status</legend>
          {STATUS_FILTERS.map((filter: IncidentStatusFilter) => (
            <Chip
              key={filter}
              title={STATUS_FILTER_HINT[filter]}
              pressed={query.status === filter}
              onPressedChange={(pressed) =>
                update({ status: pressed ? filter : filter === 'open' ? 'all' : 'open' })
              }
              count={list ? filterCount(filter, list.counts) : undefined}
            >
              {STATUS_FILTER_LABEL[filter]}
            </Chip>
          ))}
        </fieldset>
      </search>

      <Panel
        index={1}
        title="Incidents"
        features="alerts"
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
              title="No incidents"
              hint={
                engineNotRunning || engineUnknown
                  ? 'No incident has been recorded in this scope. The alert engine is not confirmed to be running, so this does not mean everything is healthy.'
                  : 'No incident has been recorded in this scope.'
              }
            />
          ) : isDefaultView(query) ? (
            <EmptyState
              title="No open incidents"
              hint={
                <>
                  Every incident in this scope has ended.
                  {engineNotRunning || engineUnknown
                    ? ' The alert engine is not confirmed to be running, so none may be opening.'
                    : ''}{' '}
                  <Button size="sm" onClick={() => update({ status: 'ended' })} className="ml-1">
                    Show history
                  </Button>
                </>
              }
            />
          ) : (
            <EmptyState
              title="No incident matches"
              hint={
                <>
                  Nothing in this scope matches the search and filters.{' '}
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
            <span className="truncate">An acknowledged incident is still open.</span>
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
          <AlertsTable
            rows={rows}
            query={query}
            onSort={update}
            nowMs={nowMs}
            tz={tz}
            busy={ack.busy}
            onAcknowledge={(id) => void ack.acknowledge(id)}
          />
        ) : (
          <AlertsCards
            rows={rows}
            nowMs={nowMs}
            busy={ack.busy}
            onAcknowledge={(id) => void ack.acknowledge(id)}
          />
        )}
      </Panel>
    </div>
  )
}

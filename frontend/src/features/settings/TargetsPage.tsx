import { useContext, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { TargetListItem } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useViewTo } from '@/app/viewSearch'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useListQuery } from '@/hooks/useListQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useResource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { describeWriteFailure } from '@/lib/forms'
import { EMPTY, formatInteger } from '@/lib/format'
import { Button, SearchField } from '@/ui/controls'
import { buttonStyle } from '@/ui/controls/buttonStyle'
import { ListSkeleton, Pager } from '@/ui/ListParts'
import { Panel } from '@/ui/Panel'
import { createSortHead } from '@/ui/SortHead'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import {
  CELL,
  FlashNotice,
  HEAD,
  NAME_LINK,
  NotPermitted,
  ROW,
  SEARCH_SETTLE_MS,
  type Flash,
} from './AdminParts'
import { useArrivalState, useRowOpen } from './adminHooks'
import { NEW_TARGET_PATH, targetEditorPath } from './sections'
import {
  TARGETS_SORT_LABEL,
  endpointWord,
  nextTargetsSort,
  parseTargetsQuery,
  targetsRequest,
  writeTargetsQuery,
  type TargetsQuery,
  type TargetsSortKey,
} from './targetsModel'

const SortHead = createSortHead<TargetsSortKey, TargetsQuery>(TARGETS_SORT_LABEL, nextTargetsSort)

function placeOf(item: TargetListItem): string {
  return item.customerName && item.siteName ? `${item.customerName} / ${item.siteName}` : 'No site'
}

function TargetsTable({
  rows,
  query,
  onSort,
  busy,
  onToggle,
}: {
  rows: readonly TargetListItem[]
  query: TargetsQuery
  onSort: (next: Pick<TargetsQuery, 'sort' | 'dir'>) => void
  busy: string | null
  onToggle: (item: TargetListItem) => void
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  const open = useRowOpen()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Network targets" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <SortHead sortKey="status" query={query} onSort={onSort} className="pl-4" />
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'px-3')}>
              ADDRESS
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @2xl:table-cell')}>
              PROBE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              SITE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              AGENT
            </th>
            <th scope="col" className={cn(HEAD, 'pr-3')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const { target } = item
            const to = viewTo(targetEditorPath(target.id))
            return (
              <tr key={target.id} className={ROW} onClick={open(to)}>
                <td className={cn(CELL, 'pr-2 pl-4')}>
                  <StatusTag
                    status={target.enabled ? 'healthy' : 'idle'}
                    word={target.enabled ? 'ENABLED' : 'DISABLED'}
                    variant="tag"
                  />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-56 min-w-32 px-1')}>
                  <Link to={to} state={{ list: location.search }} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{target.name}</span>
                  </Link>
                </td>
                <td className={cn(CELL, 'type-data max-w-56 truncate px-3 text-fg-muted')}>
                  {target.address}
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 @2xl:table-cell')}>
                  {endpointWord(target)} · every {target.intervalSeconds}s
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-body hidden max-w-48 truncate px-3 text-fg-muted @3xl:table-cell',
                  )}
                >
                  {placeOf(item)}
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data hidden max-w-48 truncate px-3 text-fg-muted @4xl:table-cell',
                  )}
                >
                  {target.agent
                    ? target.agent.serverName
                    : target.agentAssigned
                      ? 'Not visible'
                      : EMPTY}
                </td>
                <td className={cn(CELL, 'pr-3 text-right')}>
                  <Button
                    size="sm"
                    aria-label={`${target.enabled ? 'Disable' : 'Enable'} target ${target.name}`}
                    disabled={busy === target.id}
                    aria-busy={busy === target.id}
                    onClick={() => onToggle(item)}
                  >
                    {target.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TargetsCards({
  rows,
  busy,
  onToggle,
}: {
  rows: readonly TargetListItem[]
  busy: string | null
  onToggle: (item: TargetListItem) => void
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Network targets" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => (
        <li key={item.target.id} className="border-b border-border last:border-b-0">
          <Link
            to={viewTo(targetEditorPath(item.target.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex flex-wrap items-center gap-2">
              <StatusTag
                status={item.target.enabled ? 'healthy' : 'idle'}
                word={item.target.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              <span className="type-data-strong min-w-0 truncate">{item.target.name}</span>
            </span>
            <span className="type-data text-fg-faint">
              {endpointWord(item.target)} {item.target.address} · {placeOf(item)}
            </span>
          </Link>
          <div className="pr-3 pb-2.5 pl-4">
            <Button
              size="sm"
              aria-label={`${item.target.enabled ? 'Disable' : 'Enable'} target ${item.target.name}`}
              disabled={busy === item.target.id}
              onClick={() => onToggle(item)}
            >
              {item.target.enabled ? 'Disable' : 'Enable'}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Network targets: every target the account may see, searched, sorted and paged by the
 * server (the Network list, unscoped), each switched on or off from here and opened on its own
 * page to be changed or deleted. What the agents measure is on the Network screen.
 */
export default function TargetsPage() {
  const api = useApi()
  const shell = useContext(ShellContext)
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseTargetsQuery, writeTargetsQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.manageTargets
  const arrival = useArrivalState<{ deleted?: string }>()
  const [flash, setFlash] = useState<Flash | null>(() =>
    arrival.deleted
      ? { tone: 'ok', text: `The target “${arrival.deleted}” is deleted, with its history.` }
      : null,
  )
  const [busy, setBusy] = useState<string | null>(null)

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = targetsRequest(query, search)
  const resource = useResource(
    `targets-admin:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listTargets({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  const list = resource.data ?? undefined
  const rows = list?.items ?? []
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const toggle = async (item: TargetListItem) => {
    const enabled = !item.target.enabled
    setBusy(item.target.id)
    setFlash(null)
    try {
      await api.updateTarget(item.target.id, { enabled })
      const text = `“${item.target.name}” is ${enabled ? 'enabled: its agent probes it again' : 'disabled: nothing probes it, and an incident of it ends'}.`
      setFlash({ tone: 'ok', text })
      shell?.announce(text)
    } catch (error) {
      const failure = describeWriteFailure(error, [])
      setFlash({
        tone: 'error',
        text:
          [...failure.general, failure.message].filter(Boolean).join(' ') ||
          'The change could not be saved.',
      })
      shell?.announce('The target was not changed.')
    } finally {
      setBusy(null)
      resource.refetch()
    }
  }

  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="change network targets"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on network targets, with access to every customer. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Network targets</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
        <Link to={viewTo(NEW_TARGET_PATH)} className={`${buttonStyle('primary')} ml-auto`}>
          New target
        </Link>
      </header>

      <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />

      <search aria-label="Filter network targets" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search network targets"
          placeholder="Search name, address, circuit, site, customer"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
      </search>

      <Panel
        title="Targets"
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
              title="No network targets"
              hint="Add a target, assign the agent that probes it, and put its entry in that agent's targets file."
            />
          ) : (
            <EmptyState
              title="No target matches"
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
              The agent reads its targets from its own file: a change here needs the entry on the
              host too.
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
          <TargetsTable
            rows={rows}
            query={query}
            onSort={update}
            busy={busy}
            onToggle={(item) => void toggle(item)}
          />
        ) : (
          <TargetsCards rows={rows} busy={busy} onToggle={(item) => void toggle(item)} />
        )}
      </Panel>
    </div>
  )
}

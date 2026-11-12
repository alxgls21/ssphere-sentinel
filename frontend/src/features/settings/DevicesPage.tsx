import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { InventoryDevice, InventorySnmpFilter, InventorySortKey } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
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
import {
  DEVICE_SORT_LABEL,
  SNMP_FILTERS,
  SNMP_FILTER_LABEL,
  TYPE_LABEL,
  devicesRequest,
  nextDevicesSort,
  parseDevicesQuery,
  snmpText,
  writeDevicesQuery,
  type DevicesQuery,
} from './devicesModel'
import { NEW_DEVICE_PATH, deviceEditorPath } from './sections'

const SortHead = createSortHead<InventorySortKey, DevicesQuery>(DEVICE_SORT_LABEL, nextDevicesSort)

const placeOf = (device: InventoryDevice): string =>
  device.customerName && device.siteName ? `${device.customerName} / ${device.siteName}` : 'No site'

function DevicesTable({
  rows,
  query,
  onSort,
}: {
  rows: readonly InventoryDevice[]
  query: DevicesQuery
  onSort: (next: Pick<DevicesQuery, 'sort' | 'dir'>) => void
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  const open = useRowOpen()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Devices" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD, 'pl-4')}>
              STATE
            </th>
            <SortHead sortKey="name" query={query} onSort={onSort} />
            <SortHead
              sortKey="type"
              query={query}
              onSort={onSort}
              className="hidden @2xl:table-cell"
            />
            <SortHead sortKey="address" query={query} onSort={onSort} />
            <th scope="col" className={cn(HEAD, 'hidden px-3 @3xl:table-cell')}>
              SITE
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @4xl:table-cell')}>
              SNMP
            </th>
            <th scope="col" className={cn(HEAD, 'hidden pr-3 @5xl:table-cell')}>
              AGENT
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((device) => {
            const to = viewTo(deviceEditorPath(device.id))
            return (
              <tr key={device.id} className={ROW} onClick={open(to)}>
                <td className={cn(CELL, 'pr-2 pl-4')}>
                  <StatusTag
                    status={device.enabled ? 'healthy' : 'idle'}
                    word={device.enabled ? 'ENABLED' : 'DISABLED'}
                    variant="tag"
                  />
                </td>
                {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the link inside carries the text */}
                <td className={cn(CELL, 'max-w-56 min-w-32 px-1')}>
                  <Link to={to} state={{ list: location.search }} className={NAME_LINK}>
                    <span className="min-w-0 truncate">{device.name}</span>
                  </Link>
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 text-fg-muted @2xl:table-cell')}>
                  {TYPE_LABEL[device.type]}
                </td>
                <td className={cn(CELL, 'type-data max-w-56 truncate px-3 text-fg-muted')}>
                  {device.address}
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-body hidden max-w-48 truncate px-3 text-fg-muted @3xl:table-cell',
                  )}
                >
                  {placeOf(device)}
                </td>
                <td className={cn(CELL, 'type-data hidden px-3 @4xl:table-cell')}>
                  {snmpText(device)}
                </td>
                <td
                  className={cn(
                    CELL,
                    'type-data hidden max-w-48 truncate pr-3 text-fg-muted @5xl:table-cell',
                  )}
                >
                  {device.agent
                    ? device.agent.serverName
                    : device.agentAssigned
                      ? 'Not visible'
                      : EMPTY}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DevicesCards({ rows }: { rows: readonly InventoryDevice[] }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Devices" className="min-h-0 flex-1 overflow-auto">
      {rows.map((device) => (
        <li key={device.id} className="border-b border-border last:border-b-0">
          <Link
            to={viewTo(deviceEditorPath(device.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex flex-wrap items-center gap-2">
              <StatusTag
                status={device.enabled ? 'healthy' : 'idle'}
                word={device.enabled ? 'ENABLED' : 'DISABLED'}
                variant="tag"
              />
              <span className="type-data-strong min-w-0 truncate">{device.name}</span>
            </span>
            <span className="type-data text-fg-faint">
              {TYPE_LABEL[device.type]} · {device.address} · {snmpText(device)} · {placeOf(device)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings > Devices: every device of the inventory the account may see, searched, filtered,
 * sorted and paged by the server, each opened on its own page to be changed or deleted. What
 * the SNMP polls say is on the SNMP screen.
 */
export default function DevicesPage() {
  const api = useApi()
  const viewTo = useViewTo()
  const { capabilities } = useAuth()
  const [query, update] = useListQuery(parseDevicesQuery, writeDevicesQuery)
  const wide = useMediaQuery('(min-width: 48rem)')
  const may = capabilities.manageDevices
  const arrival = useArrivalState<{ deleted?: string }>()
  const [flash, setFlash] = useState<Flash | null>(() =>
    arrival.deleted ? { tone: 'ok', text: `The device “${arrival.deleted}” is deleted.` } : null,
  )

  const search = useDebouncedValue(query.q, SEARCH_SETTLE_MS)
  const asked = devicesRequest(query, search)
  const resource = useResource(
    `inventory-devices:${may}:${JSON.stringify(asked)}`,
    async (signal) => (may ? api.listInventoryDevices({ ...asked, signal }) : null),
    { keepPreviousData: true },
  )
  const list = resource.data ?? undefined
  const rows = list?.items ?? []
  const lastPage = list && list.page.number === query.page ? list.page.pages : null
  const pastTheEnd = lastPage !== null && query.page > lastPage && list?.page.total !== 0
  useEffect(() => {
    if (pastTheEnd && lastPage !== null) update({ page: lastPage })
  }, [pastTheEnd, lastPage, update])

  const forbidden = resource.error instanceof ApiError && resource.error.status === 403
  if (!may || forbidden) {
    return (
      <NotPermitted
        what="change devices"
        hint="The console offers this only to an account that may change alert rules and holds the admin's permissions on devices and their SNMP configuration, with access to every customer. The server checks it on every request."
      />
    )
  }

  const matching = list?.page.total ?? 0
  const nothingThere = resource.status === 'success' && list !== undefined && list.scopeTotal === 0
  const noMatch = list !== undefined && list.scopeTotal > 0 && matching === 0
  const clear = () => update({ q: '', snmp: 'all' })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Devices</h2>
        <p className="type-data text-fg-muted" aria-live="polite">
          {list ? `${formatInteger(matching)} of ${formatInteger(list.scopeTotal)} shown` : null}
        </p>
        <Link to={viewTo(NEW_DEVICE_PATH)} className={`${buttonStyle('primary')} ml-auto`}>
          New device
        </Link>
      </header>

      <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />

      <search aria-label="Filter devices" className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search devices"
          placeholder="Search name, address, description, site, customer"
          value={query.q}
          onChange={(q) => update({ q })}
          className="w-full sm:w-80"
        />
        <fieldset className="flex min-w-0 flex-wrap gap-1">
          <legend className="sr-only">Filter by polling</legend>
          {SNMP_FILTERS.map((filter: InventorySnmpFilter) => (
            <Chip
              key={filter}
              pressed={query.snmp === filter}
              onPressedChange={(pressed) => update({ snmp: pressed ? filter : 'all' })}
            >
              {SNMP_FILTER_LABEL[filter]}
            </Chip>
          ))}
        </fieldset>
      </search>

      <Panel
        title="Devices"
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
              title="No devices"
              hint="Add a device, place it on a site, and give it the SNMP settings and the agent that polls it."
            />
          ) : (
            <EmptyState
              title="No device matches"
              hint={
                <>
                  Nothing matches the search and filter.{' '}
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
              The SNMP credentials stay in the agent's own file: only the name of a profile is kept
              here.
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
          <DevicesTable rows={rows} query={query} onSort={update} />
        ) : (
          <DevicesCards rows={rows} />
        )}
      </Panel>
    </div>
  )
}

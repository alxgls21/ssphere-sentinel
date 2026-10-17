import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { HealthStatus, Topology } from '@/api/types'
import { useLive } from '@/app/live'
import { scopeKey, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { formatInteger } from '@/lib/format'
import { Button, Chip, SegmentedControl, Select, type SelectOption } from '@/ui/controls'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { StatusGlyph, StatusTag } from '@/ui/status'
import { TopologyCanvas } from './TopologyCanvas'
import { TopologyDetails } from './TopologyDetails'
import { TopologyOutline } from './TopologyOutline'
import {
  COUNT_ORDER,
  HEALTH_FILTERS,
  HEALTH_FILTER_LABEL,
  KIND_PLURAL,
  LIMITS,
  entityCount,
  healthCounts,
  includeOf,
  parseQuery,
  shortKinds,
  writeQuery,
  type TopologyQuery,
} from './topologyModel'

const LIMIT_OPTIONS: readonly SelectOption<string>[] = LIMITS.map((limit) => ({
  value: String(limit),
  label: `${formatInteger(limit)} nodes`,
}))

const VIEW_OPTIONS = [
  { value: 'map', label: 'Map' },
  { value: 'list', label: 'List' },
] as const

function useTopologyQuery(): readonly [TopologyQuery, (patch: Partial<TopologyQuery>) => void] {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => parseQuery(params), [params])
  const update = useCallback(
    (patch: Partial<TopologyQuery>) =>
      setParams((prev) => writeQuery(prev, { ...parseQuery(prev), ...patch }), { replace: true }),
    [setParams],
  )
  return [query, update] as const
}

/** What the map panel says when the request failed, by why. */
function errorOf(error: Error | null): Error | null {
  if (!(error instanceof ApiError)) return error
  if (error.status === 404) {
    return new Error(
      'This customer or site is not one you may see, or it no longer exists. Choose another scope in the top bar.',
    )
  }
  if (error.status === 403) {
    return new Error('Your account may not view the topology of this scope.')
  }
  return error
}

function Counts({ topology }: { topology: Topology }) {
  const parts = COUNT_ORDER.flatMap((kind) => {
    const count = topology.counts[kind]
    if (!count || count.visible === 0) return []
    const shown =
      count.returned < count.visible
        ? `${formatInteger(count.returned)} of ${formatInteger(count.visible)}`
        : formatInteger(count.returned)
    return [`${shown} ${KIND_PLURAL[kind]}`]
  })
  return <span className="min-w-0 truncate">{parts.join(' · ') || 'Nothing in scope'}</span>
}

function PartialNotice({ topology, query }: { topology: Topology; query: TopologyQuery }) {
  const short = shortKinds(topology)
  const counts = Object.values(topology.counts)
  const returned = counts.reduce((sum, count) => sum + count.returned, 0)
  const visible = counts.reduce((sum, count) => sum + count.visible, 0)
  const ways = [
    'narrow the scope to one customer or site',
    ...(query.containers ? ['hide containers'] : []),
    ...(query.interfaces ? ['hide interfaces'] : []),
    ...(query.limit < Math.max(...LIMITS) ? ['raise the node limit'] : []),
  ]
  return (
    <section
      aria-labelledby="topology-partial"
      className="flex flex-col gap-2 rounded-sm border border-border-strong bg-raised p-3"
    >
      <h2 id="topology-partial" className="type-body flex items-center gap-2 font-semibold text-fg">
        <StatusTag status="warning" word="PARTIAL" variant="tag" />
        Partial map: not everything in this scope is shown
      </h2>
      <p className="type-body text-fg-muted">
        The console API returned {formatInteger(returned)} of {formatInteger(visible)} nodes in this
        scope, at a limit of {formatInteger(query.limit)}. It takes the worst health first, each
        with the site and customer it belongs to; a monitoring edge is drawn only when both its ends
        are on the map.
      </p>
      <ul className="type-data flex flex-wrap gap-x-4 gap-y-1 text-fg">
        {short.map(({ kind, returned: shown, visible: total }) => (
          <li key={kind}>
            {formatInteger(shown)} of {formatInteger(total)} {KIND_PLURAL[kind]} shown
          </li>
        ))}
      </ul>
      <p className="type-body text-fg-muted">To see the rest, {ways.join(', or ')}.</p>
    </section>
  )
}

/**
 * Topology: the infrastructure of the scope as the console API records it. Customers hold sites,
 * sites hold servers, network targets and SNMP devices, servers hold their containers and devices
 * their interfaces: grouping, drawn as boxes, never as links. The only edges say which server's
 * agent probes a target or polls a device. Health is the API's. Physical links are not known, and
 * the map draws none.
 */
export default function TopologyPage() {
  const api = useApi()
  const { pollMs } = useLive()
  const [scope, setScope] = useScope()
  const [query, update] = useTopologyQuery()
  const include = includeOf(query)
  const key = `topology:${scopeKey(scope)}:${include.join(',')}:${query.limit}`
  // A selection belongs to the graph it was made in: another scope or other options start afresh.
  const [selection, setSelection] = useState<{ key: string; id: string | null }>({
    key,
    id: null,
  })
  const selected = selection.key === key ? selection.id : null
  const setSelected = useCallback((id: string | null) => setSelection({ key, id }), [key])

  const resource = useLiveResource('topology', key, (signal) =>
    api.getTopology({ scope, include, limit: query.limit, signal }),
  )
  const topology = resource.data
  const counts = topology ? healthCounts(topology) : null
  const empty = topology !== undefined && topology.nodes.length === 0
  const scoped = scope.customerId !== null || scope.siteId !== null

  const onHighlight = (health: HealthStatus | 'all') => update({ health })

  return (
    <div className="flex min-h-full flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="type-title">Topology</h1>
        <p className="type-data text-fg-muted" aria-live="polite">
          {topology
            ? `${formatInteger(topology.nodes.length)} nodes, ${formatInteger(topology.edges.length)} monitoring edges${topology.truncated ? ' (partial)' : ''}`
            : null}
        </p>
      </header>

      <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
        <legend className="sr-only">What the map shows</legend>
        <Chip pressed={query.containers} onPressedChange={(containers) => update({ containers })}>
          Containers
        </Chip>
        <Chip pressed={query.interfaces} onPressedChange={(interfaces) => update({ interfaces })}>
          Interfaces
        </Chip>
        <Select
          label="Node limit"
          value={String(query.limit)}
          onChange={(limit) => update({ limit: Number(limit) })}
          options={LIMIT_OPTIONS}
        />
        <SegmentedControl
          aria-label="View"
          value={query.view}
          onChange={(view) => update({ view })}
          options={VIEW_OPTIONS}
          className="ml-auto"
        />
      </fieldset>

      {topology && !empty && query.view === 'map' ? (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1">
          <legend className="sr-only">Pick out by health</legend>
          <span className="type-label mr-1 text-fg-faint" aria-hidden="true">
            Pick out
          </span>
          {HEALTH_FILTERS.map((health) => (
            <Chip
              key={health}
              pressed={query.health === health}
              onPressedChange={(pressed) => onHighlight(pressed ? health : 'all')}
              count={
                counts ? (health === 'all' ? entityCount(topology) : counts[health]) : undefined
              }
              leading={health === 'all' ? undefined : <StatusGlyph status={health} size={10} />}
            >
              {HEALTH_FILTER_LABEL[health]}
            </Chip>
          ))}
          <span className="type-data ml-1 text-fg-faint">
            Of the nodes shown; the others are dimmed, not removed.
          </span>
        </fieldset>
      ) : null}

      {topology?.truncated ? <PartialNotice topology={topology} query={query} /> : null}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel
          index={1}
          title={query.view === 'map' ? 'Map' : 'List'}
          features="topology"
          scope="NOW"
          refreshMs={pollMs}
          status={resource.status}
          refreshing={resource.isRefreshing && topology !== undefined}
          error={errorOf(resource.error)}
          updatedAt={resource.updatedAt}
          onRetry={resource.refetch}
          isEmpty={empty}
          empty={
            <EmptyState
              title="No infrastructure in this scope"
              hint={
                scoped ? (
                  <>
                    Nothing you may see is recorded in this customer or site.{' '}
                    <Button
                      size="sm"
                      onClick={() => setScope({ customerId: null, siteId: null })}
                      className="ml-1"
                    >
                      Show every scope
                    </Button>
                  </>
                ) : (
                  'No customer, site, server, network target or SNMP device you may see is recorded yet.'
                )
              }
            />
          }
          footer={topology ? <Counts topology={topology} /> : undefined}
          flush
          className="min-h-[28rem]"
          bodyClassName="flex flex-col"
        >
          {topology ? (
            query.view === 'map' ? (
              <TopologyCanvas
                topology={topology}
                selected={selected}
                onSelect={setSelected}
                highlight={query.health}
              />
            ) : (
              <TopologyOutline topology={topology} selected={selected} onSelect={setSelected} />
            )
          ) : null}
        </Panel>

        <Panel
          index={2}
          title="Selection"
          features="topology"
          status={resource.status === 'loading' ? 'loading' : 'success'}
          flush
        >
          {topology ? (
            <TopologyDetails
              topology={topology}
              selected={selected}
              onSelect={setSelected}
              onScope={setScope}
            />
          ) : (
            <EmptyState title="Nothing to select" hint="The map has not loaded." />
          )}
        </Panel>
      </div>

      <section
        aria-label="How to read the map"
        className="type-data flex flex-col gap-1 text-fg-muted"
      >
        <p>
          <span className="text-fg">Boxes</span> are grouping: a customer holds its sites, a site
          what is placed on it, a server its containers, a device its interfaces. They are not
          connections.
        </p>
        <p>
          <span className="text-fg">Dashed arrows</span> labelled Probes or Polls run from the
          server whose agent measures a network target or an SNMP device to it: monitoring
          responsibility, not network connectivity.
        </p>
        <p>
          Physical links are not known: Sentinel records no cabling or routing, so the map draws
          none. Shapes tell kinds apart (server square, SNMP device hexagon, network target diamond,
          container small square, interface circle); the word under each name is its health.
        </p>
      </section>
    </div>
  )
}

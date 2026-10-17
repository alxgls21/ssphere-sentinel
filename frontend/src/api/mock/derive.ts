import type {
  EntityIndex,
  EntityIndexItem,
  FleetLoad,
  HealthBreakdown,
  HealthStatus,
  LoadMetric,
  OverviewSummary,
  ScopeOptions,
  SiteBreakdown,
  SiteEntity,
} from '@/api/types'
import { compareSeverity, countStatuses, emptyCounts, worstStatus } from '@/lib/status'
import type { Estate, Fleet } from './fixtures'
import {
  containerHealthOf,
  makeLookup,
  offlineFlag,
  serverCounts,
  serverHealthOf,
  type Lookup,
} from './lookup'
import { toIso } from './time'

/** Everything the Overview shows, derived from one fleet so the panels cannot disagree. */

export function scopeOptions(fleet: Fleet): ScopeOptions {
  return {
    customers: fleet.customers.map((customer) => ({ ...customer })),
    sites: fleet.sites.map((site) => ({ ...site })),
  }
}

export function summarize({ fleet }: Estate, now: number): OverviewSummary {
  return {
    generatedAt: toIso(now),
    servers: { total: fleet.servers.length, counts: serverCounts(fleet.servers) },
    containers: {
      total: fleet.containers.length,
      counts: countStatuses(fleet.containers.map(containerHealthOf)),
    },
    // The sample fleet monitors no network targets: none is counted, none is made up.
    targets: { total: 0, counts: emptyCounts() },
    // ... and no SNMP device.
    devices: { total: 0, counts: emptyCounts() },
  }
}

const LOAD_KEY = { cpu: 'cpuPercent', memory: 'memoryPercent', disk: 'diskPercent' } as const
const DEFAULT_LOAD_LIMIT = 8

export function fleetLoad(
  fleet: Fleet,
  metric: LoadMetric,
  limit: number | undefined,
  now: number,
): FleetLoad {
  const rows: FleetLoad['rows'] = []
  const excluded: string[] = []
  for (const server of fleet.servers) {
    // An offline host's frozen telemetry is history, not a reading: it has no usable sample.
    if (server.status !== 'online' || server.telemetry === null) {
      excluded.push(server.name)
      continue
    }
    rows.push({
      serverId: server.id,
      name: server.name,
      percent: server.telemetry[LOAD_KEY[metric]],
      collectedAt: server.telemetry.collectedAt,
    })
  }
  rows.sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name))
  return {
    generatedAt: toIso(now),
    rows: rows.slice(0, limit ?? DEFAULT_LOAD_LIMIT),
    excluded: excluded.sort((a, b) => a.localeCompare(b)),
  }
}

const KIND_ORDER: Record<'server' | 'container', number> = { server: 0, container: 1 }

function siteEntities(fleet: Fleet, lookup: Lookup, siteId: string): SiteEntity[] {
  const entities: SiteEntity[] = []
  for (const server of fleet.servers) {
    if (server.siteId === siteId) {
      entities.push({
        id: server.id,
        kind: 'server',
        name: server.name,
        status: serverHealthOf(server),
        ...offlineFlag(server),
      })
    }
  }
  for (const container of fleet.containers) {
    const host = lookup.serverById.get(container.serverId)
    if (host?.siteId === siteId) {
      entities.push({
        id: container.id,
        kind: 'container',
        // A container name alone ("nginx") is not unique: the host names it.
        name: `${container.name}@${host.name}`,
        status: containerHealthOf(container),
      })
    }
  }
  return entities.sort(
    (a, b) =>
      compareSeverity(a.status, b.status) ||
      KIND_ORDER[a.kind as 'server' | 'container'] - KIND_ORDER[b.kind as 'server' | 'container'] ||
      a.name.localeCompare(b.name),
  )
}

const countOf = (entities: SiteEntity[], status: HealthStatus) =>
  entities.filter((entity) => entity.status === status).length

export function healthBreakdown({ fleet }: Estate, now: number): HealthBreakdown {
  const lookup = makeLookup(fleet)
  const sites: SiteBreakdown[] = fleet.sites.map((site) => ({
    siteId: site.id,
    customerName: lookup.customerById.get(site.customerId)?.name ?? '',
    siteName: site.name,
    entities: siteEntities(fleet, lookup, site.id),
  }))
  sites.sort(
    (a, b) =>
      countOf(b.entities, 'critical') - countOf(a.entities, 'critical') ||
      countOf(b.entities, 'warning') - countOf(a.entities, 'warning') ||
      a.customerName.localeCompare(b.customerName) ||
      a.siteName.localeCompare(b.siteName),
  )
  return {
    generatedAt: toIso(now),
    domains: [
      {
        domain: 'servers',
        label: 'SERVERS',
        counts: serverCounts(fleet.servers),
      },
      {
        domain: 'containers',
        label: 'CONTAINERS',
        counts: countStatuses(fleet.containers.map(containerHealthOf)),
      },
      { domain: 'targets', label: 'NET TARGETS', counts: emptyCounts() },
      { domain: 'snmp', label: 'SNMP DEVS', counts: emptyCounts() },
    ],
    sites,
  }
}

const byName = (a: EntityIndexItem, b: EntityIndexItem) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function entityIndex({ fleet }: Estate, now: number): EntityIndex {
  const lookup = makeLookup(fleet)
  const named = (place: ReturnType<typeof lookup.placeOfSite>) => ({
    ...(place.customerName ? { customerName: place.customerName } : {}),
    ...(place.siteName ? { siteName: place.siteName } : {}),
  })

  const servers: EntityIndexItem[] = fleet.servers.map((server) => ({
    id: server.id,
    kind: 'server',
    name: server.name,
    detail: server.ipAddress ? `${server.hostname} ${server.ipAddress}` : server.hostname,
    status: serverHealthOf(server),
    ...offlineFlag(server),
    ...named(lookup.placeOfSite(server.siteId)),
  }))
  const containers: EntityIndexItem[] = fleet.containers.map((container) => ({
    id: container.id,
    kind: 'container',
    name: container.name,
    detail: `${container.image} on ${lookup.serverById.get(container.serverId)?.name ?? 'unknown host'}`,
    status: containerHealthOf(container),
    ...named(lookup.placeOfContainer(container)),
  }))
  const siteStatus = new Map<string, HealthStatus>()
  const sites: EntityIndexItem[] = fleet.sites.map((site) => {
    const entities = siteEntities(fleet, lookup, site.id)
    const status = worstStatus(entities.map((entity) => entity.status))
    siteStatus.set(site.id, status)
    const kinds = (kind: SiteEntity['kind']) =>
      entities.filter((entity) => entity.kind === kind).length
    return {
      id: site.id,
      kind: 'site',
      name: site.name,
      detail: `${kinds('server')} servers, ${kinds('container')} containers`,
      status,
      ...named(lookup.placeOfSite(site.id)),
    }
  })
  const customers: EntityIndexItem[] = fleet.customers.map((customer) => {
    const own = fleet.sites.filter((site) => site.customerId === customer.id)
    return {
      id: customer.id,
      kind: 'customer',
      name: customer.name,
      detail: `${own.length} sites`,
      status: worstStatus(own.map((site) => siteStatus.get(site.id) ?? 'unknown')),
      customerName: customer.name,
    }
  })

  return {
    generatedAt: toIso(now),
    items: [
      ...servers.sort(byName),
      ...containers.sort(byName),
      ...sites.sort(byName),
      ...customers.sort(byName),
    ],
  }
}

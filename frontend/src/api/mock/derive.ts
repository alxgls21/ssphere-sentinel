import type {
  DeviceType,
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
  serverHealthOf,
  targetHealthOf,
  type Lookup,
} from './lookup'
import { successTrend } from './series'
import { toIso } from './time'

/** Everything the Overview shows, derived from one fleet so the panels cannot disagree. */

export function scopeOptions(fleet: Fleet): ScopeOptions {
  return {
    customers: fleet.customers.map((customer) => ({ ...customer })),
    sites: fleet.sites.map((site) => ({ ...site })),
  }
}

export function summarize({ fleet, probes }: Estate, now: number): OverviewSummary {
  const byType: Record<DeviceType, number> = { router: 0, switch: 0, firewall: 0, other: 0 }
  for (const device of fleet.devices) byType[device.deviceType] += 1
  return {
    generatedAt: toIso(now),
    servers: {
      total: fleet.servers.length,
      online: fleet.servers.filter((server) => server.status === 'online').length,
      counts: countStatuses(fleet.servers.map(serverHealthOf)),
    },
    containers: {
      total: fleet.containers.length,
      running: fleet.containers.filter((container) => container.state === 'running').length,
      counts: countStatuses(fleet.containers.map(containerHealthOf)),
    },
    targets: {
      total: fleet.targets.length,
      up: fleet.targets.filter((target) => target.status === 'up').length,
      counts: countStatuses(fleet.targets.map(targetHealthOf)),
      successTrend: successTrend(probes, now),
    },
    devices: { inInventory: fleet.devices.length, byType },
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

const KIND_ORDER: Record<SiteEntity['kind'], number> = {
  server: 0,
  container: 1,
  target: 2,
  device: 3,
}

function siteEntities(fleet: Fleet, lookup: Lookup, siteId: string): SiteEntity[] {
  const entities: SiteEntity[] = []
  for (const server of fleet.servers) {
    if (server.siteId === siteId) {
      entities.push({
        id: server.id,
        kind: 'server',
        name: server.name,
        status: serverHealthOf(server),
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
  for (const target of fleet.targets) {
    if (target.siteId === siteId) {
      entities.push({
        id: target.id,
        kind: 'target',
        name: target.name,
        status: targetHealthOf(target),
      })
    }
  }
  return entities.sort(
    (a, b) =>
      compareSeverity(a.status, b.status) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
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
        counts: countStatuses(fleet.servers.map(serverHealthOf)),
      },
      {
        domain: 'containers',
        label: 'CONTAINERS',
        counts: countStatuses(fleet.containers.map(containerHealthOf)),
      },
      {
        domain: 'targets',
        label: 'NET TARGETS',
        counts: countStatuses(fleet.targets.map(targetHealthOf)),
      },
      {
        // SNMP is PLANNED: nothing is collected, so every device is "no data".
        domain: 'snmp',
        label: 'SNMP DEVS',
        counts: { ...emptyCounts(), unknown: fleet.devices.length },
        planned: true,
      },
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
  const targets: EntityIndexItem[] = fleet.targets.map((target) => ({
    id: target.id,
    kind: 'target',
    name: target.name,
    detail: target.port === null ? target.address : `${target.address}:${target.port}`,
    status: targetHealthOf(target),
    ...named(lookup.placeOfSite(target.siteId)),
  }))
  const devices: EntityIndexItem[] = fleet.devices.map((device) => ({
    id: device.id,
    kind: 'device',
    name: device.name,
    detail: device.managementAddress,
    // SNMP is PLANNED: nothing is collected, so a device asserts no health.
    status: 'unknown',
    ...named(lookup.placeOfSite(device.siteId)),
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
      detail: `${kinds('server')} servers, ${kinds('target')} targets`,
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
      ...targets.sort(byName),
      ...devices.sort(byName),
      ...sites.sort(byName),
      ...customers.sort(byName),
    ],
  }
}

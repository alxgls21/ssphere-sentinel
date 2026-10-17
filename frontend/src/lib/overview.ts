import type {
  AttentionItem,
  AttentionResult,
  ContainerList,
  ContainerListItem,
  DeviceList,
  DeviceListItem,
  HealthBreakdown,
  HealthStatus,
  InterfaceFigures,
  OverviewSummary,
  ServerList,
  ServerListItem,
  SiteBreakdown,
  SiteCoverage,
  SiteEntity,
  StatusCounts,
  TargetList,
  TargetListItem,
} from '@/api/types'
import { deviceDetail, deviceReasonWord } from './devices'
import { EMPTY, formatAge, formatPercent } from './format'
import { readingOf } from './serverList'
import { reasonDetail, reasonWord } from './targets'
import { compareSeverity } from './status'
import { sumCounts } from './verdict'

/**
 * The Overview, from what the console API counts and lists: servers, containers, probe targets
 * and SNMP devices. Each function is pure: the worst-first pages of the lists go in, a view-model
 * comes out. A count is the server's own; nothing here makes up a figure for what it does not serve.
 */

/** What an Overview request asks the lists for: the worst first, as many as one page holds. */
export const OVERVIEW_PAGE_SIZE = 200

/**
 * What a request for the worst first of the Overview cannot reach. The counts and totals of every
 * list are the API's own and cover the whole scope; the rows are only the first page of each.
 * So the summary and the domain counts are exact, while whatever is made of the rows (the queue,
 * the sites) is exact only for the part of the fleet the rows cover, and says so.
 */
const problemsOf = (counts: StatusCounts): number =>
  counts.critical + counts.warning + counts.unknown

/**
 * The servers that are offline, as a share of the critical ones. The lists are worst first,
 * so every critical server is on the first page unless there are more of them than a page
 * holds; then the share is not known and none is claimed.
 */
function offlineShare(servers: ServerList): number | undefined {
  if (servers.counts.critical === 0 || servers.counts.critical > servers.items.length) {
    return undefined
  }
  const offline = servers.items.filter((item) => item.server.status === 'offline').length
  return offline > 0 ? offline : undefined
}

function serverCounts(servers: ServerList): StatusCounts {
  const offline = offlineShare(servers)
  return offline === undefined ? { ...servers.counts } : { ...servers.counts, offline }
}

export function summaryOf(
  servers: ServerList,
  containers: ContainerList,
  targets: TargetList,
  devices: DeviceList,
): OverviewSummary {
  return {
    generatedAt: servers.generatedAt,
    servers: { total: servers.scopeTotal, counts: serverCounts(servers) },
    containers: { total: containers.scopeTotal, counts: { ...containers.counts } },
    targets: { total: targets.scopeTotal, counts: { ...targets.counts } },
    devices: { total: devices.scopeTotal, counts: { ...devices.counts } },
  }
}

/* --------------------------------------------------------------- attention */

const SERVER_PROBLEMS: readonly HealthStatus[] = ['critical', 'warning', 'unknown']

const resources = (item: ServerListItem): string => {
  const reading = item.server.telemetry
  if (!reading) return EMPTY
  return [
    `cpu ${formatPercent(reading.cpuPercent)}`,
    `mem ${formatPercent(reading.memoryPercent)}`,
    `disk ${formatPercent(reading.diskPercent)}`,
  ].join(' · ')
}

function serverItem(item: ServerListItem, nowMs: number): AttentionItem {
  const { server } = item
  const place = {
    ...(item.customerName ? { customerName: item.customerName } : {}),
    ...(item.siteName ? { siteName: item.siteName } : {}),
  }
  const base = {
    kind: 'server' as const,
    id: server.id,
    name: server.name,
    severity: item.health as AttentionItem['severity'],
    ...place,
  }
  switch (readingOf(item)) {
    case 'offline':
      return {
        ...base,
        stateLabel: 'OFFLINE',
        detail: `offline · last heartbeat ${formatAge(server.lastSeenAt, nowMs)} ago`,
        ageIso: server.lastSeenAt,
        ageBasis: server.lastSeenAt ? 'last-seen' : null,
        offline: true,
      }
    case 'never':
      return {
        ...base,
        stateLabel: 'UNKNOWN',
        detail: 'never reported',
        ageIso: null,
        ageBasis: null,
      }
    case 'stale':
      return {
        ...base,
        stateLabel: 'NO READING',
        detail: `reading is stale · last received ${formatAge(server.telemetry?.receivedAt ?? server.telemetry?.collectedAt, nowMs)} ago`,
        ageIso: null,
        ageBasis: null,
      }
    case 'missing':
      return {
        ...base,
        stateLabel: 'NO READING',
        detail: 'heartbeats arrive, no telemetry yet',
        ageIso: null,
        ageBasis: null,
      }
    case 'current':
      // Resource problems have no history: the console API keeps one reading, so no age is claimed.
      return {
        ...base,
        stateLabel: item.health === 'critical' ? 'CRITICAL' : 'DEGRADED',
        detail: resources(item),
        ageIso: null,
        ageBasis: null,
      }
  }
}

const CONTAINER_WORD: Record<string, string> = {
  dead: 'DEAD',
  restarting: 'RESTARTING',
  exited: 'EXITED',
  paused: 'PAUSED',
  created: 'CREATED',
  unknown: 'UNKNOWN',
}

function containerItem(item: ContainerListItem): AttentionItem {
  const { container } = item
  const word =
    container.state === 'running'
      ? container.health === 'unhealthy'
        ? 'UNHEALTHY'
        : container.health === 'starting'
          ? 'STARTING'
          : 'RUNNING'
      : (CONTAINER_WORD[container.state] ?? 'UNKNOWN')
  return {
    kind: 'container',
    id: container.id,
    name: container.name,
    severity: item.status as AttentionItem['severity'],
    stateLabel: word,
    detail: `${container.state}${container.health === 'none' ? '' : ` · ${container.health}`} on ${item.serverName}`,
    hostName: item.serverName,
    ...(item.customerName ? { customerName: item.customerName } : {}),
    ...(item.siteName ? { siteName: item.siteName } : {}),
    ageIso: null,
    ageBasis: null,
  }
}

function deviceItem(item: DeviceListItem, nowMs: number): AttentionItem {
  const { device, state } = item
  return {
    kind: 'device',
    id: device.id,
    name: device.name,
    // The API's health and reason, worded; never worked out again, and never from an interface.
    severity: item.health as AttentionItem['severity'],
    stateLabel: deviceReasonWord(item.reason),
    detail: deviceDetail(item, nowMs),
    ...(item.customerName ? { customerName: item.customerName } : {}),
    ...(item.siteName ? { siteName: item.siteName } : {}),
    // Dated by the latest poll, whatever its age: the row never claims a start for the problem.
    ageIso: state ? state.lastPollAt : null,
    ageBasis: state ? 'last-polled' : null,
  }
}

const RANK: Record<AttentionItem['severity'], number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  idle: 3,
}

function targetItem(item: TargetListItem, nowMs: number): AttentionItem {
  const { target, latest } = item
  return {
    kind: 'target',
    id: target.id,
    name: target.name,
    // The API's health and reason, worded; nothing is worked out again from the measurement.
    severity: item.health as AttentionItem['severity'],
    stateLabel: reasonWord(item.reason, target.protocol),
    detail: reasonDetail(item, nowMs),
    ...(item.customerName ? { customerName: item.customerName } : {}),
    ...(item.siteName ? { siteName: item.siteName } : {}),
    // Dated by the newest measurement, whatever its age: the row never claims a start for the problem.
    ageIso: latest ? latest.measuredAt : null,
    ageBasis: latest ? 'last-measured' : null,
  }
}

/**
 * What needs a look, worst first: critical, warning, unknown, then (when asked for) idle
 * containers and disabled targets, each group by name. Idle ones are counted, not listed, unless
 * `includeIdle`. The rows are the worst of each list the API returns; `omitted` and `hiddenIdle`
 * count what exists beyond them, from the API's own counts.
 */
export function attentionOf(
  servers: ServerList,
  containers: ContainerList,
  targets: TargetList,
  devices: DeviceList,
  { includeIdle = false, now }: { includeIdle?: boolean; now: number },
): AttentionResult {
  const items: AttentionItem[] = [
    ...servers.items
      .filter((item) => SERVER_PROBLEMS.includes(item.health))
      .map((item) => serverItem(item, now)),
    ...containers.items
      .filter(
        (item) => SERVER_PROBLEMS.includes(item.status) || (includeIdle && item.status === 'idle'),
      )
      .map(containerItem),
    ...targets.items
      .filter(
        (item) => SERVER_PROBLEMS.includes(item.health) || (includeIdle && item.health === 'idle'),
      )
      .map((item) => targetItem(item, now)),
    ...devices.items
      .filter(
        (item) => SERVER_PROBLEMS.includes(item.health) || (includeIdle && item.health === 'idle'),
      )
      .map((item) => deviceItem(item, now)),
  ].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] || a.name.localeCompare(b.name, 'en', { numeric: true }),
  )
  const listed = (severity: (s: AttentionItem['severity']) => boolean) =>
    items.filter((item) => severity(item.severity)).length
  const omitted = Math.max(
    0,
    problemsOf(servers.counts) +
      problemsOf(containers.counts) +
      problemsOf(targets.counts) +
      problemsOf(devices.counts) -
      listed((s) => s !== 'idle'),
  )
  return {
    generatedAt: servers.generatedAt,
    items,
    // Idle containers, targets and devices the queue does not list: all of them unless asked for, then those beyond the rows.
    hiddenIdle: Math.max(
      0,
      containers.counts.idle +
        targets.counts.idle +
        devices.counts.idle -
        listed((s) => s === 'idle'),
    ),
    ...(omitted > 0 ? { omitted } : {}),
  }
}

/* ------------------------------------------------------------------ health */

const KIND_ORDER: Record<SiteEntity['kind'], number> = {
  server: 0,
  container: 1,
  target: 2,
  device: 3,
}

const sortEntities = (entities: SiteEntity[]): SiteEntity[] =>
  entities.sort(
    (a, b) =>
      compareSeverity(a.status, b.status) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name, 'en', { numeric: true }),
  )

const countOf = (entities: readonly SiteEntity[], status: HealthStatus) =>
  entities.filter((entity) => entity.status === status).length

const needsALook = (status: HealthStatus): boolean =>
  status === 'critical' || status === 'warning' || status === 'unknown'

/**
 * How much of the fleet the per-site rows can rest on. Whole lists: all of it. Otherwise the
 * rows are the worst first, so when every problem of every list is among them the sites'
 * problems are exact (the healthy and idle members per site are not known); when they are not,
 * no per-site figure would be true.
 */
function coverageOf(
  servers: ServerList,
  containers: ContainerList,
  targets: TargetList,
  devices: DeviceList,
): SiteCoverage {
  const lists = [servers, containers, targets, devices]
  if (lists.every((list) => list.items.length >= list.scopeTotal)) return 'all'
  return lists.every((list) => problemsOf(list.counts) <= list.items.length) ? 'problems' : 'none'
}

/**
 * The interfaces of the devices the rows hold. The API counts them per device and not for the
 * scope, so this sums what the rows carry and says whether the rows are every device in scope.
 * None is made up: a scope without devices has no figure.
 */
function interfaceFigures(devices: DeviceList): InterfaceFigures | undefined {
  if (devices.scopeTotal === 0 || devices.items.length === 0) return undefined
  return {
    total: devices.items.reduce((sum, item) => sum + item.interfaces.total, 0),
    counts: sumCounts(...devices.items.map((item) => item.interfaces.counts)),
    devices: devices.items.length,
    of: devices.scopeTotal,
    complete: devices.items.length >= devices.scopeTotal,
  }
}

/**
 * Composition by domain, and the sites with their servers, containers, probe targets and SNMP
 * devices. The domain counts are the API's and cover the whole scope; a device's health is the
 * API's and no interface enters it. The sites are built from the rows, so they say how far those
 * reach (`siteCoverage`): every member, only the ones that need a look, or nothing. A container is
 * placed by the site of its server and a target by its own site; a server or target with no site is
 * on none. A problem container whose server is not among the rows cannot be placed, and then
 * nothing is claimed for the sites.
 */
export function healthOf(
  servers: ServerList,
  containers: ContainerList,
  targets: TargetList,
  devices: DeviceList,
): HealthBreakdown {
  let siteCoverage = coverageOf(servers, containers, targets, devices)
  const onlyProblems = siteCoverage === 'problems'
  const siteOf = new Map(servers.items.map((item) => [item.server.id, item.server.siteId]))
  const sites = new Map<string, SiteBreakdown>()
  const place = (siteId: string, customerName: string, siteName: string, entity: SiteEntity) => {
    const site = sites.get(siteId) ?? { siteId, customerName, siteName, entities: [] }
    site.entities.push(entity)
    sites.set(siteId, site)
  }
  for (const item of servers.items) {
    if (item.server.siteId === null || (onlyProblems && !needsALook(item.health))) continue
    place(item.server.siteId, item.customerName ?? '', item.siteName ?? '', {
      id: item.server.id,
      kind: 'server',
      name: item.server.name,
      status: item.health,
      ...(item.server.status === 'offline' ? { offline: true } : {}),
    })
  }
  for (const item of containers.items) {
    if (onlyProblems && !needsALook(item.status)) continue
    if (!siteOf.has(item.container.serverId) && item.siteName) {
      // Its server is beyond the rows: where it belongs is not known.
      siteCoverage = 'none'
      continue
    }
    const siteId = siteOf.get(item.container.serverId)
    if (!siteId) continue
    place(siteId, item.customerName ?? '', item.siteName ?? '', {
      id: item.container.id,
      kind: 'container',
      // A container name alone ("nginx") is not unique: the host names it.
      name: `${item.container.name}@${item.serverName}`,
      status: item.status,
    })
  }
  for (const item of targets.items) {
    const { target } = item
    if (target.siteId === null || (onlyProblems && !needsALook(item.health))) continue
    place(target.siteId, item.customerName ?? '', item.siteName ?? '', {
      id: target.id,
      kind: 'target',
      name: target.name,
      status: item.health,
    })
  }
  for (const item of devices.items) {
    const { device } = item
    if (device.siteId === null || (onlyProblems && !needsALook(item.health))) continue
    place(device.siteId, item.customerName ?? '', item.siteName ?? '', {
      id: device.id,
      kind: 'device',
      name: device.name,
      status: item.health,
    })
  }
  const ranked = [...sites.values()].map((site) => ({
    ...site,
    entities: sortEntities(site.entities),
  }))
  ranked.sort(
    (a, b) =>
      countOf(b.entities, 'critical') - countOf(a.entities, 'critical') ||
      countOf(b.entities, 'warning') - countOf(a.entities, 'warning') ||
      a.customerName.localeCompare(b.customerName) ||
      a.siteName.localeCompare(b.siteName),
  )
  const interfaces = interfaceFigures(devices)
  return {
    generatedAt: servers.generatedAt,
    domains: [
      { domain: 'servers', label: 'SERVERS', counts: serverCounts(servers) },
      { domain: 'containers', label: 'CONTAINERS', counts: { ...containers.counts } },
      { domain: 'targets', label: 'NET TARGETS', counts: { ...targets.counts } },
      {
        domain: 'snmp',
        label: 'SNMP DEVS',
        counts: { ...devices.counts },
        ...(interfaces ? { interfaces } : {}),
      },
    ],
    sites: siteCoverage === 'none' ? [] : ranked,
    ...(siteCoverage === 'all' ? {} : { siteCoverage }),
  }
}

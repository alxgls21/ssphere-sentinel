import type {
  AttentionItem,
  AttentionResult,
  ContainerList,
  ContainerListItem,
  HealthBreakdown,
  HealthStatus,
  OverviewSummary,
  ServerList,
  ServerListItem,
  SiteBreakdown,
  SiteEntity,
  StatusCounts,
} from '@/api/types'
import { EMPTY, formatAge, formatPercent } from './format'
import { readingOf } from './serverList'
import { compareSeverity, emptyCounts } from './status'

/**
 * The Overview, from what the console API counts and lists: servers and containers. Each
 * function is pure: the worst-first pages of the two lists go in, a view-model comes out. A
 * count is the server's own; nothing here makes up a figure for what it does not serve.
 */

/** What an Overview request asks the lists for: the worst first, as many as one page holds. */
export const OVERVIEW_PAGE_SIZE = 200

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

export function summaryOf(servers: ServerList, containers: ContainerList): OverviewSummary {
  return {
    generatedAt: servers.generatedAt,
    servers: { total: servers.scopeTotal, counts: serverCounts(servers) },
    containers: { total: containers.scopeTotal, counts: { ...containers.counts } },
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

const RANK: Record<AttentionItem['severity'], number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  idle: 3,
}

/**
 * What needs a look, worst first: critical, warning, unknown, then (when asked for) idle
 * containers, each group by name. Idle ones are counted, not listed, unless `includeIdle`.
 */
export function attentionOf(
  servers: ServerList,
  containers: ContainerList,
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
  ].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] || a.name.localeCompare(b.name, 'en', { numeric: true }),
  )
  return {
    generatedAt: servers.generatedAt,
    items,
    hiddenIdle: includeIdle ? 0 : containers.counts.idle,
  }
}

/* ------------------------------------------------------------------ health */

const KIND_ORDER = { server: 0, container: 1 } as const

const sortEntities = (entities: SiteEntity[]): SiteEntity[] =>
  entities.sort(
    (a, b) =>
      compareSeverity(a.status, b.status) ||
      KIND_ORDER[a.kind as 'server' | 'container'] - KIND_ORDER[b.kind as 'server' | 'container'] ||
      a.name.localeCompare(b.name, 'en', { numeric: true }),
  )

const countOf = (entities: readonly SiteEntity[], status: HealthStatus) =>
  entities.filter((entity) => entity.status === status).length

/**
 * Composition by domain, and the sites with their servers and containers. Probe targets and
 * SNMP devices are `planned` rows that say so: the console API serves neither. A site holds
 * what the worst-first pages reach (a container is placed by the site of its server), and a
 * server with no site is on none.
 */
export function healthOf(servers: ServerList, containers: ContainerList): HealthBreakdown {
  const siteOf = new Map(servers.items.map((item) => [item.server.id, item.server.siteId]))
  const sites = new Map<string, SiteBreakdown>()
  const place = (siteId: string, customerName: string, siteName: string, entity: SiteEntity) => {
    const site = sites.get(siteId) ?? { siteId, customerName, siteName, entities: [] }
    site.entities.push(entity)
    sites.set(siteId, site)
  }
  for (const item of servers.items) {
    if (item.server.siteId === null) continue
    place(item.server.siteId, item.customerName ?? '', item.siteName ?? '', {
      id: item.server.id,
      kind: 'server',
      name: item.server.name,
      status: item.health,
      ...(item.server.status === 'offline' ? { offline: true } : {}),
    })
  }
  for (const item of containers.items) {
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
  return {
    generatedAt: servers.generatedAt,
    domains: [
      { domain: 'servers', label: 'SERVERS', counts: serverCounts(servers) },
      { domain: 'containers', label: 'CONTAINERS', counts: { ...containers.counts } },
      { domain: 'targets', label: 'NET TARGETS', counts: emptyCounts(), planned: true },
      { domain: 'snmp', label: 'SNMP DEVS', counts: emptyCounts(), planned: true },
    ],
    sites: ranked,
  }
}

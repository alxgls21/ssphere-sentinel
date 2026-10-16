import type {
  AttentionItem,
  AttentionResult,
  AttentionSeverity,
  DockerContainer,
  HealthStatus,
  NetworkTarget,
  Server,
} from '@/api/types'
import { formatAge, formatLatency, formatPercent } from '@/lib/format'
import { compareSeverity } from '@/lib/status'
import {
  LATENCY_WARN_MS,
  RESOURCE_CRIT_PERCENT,
  RESOURCE_WARN_PERCENT,
  latencyExceedsWarn,
  lossExceedsWarn,
  resourceLevel,
} from '@/lib/thresholds'
import type { Fleet } from './fixtures'
import {
  containerHealthOf,
  makeLookup,
  offlineFlag,
  serverHealthOf,
  targetHealthOf,
  type Lookup,
  type Place,
} from './lookup'
import { toIso } from './time'

/**
 * The needs-attention queue. Every detail line is built only from fields the
 * backend ingests (state, health, host, last heartbeat, failure reason,
 * latency, loss, cpu/memory/disk): no exit codes, no restart counts, and no
 * "since" that no timestamp supports.
 */

type Described = Pick<AttentionItem, 'stateLabel' | 'detail' | 'ageIso' | 'ageBasis'>

const RESOURCES = [
  { key: 'cpuPercent', name: 'cpu', title: 'CPU', stateLabel: 'HIGH CPU' },
  { key: 'memoryPercent', name: 'memory', title: 'Memory', stateLabel: 'HIGH MEM' },
  { key: 'diskPercent', name: 'disk', title: 'Disk', stateLabel: 'DISK' },
] as const

type Resource = (typeof RESOURCES)[number]

/** The metric furthest over its threshold, or null while all of them are fine. */
export function worstResource(server: Server): (Resource & { percent: number }) | null {
  const over = RESOURCES.map((resource) => ({
    ...resource,
    percent: server.telemetry?.[resource.key] ?? 0,
  })).filter(({ percent }) => resourceLevel(percent) !== 'ok')
  return over.sort((a, b) => b.percent - a.percent)[0] ?? null
}

/** "crit at 95" or "warn at 80": which threshold a percentage crossed. */
const limitLabel = (percent: number): string =>
  resourceLevel(percent) === 'crit'
    ? `crit at ${RESOURCE_CRIT_PERCENT}`
    : `warn at ${RESOURCE_WARN_PERCENT}`

const lastHeartbeat = (server: Server, now: number) =>
  `last heartbeat ${formatAge(server.lastSeenAt, now)} ago`

function describeServer(server: Server, now: number): Described {
  if (server.status === 'unknown' || server.lastSeenAt === null) {
    return { stateLabel: 'UNKNOWN', detail: 'never reported', ageIso: null, ageBasis: null }
  }
  if (server.status === 'offline') {
    return {
      stateLabel: 'OFFLINE',
      detail: `offline · ${lastHeartbeat(server, now)}`,
      ageIso: server.lastSeenAt,
      ageBasis: 'last-seen',
    }
  }
  // Resource problems have no history (the backend keeps one telemetry row): no age.
  const worst = worstResource(server)
  if (worst) {
    return {
      stateLabel: worst.stateLabel,
      detail: `${worst.name} ${formatPercent(worst.percent)} · ${limitLabel(worst.percent)}`,
      ageIso: null,
      ageBasis: null,
    }
  }
  return {
    stateLabel: 'DEGRADED',
    detail: `degraded · ${lastHeartbeat(server, now)}`,
    ageIso: server.lastSeenAt,
    ageBasis: 'last-seen',
  }
}

function describeContainer(container: DockerContainer, host: Server | undefined): Described {
  const word =
    container.state === 'running'
      ? container.health === 'unhealthy'
        ? 'unhealthy'
        : 'starting'
      : container.state === 'unknown'
        ? 'state unknown'
        : container.state
  const stateLabel =
    container.state === 'exited'
      ? 'STOPPED'
      : container.state === 'unknown'
        ? 'UNKNOWN'
        : word.toUpperCase()
  const lastSeen = host?.lastSeenAt ?? null
  return {
    stateLabel,
    detail: `${word} · on ${host?.name ?? 'unknown host'}`,
    // A container has no timestamp of its own: the best the backend knows is its host's last heartbeat.
    ageIso: lastSeen,
    ageBasis: lastSeen === null ? null : 'last-seen',
  }
}

function describeTarget(target: NetworkTarget, health: HealthStatus, now: number): Described {
  if (target.status === 'unknown') {
    return {
      stateLabel: 'UNKNOWN',
      detail:
        target.lastProbeAt === null
          ? 'never reported'
          : `no recent measurement · last probe ${formatAge(target.lastProbeAt, now)} ago`,
      ageIso: null,
      ageBasis: null,
    }
  }
  if (target.failingSince !== null) {
    const reason = (target.failureReason || 'probe failed').replaceAll('_', ' ')
    const probes = target.consecutiveFailures === 1 ? 'probe' : 'probes'
    return {
      stateLabel: health === 'critical' ? 'DOWN' : 'FAILING',
      detail: `${reason} · ${target.consecutiveFailures} failed ${probes}`,
      ageIso: target.failingSince,
      ageBasis: 'failing-since',
    }
  }
  // Loss and latency are thresholds on the latest probe, not a run with a start: no age.
  const base = { stateLabel: 'DEGRADED', ageIso: null, ageBasis: null }
  if (lossExceedsWarn(target.packetLossPercent)) {
    const loss = formatPercent(
      target.packetLossPercent,
      Number.isInteger(target.packetLossPercent) ? 0 : 1,
    )
    const latency = target.latencyMs === null ? '' : ` · ${formatLatency(target.latencyMs)}`
    return { ...base, detail: `loss ${loss}${latency}` }
  }
  if (target.latencyMs !== null && latencyExceedsWarn(target.latencyMs)) {
    return {
      ...base,
      detail: `latency ${formatLatency(target.latencyMs)} · warn at ${LATENCY_WARN_MS}`,
    }
  }
  return { ...base, detail: 'degraded' }
}

const withPlace = (place: Place): Pick<AttentionItem, 'customerName' | 'siteName'> => ({
  ...(place.customerName ? { customerName: place.customerName } : {}),
  ...(place.siteName ? { siteName: place.siteName } : {}),
})

function isAttention(status: HealthStatus): status is AttentionSeverity {
  return status !== 'healthy'
}

/** Severity, then newest first (no timestamp sorts last), then name; the id settles exact ties. */
function compareItems(a: AttentionItem, b: AttentionItem): number {
  const bySeverity = compareSeverity(a.severity, b.severity)
  if (bySeverity !== 0) return bySeverity
  const aAge = a.ageIso === null ? -Infinity : Date.parse(a.ageIso)
  const bAge = b.ageIso === null ? -Infinity : Date.parse(b.ageIso)
  if (aAge !== bAge) return bAge - aAge
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

export function listAttention(fleet: Fleet, now: number, includeIdle: boolean): AttentionResult {
  const lookup: Lookup = makeLookup(fleet)
  const items: AttentionItem[] = []
  let hiddenIdle = 0

  const consider = (
    health: HealthStatus,
    build: (severity: AttentionSeverity) => AttentionItem,
  ) => {
    if (!isAttention(health)) return
    if (health === 'idle' && !includeIdle) {
      hiddenIdle += 1
      return
    }
    items.push(build(health))
  }

  for (const server of fleet.servers) {
    consider(serverHealthOf(server), (severity) => ({
      kind: 'server',
      id: server.id,
      name: server.name,
      severity,
      ...offlineFlag(server),
      ...describeServer(server, now),
      ...withPlace(lookup.placeOfSite(server.siteId)),
    }))
  }
  for (const container of fleet.containers) {
    const host = lookup.serverById.get(container.serverId)
    consider(containerHealthOf(container), (severity) => ({
      kind: 'container',
      id: container.id,
      name: container.name,
      severity,
      ...describeContainer(container, host),
      ...(host ? { hostName: host.name } : {}),
      ...withPlace(lookup.placeOfContainer(container)),
    }))
  }
  for (const target of fleet.targets) {
    const health = targetHealthOf(target)
    consider(health, (severity) => ({
      kind: 'target',
      id: target.id,
      name: target.name,
      protocol: target.protocol,
      severity,
      ...describeTarget(target, health, now),
      ...withPlace(lookup.placeOfSite(target.siteId)),
    }))
  }

  return { generatedAt: toIso(now), items: items.sort(compareItems), hiddenIdle }
}

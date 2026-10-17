import type {
  ContainerHealth,
  ContainerState,
  HealthStatus,
  ServerStatus,
  StatusCounts,
} from '@/api/types'
import { resourceLevel } from './thresholds'

/**
 * Domain state -> UI health vocabulary. Keeping every mapping here means a
 * status never changes meaning between screens.
 *
 * "unknown" asserts nothing (never reported, state not reported by an offline
 * host): it needs a look, so it counts toward "needs attention" but ranks
 * below warning. "idle" is deliberately neutral: the container was stopped
 * and the backend cannot tell an intended exit from a crash (it ingests no
 * restart policy or exit code), so it is hidden from the queue by default.
 */

export function serverHealth(status: ServerStatus): HealthStatus {
  switch (status) {
    case 'online':
      return 'healthy'
    case 'warning':
      return 'warning'
    case 'offline':
      return 'critical'
    case 'unknown':
      return 'unknown'
  }
}

export function containerHealth(state: ContainerState, health: ContainerHealth): HealthStatus {
  switch (state) {
    case 'dead':
      return 'critical'
    case 'restarting':
      return 'warning'
    case 'running':
      if (health === 'unhealthy') return 'critical'
      if (health === 'starting') return 'idle'
      return 'healthy'
    case 'exited':
    case 'created':
    case 'paused':
      return 'idle'
    case 'unknown':
      return 'unknown'
  }
}

/**
 * Aggregate rank for rolling a group up into one status (a site, a domain):
 * higher wins. A neutral idle member never changes a group's status, and an
 * unknown member outranks healthy (something is not being observed).
 */
const AGGREGATE_RANK: Record<HealthStatus, number> = {
  idle: 0,
  healthy: 1,
  unknown: 2,
  warning: 3,
  critical: 4,
}

/** The status a group of entities rolls up to; "unknown" when it is empty. */
export function worstStatus(statuses: Iterable<HealthStatus>): HealthStatus {
  let worst: HealthStatus | null = null
  for (const status of statuses) {
    if (worst === null || AGGREGATE_RANK[status] > AGGREGATE_RANK[worst]) worst = status
  }
  return worst ?? 'unknown'
}

/**
 * Display order for sorted lists and bars: worst first. Unknown comes before
 * idle before healthy (an unobserved thing needs a look sooner than a healthy one).
 */
const SEVERITY_ORDER: Record<HealthStatus, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  idle: 3,
  healthy: 4,
}

export function compareSeverity(a: HealthStatus, b: HealthStatus): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b]
}

/** Warning, critical and unknown need someone to look. Healthy and idle do not. */
export function needsAttention(status: HealthStatus): boolean {
  return status === 'warning' || status === 'critical' || status === 'unknown'
}

export function emptyCounts(): StatusCounts {
  return { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 }
}

export function countStatuses(statuses: Iterable<HealthStatus>): StatusCounts {
  const counts = emptyCounts()
  for (const status of statuses) counts[status] += 1
  return counts
}

/**
 * What a mark shows. "offline" is a presentation of critical, not a health
 * status: a server whose agent stopped reporting is critical to everything that
 * decides (the verdict, attention counts, ranking, sorting, filters, badges, the
 * document title) and is only drawn and named apart where the console
 * describes a state or breaks a count down.
 */
export type DisplayStatus = HealthStatus | 'offline'

/** The one mapping from a health status and the offline flag an entity may carry to what is shown. */
export function displayStatus(status: HealthStatus, offline = false): DisplayStatus {
  return offline && status === 'critical' ? 'offline' : status
}

/** The health status a shown state is counted as. */
export function healthOf(status: DisplayStatus): HealthStatus {
  return status === 'offline' ? 'critical' : status
}

/** Worst first, as every composition lists its states: offline sits directly after the critical it is part of. */
export const DISPLAY_ORDER: readonly DisplayStatus[] = [
  'critical',
  'offline',
  'warning',
  'unknown',
  'idle',
  'healthy',
]

export type DisplayCounts = Record<DisplayStatus, number>

/**
 * Counts for a composition: critical without its offline members, and offline
 * apart. For display only: the figures that drive something keep reading
 * `counts.critical`, which still holds both.
 */
export function displayCounts(counts: StatusCounts): DisplayCounts {
  const offline = Math.min(Math.max(counts.offline ?? 0, 0), counts.critical)
  return {
    healthy: counts.healthy,
    warning: counts.warning,
    critical: counts.critical - offline,
    offline,
    unknown: counts.unknown,
    idle: counts.idle,
  }
}

/** Counts by health status for entities that may be flagged offline; `offline` is set only when one is. */
export function countEntities(
  entities: Iterable<{ status: HealthStatus; offline?: boolean }>,
): StatusCounts {
  const counts = emptyCounts()
  let offline = 0
  for (const entity of entities) {
    counts[entity.status] += 1
    if (displayStatus(entity.status, entity.offline) === 'offline') offline += 1
  }
  return offline > 0 ? { ...counts, offline } : counts
}

/** Worst non-healthy status present in the counts, or null when everything is healthy/idle. */
export function worstOf(counts: StatusCounts): 'critical' | 'warning' | 'unknown' | null {
  if (counts.critical > 0) return 'critical'
  if (counts.warning > 0) return 'warning'
  return counts.unknown > 0 ? 'unknown' : null
}

/** A server is at least as bad as its latest resource sample says (UI-default thresholds). */
export function serverHealthWithResources(
  status: ServerStatus,
  samples: { cpuPercent: number; memoryPercent: number; diskPercent: number } | null,
): HealthStatus {
  const base = serverHealth(status)
  if (base === 'critical' || base === 'unknown' || !samples) return base
  const levels = [samples.cpuPercent, samples.memoryPercent, samples.diskPercent].map((percent) =>
    resourceLevel(percent),
  )
  if (levels.includes('crit')) return 'critical'
  if (levels.includes('warn') || base === 'warning') return 'warning'
  return 'healthy'
}

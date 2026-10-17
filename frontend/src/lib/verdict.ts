import type { HealthStatus, OverviewSummary, StatusCounts } from '@/api/types'
import type { Freshness } from './freshness'
import { emptyCounts } from './status'

/**
 * Tier-0 verdict: one word for the whole fleet, readable from across a room.
 *
 * Counts come ONLY from what the console API counts: servers, containers, probe targets and
 * SNMP devices, each by the health the API decided. A device's health is never worked out from
 * its interfaces. Events are not served, and incidents follow the health already counted, so neither
 * feeds the verdict (it says so in a tooltip).
 *
 *   NO DATA   data older than 120 s, every resource failed, or nothing monitored
 *   CRITICAL  any critical entity
 *   DEGRADED  else any warning
 *   PARTIAL   else any unknown (something is not being observed)
 *   NOMINAL   else
 *
 * "Idle" (stopped containers) is excluded from the denominator.
 */
export type VerdictState = 'critical' | 'degraded' | 'partial' | 'nominal' | 'nodata'

export const VERDICT_WORD: Record<VerdictState, string> = {
  critical: 'CRITICAL',
  degraded: 'DEGRADED',
  partial: 'PARTIAL',
  nominal: 'NOMINAL',
  nodata: 'NO DATA',
}

/** The glyph shape that carries each verdict. */
export const VERDICT_STATUS: Record<VerdictState, HealthStatus> = {
  critical: 'critical',
  degraded: 'warning',
  partial: 'unknown',
  nominal: 'healthy',
  nodata: 'unknown',
}

export interface Verdict {
  state: VerdictState
  word: string
  status: HealthStatus
  /** critical + warning + unknown, or null when there is no data. */
  needAttention: number | null
  /** Entities counted (idle excluded): the "of N" in "9 need attention of 121". */
  monitored: number
  counts: StatusCounts
  /** Idle entities left out of the denominator. */
  idle: number
}

export function sumCounts(...parts: StatusCounts[]): StatusCounts {
  const total = emptyCounts()
  let offline = 0
  for (const part of parts) {
    for (const key of Object.keys(total) as HealthStatus[]) total[key] += part[key]
    offline += part.offline ?? 0
  }
  return offline > 0 ? { ...total, offline } : total
}

export function computeVerdict(
  summary: OverviewSummary | undefined,
  freshness: Freshness,
): Verdict {
  const counts = summary
    ? sumCounts(
        summary.servers.counts,
        summary.containers.counts,
        summary.targets.counts,
        summary.devices.counts,
      )
    : emptyCounts()
  const monitored = counts.healthy + counts.warning + counts.critical + counts.unknown
  const base = { counts, idle: counts.idle, monitored }

  if (!summary || freshness === 'nodata' || monitored === 0) {
    return {
      ...base,
      state: 'nodata',
      word: VERDICT_WORD.nodata,
      status: VERDICT_STATUS.nodata,
      needAttention: null,
    }
  }
  const needAttention = counts.critical + counts.warning + counts.unknown
  const state: VerdictState =
    counts.critical > 0
      ? 'critical'
      : counts.warning > 0
        ? 'degraded'
        : counts.unknown > 0
          ? 'partial'
          : 'nominal'
  return { ...base, state, word: VERDICT_WORD[state], status: VERDICT_STATUS[state], needAttention }
}

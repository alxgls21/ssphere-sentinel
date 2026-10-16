import type { HealthStatus, StatusCounts } from '@/api/types'
import { NAV_ITEMS, type NavItem } from '@/config/nav'
import { nonZeroCounts, type StatusCount } from '@/lib/blocks'
import { formatInteger } from '@/lib/format'
import { healthOf } from '@/lib/status'
import { describeProblems } from './verdictText'

/** The statuses a tile lists beside its value: what needs a look. */
export const PROBLEM_STATUSES: readonly HealthStatus[] = ['critical', 'warning', 'unknown']

/**
 * The marks a count line draws: statuses in `show` that have members, worst
 * first. Offline servers are part of critical, so `critical` brings them, as a
 * mark of their own.
 */
export function listedCounts(counts: StatusCounts, show: readonly HealthStatus[]): StatusCount[] {
  return nonZeroCounts(counts).filter(({ status }) => show.includes(healthOf(status)))
}

/** A tile's route, read from the one navigation registry so a renamed path follows. */
export function navPath(id: NavItem['id']): string {
  return NAV_ITEMS.find((item) => item.id === id)?.path ?? '/'
}

export interface DomainFigures {
  /** online, running or up. */
  value: number
  total: number
  counts: StatusCounts
}

/**
 * The tile's spoken summary: "65 of 68 running, 2 critical, 1 warning, 3 idle".
 * Problems come worst first. Idle is named too: the bar draws it, and a
 * container that is stopped on purpose is still something an operator may ask about.
 */
export function describeDomain({ value, total, counts }: DomainFigures, word: string): string {
  const parts = [`${formatInteger(value)} of ${formatInteger(total)} ${word}`]
  const problems = describeProblems(counts)
  if (problems) parts.push(problems)
  if (counts.idle > 0) parts.push(`${formatInteger(counts.idle)} idle`)
  return parts.join(', ')
}

import type { OverviewSummary, StatusCounts } from '@/api/types'
import type { Freshness } from '@/app/live'
import type { NavItem } from '@/config/nav'
import { worstOf } from '@/lib/status'
import { STATUS_NAME } from '@/ui/status'

export interface NavBadge {
  status: 'critical' | 'warning' | 'unknown'
  /** null when there is no number to trust (NO DATA). */
  count: number | null
  /** For assistive technology and tooltips: "1 critical". */
  label: string
}

/**
 * Only domains the console API counts have a badge: servers and containers. Network, SNMP,
 * Topology and Alerts are absent on purpose: a number beside them would imply a working
 * engine behind it.
 */
const DOMAIN_COUNTS: Partial<Record<NavItem['id'], (summary: OverviewSummary) => StatusCounts>> = {
  servers: (summary) => summary.servers.counts,
  docker: (summary) => summary.containers.counts,
}

/**
 * The worst non-OK state of the screen's domain and how many entities are in it, or null.
 *
 * A dead dashboard must never look healthy, and a missing badge reads as "nothing wrong":
 * with NO DATA an implemented domain shows the unknown ring instead of an old count, and
 * stale counts are spoken as stale.
 */
export function navBadge(
  id: NavItem['id'],
  summary: OverviewSummary | undefined,
  freshness: Freshness = 'live',
): NavBadge | null {
  const domain = DOMAIN_COUNTS[id]
  if (!domain) return null
  if (freshness === 'nodata') return { status: 'unknown', count: null, label: 'no data' }
  const counts = summary ? domain(summary) : undefined
  if (!counts) return null
  const status = worstOf(counts)
  if (!status) return null
  const count = counts[status]
  const stale = freshness === 'stale' ? ', stale' : ''
  return { status, count, label: `${count} ${STATUS_NAME[status]}${stale}` }
}

import type { DomainBreakdown, SiteBreakdown, StatusCounts } from '@/api/types'
import { nonZeroCounts, type StatusCount } from '@/lib/blocks'
import { countStatuses, displayStatus, type DisplayStatus } from '@/lib/status'

/** Sites listed: the worst few. The rest are one link away in Customers & Sites. */
export const SITE_ROWS = 3

/** The widest strip the design draws before it becomes a bar plus counts. */
export const MAX_STRIP_CAPACITY = 20
/** A strip cell is 10px wide with a 2px gap. */
const CELL_PITCH_PX = 12
const CELL_GAP_PX = 2

/**
 * What a site row keeps for the site name (176px of text, the 10px status glyph and two 8px gaps)
 * before the strip may take the rest: the name is what an operator reads to find a site.
 */
export const NAME_RESERVE_PX = 176 + 10 + 2 * 8

/** How many strip cells fit in `widthPx`, up to the design maximum. */
export function capacityFor(widthPx: number): number {
  return Math.min(
    MAX_STRIP_CAPACITY,
    Math.max(0, Math.floor((widthPx + CELL_GAP_PX) / CELL_PITCH_PX)),
  )
}

/** Names for assistive technology; the visible row label comes from the API. */
export const DOMAIN_NAME: Record<DomainBreakdown['domain'], string> = {
  servers: 'Servers',
  containers: 'Containers',
  targets: 'Network targets',
  snmp: 'SNMP devices',
}

export const siteLabel = (site: Pick<SiteBreakdown, 'customerName' | 'siteName'>): string =>
  `${site.customerName} / ${site.siteName}`

/** Where a site row goes: Customers & Sites, filtered to that site (merge into the view with useViewTo). */
export const siteTarget = (siteId: string): { pathname: string; extra: { site: string } } => ({
  pathname: '/customers',
  extra: { site: siteId },
})

/** True when nothing is counted: a bar of zero is an empty track, which reads as "none". */
export const isUncounted = (counts: StatusCounts): boolean => nonZeroCounts(counts).length === 0

/**
 * Nothing monitored at all. The planned SNMP row does not count: it holds
 * inventory only, so it must not make an unmonitored estate look populated.
 */
export function isHealthEmpty(domains: readonly DomainBreakdown[]): boolean {
  return domains.filter((domain) => !domain.planned).every((domain) => isUncounted(domain.counts))
}

/**
 * Sites that have entities, worst first: most critical, then most warning,
 * then most unknown, then by name. The API promises this order, but the panel
 * is only honest about "worst first" if it does not depend on every adapter
 * keeping that promise. A site with nothing in it says nothing about health.
 */
export function rankedSites(sites: readonly SiteBreakdown[]): SiteBreakdown[] {
  return sites
    .filter((site) => site.entities.length > 0)
    .map((site) => ({ site, counts: countStatuses(site.entities.map((entity) => entity.status)) }))
    .sort(
      (a, b) =>
        b.counts.critical - a.counts.critical ||
        b.counts.warning - a.counts.warning ||
        b.counts.unknown - a.counts.unknown ||
        siteLabel(a.site).localeCompare(siteLabel(b.site)),
    )
    .map(({ site }) => site)
}

/**
 * A state's share of a domain total in whole percent. A state with members
 * never reads 0% and one that is not the whole never reads 100%, so a lone
 * failure in a large domain stays visible and a near-complete one stays short
 * of "all".
 */
export function shareText(count: number, total: number): string {
  if (total <= 0 || count <= 0) return '0%'
  if (count >= total) return '100%'
  const percent = Math.round((count / total) * 100)
  if (percent < 1) return '<1%'
  if (percent > 99) return '>99%'
  return `${percent}%`
}

export interface DomainShare extends StatusCount {
  /** Whole percent of the domain total, as text ("<1%", "81%"). */
  share: string
}

/** Every state a domain row's bar draws, worst first, with its count and its share of the total. */
export function domainShares(counts: StatusCounts): { total: number; rows: DomainShare[] } {
  const present = nonZeroCounts(counts)
  const total = present.reduce((sum, { count }) => sum + count, 0)
  return {
    total,
    rows: present.map((entry) => ({ ...entry, share: shareText(entry.count, total) })),
  }
}

/** The legend reads in this order: the shape alphabet, offline directly after the critical it is part of. */
const LEGEND_ORDER: readonly DisplayStatus[] = [
  'healthy',
  'warning',
  'critical',
  'offline',
  'unknown',
  'idle',
]

/** Always explained: what every operator scans for, and the mark of a quiet fleet. */
const ALWAYS_LEGENDED: readonly DisplayStatus[] = ['healthy', 'warning', 'critical']

/**
 * The states the legend explains: OK, WARN and CRIT, then every other state a
 * mark in the panel is drawn in. The planned SNMP row draws no state marks and
 * sites past the listed ones are not drawn, so neither adds to it.
 */
export function legendStates(
  domains: readonly DomainBreakdown[],
  sites: readonly SiteBreakdown[],
): DisplayStatus[] {
  const drawn = new Set<DisplayStatus>(ALWAYS_LEGENDED)
  for (const domain of domains) {
    if (domain.planned) continue
    for (const { status } of nonZeroCounts(domain.counts)) drawn.add(status)
  }
  for (const site of sites) {
    for (const entity of site.entities) drawn.add(displayStatus(entity.status, entity.offline))
  }
  return LEGEND_ORDER.filter((status) => drawn.has(status))
}

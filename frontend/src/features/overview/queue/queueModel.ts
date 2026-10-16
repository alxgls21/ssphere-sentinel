import type { AttentionItem, AttentionResult, ProbeProtocol } from '@/api/types'
import { NAV_ITEMS, type NavItem } from '@/config/nav'
import { formatAge, formatQuantity } from '@/lib/format'
import { displayStatus } from '@/lib/status'
import { STATUS_NAME, STATUS_WORD } from '@/ui/status'

/**
 * Pure logic of the Needs attention queue: what a row says, how it is read
 * aloud, copied and opened, how the severity filter works and what counts as
 * an "update" while the order is locked. No React in here, so it is all unit-tested.
 */

/**
 * A queue row. `protocol` tells an ICMP target from a TCP one; the shared
 * AttentionItem view-model does not carry it yet, so a target without it reads "net".
 */
export type QueueItem = AttentionItem & { protocol?: ProbeProtocol }

/** One poll of the queue, tagged with the request that produced it. */
export interface QueueSnapshot extends Omit<AttentionResult, 'items'> {
  /**
   * Scope and idle toggle of the request. A snapshot of another view replaces
   * the table at once; only a refresh of the same view can wait behind the lock.
   */
  view: string
  items: QueueItem[]
}

/** The detail line joins its facts with this; the lead phrase is the part before it. */
const DETAIL_SEPARATOR = ' · '

export const rowKey = (item: AttentionItem): string => `${item.kind}:${item.id}`

/** An idle row is shown on request but is not a problem (next-problem skips it). */
export const isProblem = (item: AttentionItem): boolean => item.severity !== 'idle'

export function kindLabel(item: QueueItem): string {
  switch (item.kind) {
    case 'server':
      return 'srv'
    case 'container':
      return 'ctr'
    case 'target':
      return item.protocol ?? 'net'
  }
}

/** "Customer / Site" for the SITE column; null when the item carries neither. */
export function siteLabel(item: AttentionItem): string | null {
  const parts = [item.customerName, item.siteName].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : null
}

export const hasSite = (items: readonly AttentionItem[]): boolean =>
  items.some((item) => siteLabel(item) !== null)

/** The first fact of a detail line ("connection refused" of "connection refused · 9 failed probes"). */
export function detailLead(detail: string): string {
  const at = detail.indexOf(DETAIL_SEPARATOR)
  return at < 0 ? detail : detail.slice(0, at)
}

/** "9 minutes", "1 hour", "just now": formatAge spelled out for a screen reader. */
export function spokenAge(iso: string | null, nowMs: number): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return formatQuantity(seconds, 'second')
  if (seconds < 3600) return formatQuantity(Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return formatQuantity(Math.floor(seconds / 3600), 'hour')
  return formatQuantity(Math.floor(seconds / 86_400), 'day')
}

/** What the row shows for its severity: critical, or offline for a server whose agent stopped reporting. */
export const displayed = (item: AttentionItem) => displayStatus(item.severity, item.offline)

/**
 * The accessible name of a row, so one stop reads the whole line:
 * "Row 2 of 9, critical, tcp acme-vpn:443, connection refused, 9 failed probes, Acme Athens-DC, 9 minutes".
 */
export function rowLabel(item: QueueItem, position: number, total: number, nowMs: number): string {
  return [
    `Row ${position} of ${total}`,
    STATUS_NAME[displayed(item)],
    `${kindLabel(item)} ${item.name}`,
    ...item.detail.split(DETAIL_SEPARATOR),
    [item.customerName, item.siteName].filter(Boolean).join(' '),
    spokenAge(item.ageIso, nowMs) ?? 'age unavailable',
  ]
    .filter(Boolean)
    .join(', ')
}

/** Text is data from the backend: collapse anything that could break the one-line promise. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The row as one pasteable line (key y): severity word, kind, name | detail | site | age. */
export function rowCopyText(item: QueueItem, nowMs: number): string {
  const age = item.ageIso ? formatAge(item.ageIso, nowMs) : null
  return [
    `${STATUS_WORD[displayed(item)]} ${kindLabel(item)} ${item.name}`,
    item.detail,
    siteLabel(item),
    age,
  ]
    .filter((part): part is string => Boolean(part))
    .map(oneLine)
    .join(' | ')
}

/** The screen that owns each kind of entity: one registry (config/nav), no path strings here. */
const SCREEN_ID = {
  server: 'servers',
  container: 'docker',
  target: 'network',
} as const satisfies Record<AttentionItem['kind'], NavItem['id']>

const SCREEN_PATH = Object.fromEntries(NAV_ITEMS.map(({ id, path }) => [id, path])) as Record<
  NavItem['id'],
  string
>

/** Where Enter goes: the owning screen, told which entity to focus (merge into the view with useViewTo). */
export function entityTarget(item: AttentionItem): {
  pathname: string
  extra: { focus: string }
} {
  return { pathname: SCREEN_PATH[SCREEN_ID[item.kind]], extra: { focus: item.id } }
}

/* ------------------------------------------------------------------ filter */

export type QueueFilter = 'all' | 'critical' | 'warning'

const FILTER_ORDER: readonly QueueFilter[] = ['all', 'critical', 'warning']

/** Key f: ALL, CRIT, WARN, ALL, ... */
export function nextFilter(current: QueueFilter): QueueFilter {
  const next = (FILTER_ORDER.indexOf(current) + 1) % FILTER_ORDER.length
  return FILTER_ORDER[next] as QueueFilter
}

export function filterItems<T extends AttentionItem>(
  items: readonly T[],
  filter: QueueFilter,
): T[] {
  return filter === 'all' ? [...items] : items.filter((item) => item.severity === filter)
}

export interface QueueCounts {
  critical: number
  warning: number
  /** Everything that is a problem (idle rows are not), the number in the panel header. */
  problems: number
}

export function countItems(items: readonly AttentionItem[]): QueueCounts {
  return {
    critical: items.filter((item) => item.severity === 'critical').length,
    warning: items.filter((item) => item.severity === 'warning').length,
    problems: items.filter(isProblem).length,
  }
}

/* -------------------------------------------------------------- order lock */

export interface QueuedUpdates {
  /** Everything that would change: rows appearing, disappearing or changing state. */
  count: number
  /** Of those, the rows that appear or change (not the ones that leave). */
  arrived: number
  /** Rows that are critical now and were not before (new, or escalated). */
  newCritical: number
}

/**
 * What applying a held snapshot would change on screen: a row appearing,
 * disappearing, or changing severity or state. Values that merely drift (an
 * age, a percentage) are not an update; they wait silently for the next apply.
 */
export function describeUpdates(
  shown: readonly AttentionItem[],
  incoming: readonly AttentionItem[],
): QueuedUpdates | null {
  const before = new Map(shown.map((item) => [rowKey(item), item]))
  const kept = new Set<string>()
  let arrived = 0
  let newCritical = 0
  for (const item of incoming) {
    const key = rowKey(item)
    kept.add(key)
    const prior = before.get(key)
    const changed =
      !prior || prior.severity !== item.severity || prior.stateLabel !== item.stateLabel
    if (!changed) continue
    arrived += 1
    if (item.severity === 'critical' && prior?.severity !== 'critical') newCritical += 1
  }
  let removed = 0
  for (const key of before.keys()) if (!kept.has(key)) removed += 1
  const count = arrived + removed
  return count === 0 ? null : { count, arrived, newCritical }
}

/**
 * The pill: "3 updates, apply (r)", or "2 new incl. CRIT, apply (r)" when a
 * critical is among them (then the number counts what arrived, not what left).
 */
export function updatesText({ count, arrived, newCritical }: QueuedUpdates): string {
  const lead =
    newCritical > 0 ? `${arrived} new incl. CRIT` : `${count} ${count === 1 ? 'update' : 'updates'}`
  return `${lead}, apply (r)`
}

const NO_KEYS: ReadonlySet<string> = new Set()

/** Critical rows that were not in the previous snapshot: the ones that get the one-time arrival outline. */
export function newCriticalKeys(
  current: QueueSnapshot | undefined,
  previous: QueueSnapshot | undefined,
): ReadonlySet<string> {
  if (!current || !previous) return NO_KEYS
  const before = new Set(previous.items.map(rowKey))
  return new Set(
    current.items
      .filter((item) => item.severity === 'critical' && !before.has(rowKey(item)))
      .map(rowKey),
  )
}

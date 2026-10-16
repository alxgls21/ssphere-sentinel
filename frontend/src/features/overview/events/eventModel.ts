import type { EventLevel, HealthStatus, SentinelEvent } from '@/api/types'

/** An event level drawn in the status alphabet. Info has no health state, so it takes the neutral idle bar. */
export const LEVEL_STATUS: Record<EventLevel, HealthStatus> = {
  critical: 'critical',
  warning: 'warning',
  healthy: 'healthy',
  info: 'idle',
}

/** Spoken level, for the glyph's accessible name: "idle" would be wrong for an info line. */
export const LEVEL_NAME: Record<EventLevel, string> = {
  critical: 'critical',
  warning: 'warning',
  healthy: 'ok',
  info: 'info',
}

/** One cell of the tree guide drawn before a nested line. */
export type Guide = 'pipe' | 'blank' | 'tee' | 'elbow'

export interface TailLine {
  event: SentinelEvent
  /** 0 for a line that stands alone or heads a group. */
  depth: number
  /** One cell per level of nesting, outermost first. Empty at depth 0. */
  guides: readonly Guide[]
}

const timeOf = (event: SentinelEvent) => Date.parse(event.at)

/** Every field of an event in a fixed order, so two records of one id can be compared without bias. */
const fingerprint = (event: SentinelEvent): string =>
  JSON.stringify([
    event.at,
    event.level,
    event.subject.kind,
    event.subject.id,
    event.subject.name,
    event.message,
    event.parentId ?? null,
  ])

/**
 * One record per event id, in the order each id first appears. An id names one event: a
 * repeated id (a poll that overlaps the last one, a replayed answer) never counts twice.
 * When two records of an id disagree the earlier timestamp wins, since that is when the event
 * first happened, then the lower field-by-field comparison; the same records give the same
 * answer in any order. Events that merely look alike (same time, same message) have distinct
 * ids and are all kept.
 */
export function canonicalEvents(events: readonly SentinelEvent[]): SentinelEvent[] {
  const chosen = new Map<string, SentinelEvent>()
  for (const event of events) {
    const held = chosen.get(event.id)
    if (held === undefined || precedes(event, held)) chosen.set(event.id, event)
  }
  return [...chosen.values()]
}

function precedes(candidate: SentinelEvent, held: SentinelEvent): boolean {
  const earlier = timeOf(candidate) - timeOf(held)
  if (earlier !== 0 && !Number.isNaN(earlier)) return earlier < 0
  return fingerprint(candidate) < fingerprint(held)
}

/** The event this one nests under, unless the chain of parents loops back (corrupt data: show it unnested). */
function parentOf(event: SentinelEvent, byId: ReadonlyMap<string, SentinelEvent>) {
  const seen = new Set([event.id])
  const parent = event.parentId ? byId.get(event.parentId) : undefined
  for (
    let cursor = parent;
    cursor;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  ) {
    if (seen.has(cursor.id)) return undefined
    seen.add(cursor.id)
  }
  return parent
}

/**
 * The events grouped by the event they nest under: the ones that stand on their
 * own, and for each event its children. An event whose parent is not in the list
 * (older than the range) stands on its own.
 */
export function groupByParent(events: readonly SentinelEvent[]) {
  events = canonicalEvents(events)
  const byId = new Map(events.map((event) => [event.id, event]))
  const children = new Map<string, SentinelEvent[]>()
  const roots: SentinelEvent[] = []
  for (const event of events) {
    const parent = parentOf(event, byId)
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), event])
    else roots.push(event)
  }
  return { roots, children }
}

/**
 * Lines of the tail, newest first, with causally related events nested under
 * their parent (a recovery sits under its failure). A group is placed by its
 * newest line, so a fresh recovery lifts its whole incident to the top; inside
 * a group the lines read in the order they happened.
 */
export function buildTail(events: readonly SentinelEvent[]): TailLine[] {
  const { roots, children } = groupByParent(events)

  const newest = new Map<string, number>()
  const newestOf = (event: SentinelEvent): number => {
    let value = newest.get(event.id)
    if (value === undefined) {
      value = Math.max(timeOf(event), ...(children.get(event.id) ?? []).map(newestOf))
      newest.set(event.id, value)
    }
    return value
  }
  const newestGroupFirst = (a: SentinelEvent, b: SentinelEvent) =>
    newestOf(b) - newestOf(a) || a.id.localeCompare(b.id)
  const inOrderOfOccurrence = (a: SentinelEvent, b: SentinelEvent) =>
    timeOf(a) - timeOf(b) || a.id.localeCompare(b.id)

  const lines: TailLine[] = []
  const visit = (
    event: SentinelEvent,
    depth: number,
    ancestors: readonly ('pipe' | 'blank')[],
    last: boolean,
  ) => {
    lines.push({ event, depth, guides: depth === 0 ? [] : [...ancestors, last ? 'elbow' : 'tee'] })
    // A level whose later siblings are still to come keeps its vertical line running past this branch.
    const continuing: ('pipe' | 'blank')[] =
      depth === 0 ? [] : [...ancestors, last ? 'blank' : 'pipe']
    const kids = (children.get(event.id) ?? []).toSorted(inOrderOfOccurrence)
    kids.forEach((kid, index) => visit(kid, depth + 1, continuing, index === kids.length - 1))
  }
  for (const root of roots.toSorted(newestGroupFirst)) visit(root, 0, [], true)
  return lines
}

/** How many of `latest` are not among the lines on screen. */
export function countUnseen(latest: readonly SentinelEvent[], shown: readonly SentinelEvent[]) {
  const seen = new Set(shown.map((event) => event.id))
  return canonicalEvents(latest).filter((event) => !seen.has(event.id)).length
}

import type { RangeKey, SentinelEvent, SubjectRef } from '@/api/types'
import { RANGE_MS } from '@/lib/range'
import { groupByParent } from '@/ui/events/eventModel'

/** The levels an incident opens at. */
export type IncidentSeverity = 'warning' | 'critical'

export interface IncidentRecovery {
  /** Epoch ms. */
  at: number
  message: string
}

/**
 * Why an incident has no opening: its failure is older than the range, or the events do not reach
 * back to it (the panel holds only the newest ones, so a failure inside the range can fall outside them).
 */
export type MissingOpening = 'before-range' | 'not-shown'

/**
 * A failure and what became of it, read from the events of one range. Derived
 * from the same events as the log, so it knows nothing the log does not show.
 */
export interface Incident {
  /** The opening event's id, or the recovery's when the opening is not among the events. */
  id: string
  subject: SubjectRef
  /** The level the incident opened at. Null when the opening is not among the events: it is not known. */
  severity: IncidentSeverity | null
  /** Epoch ms of the opening event. Null when the opening is not among the events. */
  start: number | null
  /** The opening event's message. Null when the opening is not among the events. */
  message: string | null
  recovery: IncidentRecovery | null
  status: 'ongoing' | 'resolved'
  /** Recovery minus start, or now minus start while ongoing. Null when the start is not known. */
  durationMs: number | null
  /** Set when the recovery is among the events but the failure it closes is not. */
  missingOpening: MissingOpening | null
}

/** Every event nested under `event`, at any depth. The groups form a forest, so this ends. */
function descendantsOf(
  event: SentinelEvent,
  children: ReadonlyMap<string, readonly SentinelEvent[]>,
): SentinelEvent[] {
  const found: SentinelEvent[] = []
  const queue = [...(children.get(event.id) ?? [])]
  for (let next = queue.shift(); next; next = queue.shift()) {
    found.push(next)
    queue.push(...(children.get(next.id) ?? []))
  }
  return found
}

const timeOf = (event: SentinelEvent) => Date.parse(event.at)

/** The same monitored thing: both name it (a kind and an id), and the names agree. */
export function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
  const named = (subject: SubjectRef) => Boolean(subject.kind) && Boolean(subject.id)
  return named(a) && named(b) && a.kind === b.kind && a.id === b.id
}

/**
 * The first recovery of `subject` that follows `since` (epoch ms, or null when the failure is
 * not known). Nesting says a failure led to another event, not that they share an incident: a
 * healthy event of another subject, or one that names no subject, closes nothing, and neither
 * does one that precedes the failure. Later recoveries are the same incident settling again.
 */
function firstRecovery(
  events: readonly SentinelEvent[],
  subject: SubjectRef,
  since: number | null,
): SentinelEvent | undefined {
  return events
    .filter(
      (event) =>
        event.level === 'healthy' &&
        sameSubject(event.subject, subject) &&
        (since === null || timeOf(event) >= since),
    )
    .toSorted((a, b) => timeOf(a) - timeOf(b) || a.id.localeCompare(b.id))[0]
}

const recoveryOf = (event: SentinelEvent | undefined): IncidentRecovery | null =>
  event ? { at: timeOf(event), message: event.message } : null

/** Ongoing worst first, then the most recent start. An incident without an opening is the oldest there is. */
function compareIncidents(a: Incident, b: Incident): number {
  const rank = (incident: Incident) =>
    incident.status === 'resolved' ? 2 : incident.severity === 'critical' ? 0 : 1
  const startKey = (incident: Incident) => incident.start ?? Number.NEGATIVE_INFINITY
  const startedLater = startKey(b) - startKey(a)
  return (
    rank(a) - rank(b) ||
    (Number.isNaN(startedLater) ? 0 : startedLater) ||
    (b.recovery?.at ?? 0) - (a.recovery?.at ?? 0) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * The incidents of a list of events. A warning or critical event that nests
 * under nothing opens one; the first healthy event of the same subject nested under it
 * closes it (a healthy event of another subject, such as the recovery of a failure that
 * followed from this one, does not), and info events nested under it never do. Events carry no
 * acknowledgement, so none is claimed. Events are taken once per id. A recovery whose
 * failure is not in the list opens one without an opening: it began before the range,
 * or, when the list is `truncated` to the newest events of the range, it may have begun
 * inside the range beyond what the list reaches. An opening whose own parent is outside
 * the list stands on its own, as in the log.
 *
 * `now` is injected so the model stays pure: it ends an ongoing incident's
 * duration, nothing else.
 */
export function buildIncidents(
  events: readonly SentinelEvent[],
  now: number,
  truncated = false,
): Incident[] {
  const { roots, children } = groupByParent(events)
  const ids = new Set(events.map((event) => event.id))
  const incidents: Incident[] = []

  for (const root of roots) {
    if (root.level !== 'warning' && root.level !== 'critical') continue
    const nested = descendantsOf(root, children)
    const start = timeOf(root)
    const recovery = recoveryOf(firstRecovery(nested, root.subject, start))
    incidents.push({
      id: root.id,
      subject: root.subject,
      severity: root.level,
      start,
      message: root.message,
      recovery,
      status: recovery ? 'resolved' : 'ongoing',
      durationMs: Math.max(0, (recovery?.at ?? now) - start),
      missingOpening: null,
    })
  }

  // What is left of an incident whose failure is not among the events: its recovery names that
  // failure as its parent, so recoveries are grouped by that name. The
  // failure is unknown, so each subject's recovery stands for its own incident: a recovery of
  // one subject is never read as another's.
  const strays = new Map<string, SentinelEvent[]>()
  for (const root of roots) {
    if (root.level === 'warning' || root.level === 'critical') continue
    if (root.parentId === undefined || ids.has(root.parentId)) continue
    const key = JSON.stringify([root.parentId, root.subject.kind, root.subject.id])
    strays.set(key, [...(strays.get(key) ?? []), root])
  }
  for (const group of strays.values()) {
    const nested = group.flatMap((event) => [event, ...descendantsOf(event, children)])
    const closing = firstRecovery(nested, (group[0] as SentinelEvent).subject, null)
    const recovery = recoveryOf(closing)
    if (!closing || !recovery) continue
    incidents.push({
      id: closing.id,
      subject: closing.subject,
      severity: null,
      start: null,
      message: null,
      recovery,
      status: 'resolved',
      durationMs: null,
      missingOpening: truncated ? 'not-shown' : 'before-range',
    })
  }

  return incidents.toSorted(compareIncidents)
}

export interface IncidentCounts {
  ongoing: number
  resolved: number
}

export function countIncidents(incidents: readonly Incident[]): IncidentCounts {
  const ongoing = incidents.filter((incident) => incident.status === 'ongoing').length
  return { ongoing, resolved: incidents.length - ongoing }
}

/** The stretch of time a timeline shows: the range, ending at `now`. */
export interface Axis {
  start: number
  end: number
}

export const axisOf = (now: number, range: RangeKey): Axis => ({
  start: now - RANGE_MS[range],
  end: now,
})

/** Where an incident sits on the axis, as fractions of its length (0 is the start, 1 is now). */
export interface Span {
  from: number
  to: number
  /** The incident began before the axis does, so its bar is cut at the left edge. */
  clipped: boolean
}

/**
 * An ongoing incident runs to the right edge, an incident older than the axis
 * starts at the left edge, and nothing leaves the axis.
 */
export function spanOf(incident: Incident, axis: Axis): Span {
  const length = axis.end - axis.start
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - axis.start) / length))
  const from = incident.start === null ? 0 : at(incident.start)
  const to = incident.recovery ? at(incident.recovery.at) : 1
  return {
    from,
    to: Math.max(from, to),
    clipped: incident.start === null || incident.start < axis.start,
  }
}

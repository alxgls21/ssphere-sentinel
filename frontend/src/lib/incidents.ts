import type {
  EngineState,
  EngineStatus,
  HealthStatus,
  IncidentCloseReason,
  IncidentCounts,
  IncidentDetail,
  IncidentEntityKind,
  IncidentItem,
  IncidentList,
  IncidentOverview,
  IncidentStatus,
  IncidentStep,
  SentinelEvent,
  EventLevel,
} from '@/api/types'
import { EMPTY, formatAge, formatDuration } from './format'

/**
 * What an incident and the alert engine say in words. The status, the severity, the reason and every
 * time are the API's: this only names them, and never decides a status, an end or a moment. An
 * acknowledged incident is still open, and an incident that ended without a recovery says why.
 */

/* ------------------------------------------------------------------ status */

export const STATUS_WORD: Record<IncidentStatus, string> = {
  active: 'ACTIVE',
  acknowledged: 'ACKNOWLEDGED',
  recovered: 'RECOVERED',
  closed: 'CLOSED',
}

/** What each status means, in one sentence: an acknowledged incident is open, a closed one never recovered. */
export const STATUS_SENTENCE: Record<IncidentStatus, string> = {
  active: 'Open and not yet seen by anyone.',
  acknowledged: 'Seen by someone, and still open: the condition has not cleared.',
  recovered: 'Ended: the condition cleared and the recovery was confirmed.',
  closed: 'Ended without a recovery: monitoring of it ended.',
}

export const isOpen = (status: IncidentStatus): boolean =>
  status === 'active' || status === 'acknowledged'

/** Active and acknowledged: the incidents that are still open. */
export const openCount = (counts: IncidentCounts): number => counts.active + counts.acknowledged

/** Recovered and closed: the history. */
export const endedCount = (counts: IncidentCounts): number => counts.recovered + counts.closed

export const allCount = (counts: IncidentCounts): number => openCount(counts) + endedCount(counts)

export const SEVERITY_WORD = { critical: 'CRIT', warning: 'WARN' } as const

/* ------------------------------------------------------------------ entity */

export const KIND_LABEL: Record<IncidentEntityKind, string> = {
  server: 'Server',
  container: 'Container',
  target: 'Network target',
  device: 'SNMP device',
  interface: 'Interface',
}

/** The three letters a dense row leads an entity with. */
export const KIND_SHORT: Record<IncidentEntityKind, string> = {
  server: 'srv',
  container: 'ctr',
  target: 'net',
  device: 'dev',
  interface: 'if',
}

/**
 * Where an incident's object opens, for `useViewTo`: the screen that owns it, told which entity to
 * focus when that screen has no page of its own. Only for an object the API says the user may see
 * (`entityVisible`): the reference of one that is gone or hidden opens nothing.
 */
export function entityTarget(
  kind: IncidentEntityKind,
  ref: string,
): { pathname: string; extra: Record<string, string> } {
  const at = (path: string) => `${path}/${encodeURIComponent(ref)}`
  switch (kind) {
    case 'server':
      return { pathname: at('/servers'), extra: {} }
    case 'target':
      return { pathname: at('/network'), extra: {} }
    case 'device':
      return { pathname: at('/snmp'), extra: {} }
    case 'container':
      return { pathname: '/docker', extra: { focus: ref } }
    case 'interface': {
      // `<device>:<ifIndex>`: the device's page, with that interface's history open.
      const [device = '', ifIndex = ''] = ref.split(':')
      return {
        pathname: `/snmp/${encodeURIComponent(device)}`,
        extra: ifIndex ? { interface: ifIndex } : {},
      }
    }
  }
}

/** The page of one incident. A path segment, so the id is encoded. */
export const incidentPath = (id: string): string => `/alerts/${encodeURIComponent(id)}`

/* --------------------------------------------------------------- condition */

/** What a rule fires on. `warning` also fires on critical. */
export const HEALTH_CONDITION_TEXT = {
  critical: 'Critical',
  warning: 'Warning or critical',
  unknown: 'Unknown (no current monitoring data)',
} as const

const REASON: Record<IncidentEntityKind, Record<string, string>> = {
  server: {
    never_seen: 'never reported',
    offline: 'offline: no heartbeat',
    resources: 'resource usage at a limit',
    status_warning: 'reports a warning',
    no_telemetry: 'alive, with no current reading',
  },
  container: {
    not_observable: 'not observable: its host or Docker report is not current',
    dead: 'dead',
    unhealthy: 'unhealthy: failing its health check',
    restarting: 'restarting',
    other: 'in a state the console does not know',
  },
  target: {
    no_agent: 'no agent assigned',
    agent_offline: 'its agent is not reporting',
    no_measurement: 'never measured',
    stale: 'measurement out of date',
    failing: 'every recent measurement failed',
    failed: 'the latest measurement failed',
    latency: 'latency over the limit',
    loss: 'loss over the limit',
  },
  device: {
    no_agent: 'no agent assigned',
    agent_offline: 'its agent is not reporting',
    no_poll: 'never polled',
    stale: 'poll out of date',
    unreachable: 'no response to polls',
  },
  interface: {
    device_unavailable: 'its device is not available',
    absent: 'absent',
    down: 'down, though enabled',
    other: 'in a state the console does not know',
  },
}

/** A reason in words; one this build does not know is shown as it came, never dropped. */
export const reasonText = (kind: IncidentEntityKind, reason: string | null): string | null =>
  reason === null ? null : (REASON[kind][reason] ?? reason.replaceAll('_', ' '))

/** "Critical · offline: no heartbeat": the condition the rule fired on, and the reason when it was narrowed. */
export function conditionText(item: IncidentItem): string {
  const why = reasonText(item.entity.kind, item.condition.reason)
  return `${HEALTH_CONDITION_TEXT[item.condition.health]}${why ? ` · ${why}` : ''}`
}

/** The shorter form for a row: the reason when there is one, else what the rule fires on. */
export function conditionBrief(item: IncidentItem): string {
  return (
    reasonText(item.entity.kind, item.condition.reason) ??
    HEALTH_CONDITION_TEXT[item.condition.health]
  )
}

export const CLOSE_REASON_TEXT: Record<IncidentCloseReason, string> = {
  entity_removed: 'The object no longer exists.',
  entity_disabled: 'The object was disabled or stopped.',
  entity_moved: 'The object moved to another site.',
  out_of_scope: 'The object left the rule’s scope.',
  rule_disabled: 'The rule was disabled.',
  rule_changed: 'The rule’s condition or severity changed.',
}

/* ---------------------------------------------------------------- timeline */

const HEALTH_WORD: Record<HealthStatus, string> = {
  healthy: 'ok',
  warning: 'warning',
  critical: 'critical',
  unknown: 'unknown',
  idle: 'idle',
}

/** What was observed at a step, where anything was: "critical, offline: no heartbeat". */
function observed(step: IncidentStep, kind: IncidentEntityKind): string | null {
  if (step.health === null) return null
  // A healthy reason (ok, running, up) only repeats the word "ok".
  const why = step.health === 'healthy' ? null : reasonText(kind, step.reason)
  return `${HEALTH_WORD[step.health]}${why ? `, ${why}` : ''}`
}

/** One step in words. Nothing is added to what the API recorded. */
export function stepText(step: IncidentStep, item: IncidentItem): string {
  const seen = observed(step, item.entity.kind)
  const suffix = seen ? ` (${seen})` : ''
  switch (step.kind) {
    case 'opened':
      return `Opened${suffix}`
    case 'acknowledged':
      return step.actor ? `Acknowledged by ${step.actor}` : 'Acknowledged'
    case 'recovery_started':
      return `Recovery began: the condition cleared${suffix}`
    case 'recovery_interrupted':
      return `Recovery interrupted: the condition returned${suffix}`
    case 'recovered':
      return `Recovered: the recovery was confirmed${suffix}`
    case 'closed':
      return item.closeReason ? `Closed: ${CLOSE_REASON_TEXT[item.closeReason]}` : 'Ended'
  }
}

const STEP_LEVEL = (step: IncidentStep, item: IncidentItem): EventLevel => {
  switch (step.kind) {
    case 'opened':
      return item.severity
    case 'recovery_interrupted':
      return 'warning'
    case 'recovered':
      return 'healthy'
    default:
      return 'info'
  }
}

/**
 * The incident's own timeline as the events the log draws: the opening, with every later step
 * nested under it. Each line is one recorded step at its recorded time; nothing is derived.
 */
export function timelineEvents(detail: IncidentDetail): SentinelEvent[] {
  const { item, timeline } = detail
  const subject = { kind: item.entity.kind, id: item.entity.ref, name: item.entity.label }
  const idOf = (step: IncidentStep, index: number) => `${item.id}:${index}:${step.kind}`
  const opening = timeline.findIndex((step) => step.kind === 'opened')
  const parentId = opening >= 0 ? idOf(timeline[opening] as IncidentStep, opening) : undefined
  return timeline.map((step, index) => ({
    id: idOf(step, index),
    at: step.at,
    level: STEP_LEVEL(step, item),
    subject,
    message: stepText(step, item),
    ...(parentId !== undefined && index !== opening ? { parentId } : {}),
  }))
}

/* --------------------------------------------------------------- the list */

/** Seconds of an open incident, to its moment of reading; the API gives times, never a duration. */
export function openFor(item: IncidentItem, nowMs: number): string {
  if (!isOpen(item.status)) return EMPTY
  const since = Date.parse(item.openedAt)
  return Number.isNaN(since) ? EMPTY : formatDuration(Math.max(0, (nowMs - since) / 1000))
}

/** The Overview's figures: the API's counts over the whole scope, and the first few open incidents. */
export function incidentOverviewOf(open: IncidentList, critical: IncidentList): IncidentOverview {
  return {
    generatedAt: open.generatedAt,
    open: openCount(open.counts),
    active: open.counts.active,
    acknowledged: open.counts.acknowledged,
    critical: openCount(critical.counts),
    recent: open.items,
  }
}

/* ------------------------------------------------------------------ engine */

export const ENGINE_WORD: Record<EngineState, string> = {
  running: 'RUNNING',
  failed: 'FAILED',
  stale: 'STALE',
  never_started: 'NEVER STARTED',
}

/** The glyph an engine state is drawn in: never "ok" for an engine that has not started. */
export const ENGINE_HEALTH: Record<EngineState, HealthStatus> = {
  running: 'healthy',
  failed: 'critical',
  stale: 'warning',
  never_started: 'unknown',
}

/** The engine is not evaluating as it should: what the incidents say may be out of date or missing. */
export const engineNeedsAttention = (status: EngineStatus): boolean => status.state !== 'running'

const ERROR_CATEGORY = { database: 'a database error', internal: 'an internal error' } as const

/**
 * What the engine's state means for what is on screen. `nowMs` is the clock of the data. A state
 * that is not running always says that the incidents shown may be out of date, and that an empty
 * list is not good news.
 */
export function engineSentence(status: EngineStatus, nowMs: number): string {
  const ago = (iso: string | null) => (iso ? `${formatAge(iso, nowMs)} ago` : 'never')
  switch (status.state) {
    case 'running':
      return `Evaluating${status.intervalSeconds ? ` every ${status.intervalSeconds} s` : ''}; its latest cycle succeeded ${ago(status.lastSuccessAt)}.`
    case 'failed': {
      const why = status.lastError ? ` with ${ERROR_CATEGORY[status.lastError.category]}` : ''
      return `Its latest cycle failed${why} ${ago(status.lastError?.at ?? status.lastAttemptAt)}; the last success was ${ago(status.lastSuccessAt)}. Incidents shown may be out of date.`
    }
    case 'stale':
      return `It has made no attempt for ${ago(status.lastAttemptAt).replace(' ago', '')} (more than ${formatDuration(status.staleAfterSeconds)}): it has stopped or is stuck, so no incident opens or recovers and those shown may be out of date.`
    case 'never_started':
      return 'The alert engine has never run, so nothing has been evaluated. An empty list here does not mean everything is healthy.'
  }
}

/** The caveat of a running engine that is not counting silences yet. */
export const engineCaveat = (status: EngineStatus): string | null =>
  status.state === 'running' && status.monitoringSince === null
    ? 'The agents’ heartbeats are all missing at once, so the engine is not counting silences as incidents yet.'
    : null

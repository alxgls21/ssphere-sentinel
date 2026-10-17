import type { SentinelApi } from '../client'
import type {
  EngineState,
  EngineStatus,
  HealthStatus,
  IncidentCloseReason,
  IncidentConditionHealth,
  IncidentCounts,
  IncidentDetail,
  IncidentEntityKind,
  IncidentEventKind,
  IncidentItem,
  IncidentList,
  IncidentListOptions,
  IncidentRule,
  IncidentStatus,
  IncidentStep,
} from '../types'
import { listQuery, parsePage } from './lists'
import { array, flag, nullableText, nullableTime, oneOf, record, text, time, whole } from './parse'
import type { Transport } from './transport'

/**
 * The console API's incidents: the list (`incidents/`), one incident with its rule and timeline
 * (`incidents/<id>/`), its acknowledgement (`incidents/<id>/acknowledge/`) and the alert engine's
 * state (`alerts/engine-status/`). What the alert engine recorded is read as it is: nothing here
 * judges health again, works out a status or makes a time up. Every answer is validated and
 * mapped by naming each field; one that does not fit is a `bad_response` error, never a guess.
 */

const STATUS: readonly IncidentStatus[] = ['active', 'acknowledged', 'recovered', 'closed']
const SEVERITY = ['critical', 'warning'] as const
const KIND: readonly IncidentEntityKind[] = ['server', 'container', 'target', 'device', 'interface']
const CONDITION: readonly IncidentConditionHealth[] = ['critical', 'warning', 'unknown']
const CLOSE_REASON: readonly IncidentCloseReason[] = [
  'entity_removed',
  'entity_disabled',
  'entity_moved',
  'out_of_scope',
  'rule_disabled',
  'rule_changed',
]
const EVENT: readonly IncidentEventKind[] = [
  'opened',
  'acknowledged',
  'recovery_started',
  'recovery_interrupted',
  'recovered',
  'closed',
]
const HEALTH: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']
const ENGINE: readonly EngineState[] = ['running', 'failed', 'stale', 'never_started']
const ERROR_CATEGORY = ['database', 'internal'] as const

/** An empty string is how the API says "nothing": a reason or a name that is not there. */
const nullableWord = (value: unknown): string | null => (value === null ? null : text(value))

export function parseIncidentItem(raw: unknown): IncidentItem {
  const row = record(raw)
  const condition = record(row.condition)
  const entity = record(row.entity)
  const rule = record(row.rule)
  return {
    id: text(row.id),
    status: oneOf(STATUS, row.status),
    severity: oneOf(SEVERITY, row.severity),
    condition: {
      health: oneOf(CONDITION, condition.health),
      reason: nullableWord(condition.reason),
    },
    entity: { kind: oneOf(KIND, entity.kind), ref: text(entity.ref), label: text(entity.label) },
    rule: { id: text(rule.id), name: text(rule.name) },
    siteId: nullableText(row.siteId),
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
    startedAt: time(row.startedAt),
    openedAt: time(row.openedAt),
    acknowledgedAt: nullableTime(row.acknowledgedAt),
    acknowledgedBy: nullableText(row.acknowledgedBy),
    recoveredAt: nullableTime(row.recoveredAt),
    closedAt: nullableTime(row.closedAt),
    closeReason: row.closeReason === null ? null : oneOf(CLOSE_REASON, row.closeReason),
    canAcknowledge: flag(row.canAcknowledge),
  }
}

function parseIncidentCounts(raw: unknown): IncidentCounts {
  const row = record(raw)
  return {
    active: whole(row.active),
    acknowledged: whole(row.acknowledged),
    recovered: whole(row.recovered),
    closed: whole(row.closed),
  }
}

export function parseIncidentList(raw: unknown): IncidentList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseIncidentItem),
    page: parsePage(row.page),
    counts: parseIncidentCounts(row.counts),
    scopeTotal: whole(row.scopeTotal),
  }
}

function parseRule(raw: unknown): IncidentRule {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    enabled: flag(row.enabled),
  }
}

function parseStep(raw: unknown): IncidentStep {
  const row = record(raw)
  return {
    at: time(row.at),
    kind: oneOf(EVENT, row.kind),
    health: row.health === null ? null : oneOf(HEALTH, row.health),
    reason: nullableWord(row.reason),
    actor: nullableText(row.actor),
  }
}

export function parseIncidentDetail(raw: unknown): IncidentDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseIncidentItem(row.item),
    rule: parseRule(row.rule),
    entityVisible: flag(row.entityVisible),
    timeline: array(row.timeline).map(parseStep),
  }
}

export function parseEngineStatus(raw: unknown): EngineStatus {
  const row = record(raw)
  let lastError: EngineStatus['lastError'] = null
  if (row.lastError !== null) {
    const error = record(row.lastError)
    lastError = { at: time(error.at), category: oneOf(ERROR_CATEGORY, error.category) }
  }
  return {
    generatedAt: time(row.generatedAt),
    state: oneOf(ENGINE, row.state),
    stale: flag(row.stale),
    staleAfterSeconds: whole(row.staleAfterSeconds),
    intervalSeconds: row.intervalSeconds === null ? null : whole(row.intervalSeconds, 1),
    startedAt: nullableTime(row.startedAt),
    lastSuccessAt: nullableTime(row.lastSuccessAt),
    lastAttemptAt: nullableTime(row.lastAttemptAt),
    lastCycleMs: row.lastCycleMs === null ? null : whole(row.lastCycleMs),
    lastError,
    monitoringSince: nullableTime(row.monitoringSince),
  }
}

/** The list query: the shared parameters, plus the severity and the kind. */
function incidentQuery(options: IncidentListOptions): Record<string, string | undefined> {
  return {
    ...listQuery(options),
    severity: options.severity && options.severity !== 'all' ? options.severity : undefined,
    kind: options.kind && options.kind !== 'all' ? options.kind : undefined,
  }
}

/** An incident id is a path segment: it is encoded, never trusted. */
const incidentPath = (id: string) => `incidents/${encodeURIComponent(id)}/`

export const listIncidents =
  (transport: Transport): SentinelApi['listIncidents'] =>
  async (options = {}) =>
    parseIncidentList(
      await transport.get('incidents/', { signal: options.signal, query: incidentQuery(options) }),
    )

export const getIncident =
  (transport: Transport): SentinelApi['getIncident'] =>
  async (id, options) =>
    parseIncidentDetail(await transport.get(incidentPath(id), { signal: options?.signal }))

/** A write: the transport sends the CSRF token and signs the request with the session. */
export const acknowledgeIncident =
  (transport: Transport): SentinelApi['acknowledgeIncident'] =>
  async (id, options) =>
    parseIncidentDetail(
      await transport.post(`${incidentPath(id)}acknowledge/`, undefined, {
        signal: options?.signal,
      }),
    )

export const getEngineStatus =
  (transport: Transport): SentinelApi['getEngineStatus'] =>
  async (options) =>
    parseEngineStatus(await transport.get('alerts/engine-status/', { signal: options?.signal }))

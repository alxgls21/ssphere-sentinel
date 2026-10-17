import type { SentinelApi } from '../client'
import type {
  HealthStatus,
  TargetAgent,
  TargetAvailability,
  TargetConfig,
  TargetDetail,
  TargetList,
  TargetListItem,
  TargetListOptions,
  TargetMeasurement,
  TargetProtocol,
  TargetReason,
  TargetSeries,
  TargetSeriesOptions,
} from '../types'
import {
  array,
  bad,
  flag,
  nullableText,
  nullableTime,
  number,
  oneOf,
  record,
  text,
  time,
  whole,
} from './parse'
import { parseCounts, parsePage } from './servers'
import type { Transport } from './transport'

/**
 * The console API's network targets: the list (`targets/`), one target with its recent
 * measurements and its 24 hours (`targets/<id>/`) and a target's history (`targets/<id>/series/`).
 * Every answer is validated and mapped onto the view-models of api/types; one that does not fit is
 * a `bad_response` error, never a guess.
 */

const HEALTH: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']
const PROTOCOL: readonly TargetProtocol[] = ['icmp', 'tcp']
const AGENT_STATUS: readonly TargetAgent['status'][] = ['online', 'offline', 'unknown']
const REASON: readonly TargetReason[] = [
  'disabled',
  'no_agent',
  'agent_offline',
  'no_measurement',
  'stale',
  'failing',
  'failed',
  'latency',
  'loss',
  'ok',
]

const nullableNumber = (value: unknown): number | null => (value === null ? null : number(value))

function parseAgent(raw: unknown): TargetAgent | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    status: oneOf(AGENT_STATUS, row.status),
    lastSeenAt: nullableTime(row.lastSeenAt),
    serverId: text(row.serverId),
    serverName: text(row.serverName),
  }
}

function parseConfig(raw: unknown): TargetConfig {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    address: text(row.address),
    protocol: oneOf(PROTOCOL, row.protocol),
    port: row.port === null ? null : whole(row.port),
    enabled: flag(row.enabled),
    intervalSeconds: whole(row.intervalSeconds, 1),
    timeoutSeconds: whole(row.timeoutSeconds, 1),
    circuitId: nullableText(row.circuitId),
    siteId: nullableText(row.siteId),
    agentAssigned: flag(row.agentAssigned),
    agent: parseAgent(row.agent),
  }
}

function parseMeasurement(raw: unknown): TargetMeasurement {
  const row = record(raw)
  return {
    measuredAt: time(row.measuredAt),
    receivedAt: time(row.receivedAt),
    success: flag(row.success),
    latencyMs: nullableNumber(row.latencyMs),
    lossPercent: number(row.lossPercent),
    probeCount: whole(row.probeCount),
    successfulProbes: whole(row.successfulProbes),
    failureReason: nullableText(row.failureReason),
  }
}

function parseItem(raw: unknown): TargetListItem {
  const row = record(raw)
  return {
    target: parseConfig(row.target),
    latest: row.latest === null ? null : parseMeasurement(row.latest),
    stale: flag(row.stale),
    health: oneOf(HEALTH, row.health),
    reason: oneOf(REASON, row.reason),
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
  }
}

export function parseTargetList(raw: unknown): TargetList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseItem),
    page: parsePage(row.page),
    counts: parseCounts(row.counts),
    scopeTotal: whole(row.scopeTotal),
  }
}

function parseAvailability(raw: unknown): TargetAvailability {
  const row = record(raw)
  return {
    from: time(row.from),
    to: time(row.to),
    measurements: whole(row.measurements),
    successful: whole(row.successful),
    percent: nullableNumber(row.percent),
    expectedMeasurements: whole(row.expectedMeasurements),
    coveragePercent: nullableNumber(row.coveragePercent),
  }
}

export function parseTargetDetail(raw: unknown): TargetDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseItem(row.item),
    measurements: array(row.measurements).map(parseMeasurement),
    availability24h: parseAvailability(row.availability24h),
  }
}

export function parseTargetSeries(raw: unknown): TargetSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const parallel = <T>(value: unknown, read: (sample: unknown) => T): T[] => {
    const values = array(value).map(read)
    if (values.length !== t.length) throw bad()
    return values
  }
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    latencyMs: parallel(row.latencyMs, nullableNumber),
    latencyMaxMs: parallel(row.latencyMaxMs, nullableNumber),
    lossPercent: parallel(row.lossPercent, nullableNumber),
    measurements: parallel(row.measurements, (sample) => whole(sample)),
    failed: parallel(row.failed, (sample) => whole(sample)),
  }
}

/** The query string of a list request: what is left at its default is not sent. */
function listQuery(options: TargetListOptions): Record<string, string | undefined> {
  const q = options.q?.trim()
  return {
    customer: options.scope?.customerId ?? undefined,
    site: options.scope?.siteId ?? undefined,
    q: q ? q : undefined,
    status: options.status && options.status !== 'all' ? options.status : undefined,
    sort: options.sort,
    dir: options.dir,
    page: options.page === undefined ? undefined : String(options.page),
    pageSize: options.pageSize === undefined ? undefined : String(options.pageSize),
  }
}

export const listTargets =
  (transport: Transport): SentinelApi['listTargets'] =>
  async (options: TargetListOptions = {}) =>
    parseTargetList(
      await transport.get('targets/', { signal: options.signal, query: listQuery(options) }),
    )

export const getTarget =
  (transport: Transport): SentinelApi['getTarget'] =>
  async (id, options = {}) =>
    parseTargetDetail(
      await transport.get(`targets/${encodeURIComponent(id)}/`, { signal: options.signal }),
    )

export const getTargetSeries =
  (transport: Transport): SentinelApi['getTargetSeries'] =>
  async ({ targetId, range, signal }: TargetSeriesOptions) =>
    parseTargetSeries(
      await transport.get(`targets/${encodeURIComponent(targetId)}/series/`, {
        signal,
        query: { range },
      }),
    )

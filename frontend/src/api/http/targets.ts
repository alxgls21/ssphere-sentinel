import type { SentinelApi } from '../client'
import type {
  TargetAgentEntry,
  TargetAvailability,
  TargetConfig,
  TargetDeleted,
  TargetDetail,
  TargetInput,
  TargetList,
  TargetListItem,
  TargetListOptions,
  TargetMeasurement,
  TargetPatch,
  TargetProtocol,
  TargetReason,
  TargetSeries,
  TargetSeriesOptions,
} from '../types'
import { listQuery, parseStandardList } from './lists'
import {
  HEALTH,
  parseMonitoringAgent,
  array,
  flag,
  nullableNumber,
  nullableText,
  number,
  oneOf,
  parallel,
  record,
  text,
  time,
  whole,
} from './parse'
import { body } from './records'
import type { Transport } from './transport'

/**
 * The console API's network targets: the list (`targets/`), one target with its recent
 * measurements, its 24 hours and its entry for the agent's targets file (`targets/<id>/`), a
 * target's history (`targets/<id>/series/`), and the writes: a new target (POST `targets/`), a
 * change (PATCH `targets/<id>/`) and a deletion (DELETE). Every answer is validated and mapped
 * onto the view-models of api/types; one that does not fit is a `bad_response` error, never a
 * guess. What a write carries is named field by field.
 */

const PROTOCOL: readonly TargetProtocol[] = ['icmp', 'tcp']
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
    expectedSlaPercent: number(row.expectedSlaPercent),
    customerLabel: nullableText(row.customerLabel),
    circuitId: nullableText(row.circuitId),
    siteId: nullableText(row.siteId),
    agentAssigned: flag(row.agentAssigned),
    agent: parseMonitoringAgent(row.agent),
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
  return parseStandardList(raw, parseItem)
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

/** The agent's own keys, read as they are: this is copied into the agent's file verbatim. */
function parseAgentEntry(raw: unknown): TargetAgentEntry {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    hostname_or_ip: text(row.hostname_or_ip),
    protocol: oneOf(PROTOCOL, row.protocol),
    port: row.port === null ? null : whole(row.port, 1),
    enabled: flag(row.enabled),
    monitoring_interval_seconds: whole(row.monitoring_interval_seconds, 1),
    timeout_seconds: whole(row.timeout_seconds, 1),
    probe_count: whole(row.probe_count, 1),
  }
}

export function parseTargetDetail(raw: unknown): TargetDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseItem(row.item),
    measurements: array(row.measurements).map(parseMeasurement),
    availability24h: parseAvailability(row.availability24h),
    agentEntry: parseAgentEntry(row.agentEntry),
  }
}

export function parseTargetDeleted(raw: unknown): TargetDeleted {
  const row = record(raw)
  const deleted = record(row.deleted)
  return {
    generatedAt: time(row.generatedAt),
    deleted: {
      id: text(deleted.id),
      name: text(deleted.name),
      measurements: whole(deleted.measurements),
    },
  }
}

/** The fields of a target, named one by one: nothing else the caller holds can go out. */
function targetBody(input: TargetPatch): Record<string, unknown> {
  return body({
    name: input.name,
    address: input.address,
    protocol: input.protocol,
    port: input.port,
    enabled: input.enabled,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    expectedSlaPercent: input.expectedSlaPercent,
    customerLabel: input.customerLabel,
    circuitId: input.circuitId,
    siteId: input.siteId,
    agentId: input.agentId,
  })
}

/** A target id is a path segment: it is encoded, never trusted. */
const targetPath = (id: string) => `targets/${encodeURIComponent(id)}/`

export const createTarget =
  (transport: Transport): SentinelApi['createTarget'] =>
  async (input: TargetInput, options) =>
    parseTargetDetail(
      await transport.post('targets/', targetBody(input), { signal: options?.signal }),
    )

export const updateTarget =
  (transport: Transport): SentinelApi['updateTarget'] =>
  async (id, patch, options) =>
    parseTargetDetail(
      await transport.patch(targetPath(id), targetBody(patch), { signal: options?.signal }),
    )

export const deleteTarget =
  (transport: Transport): SentinelApi['deleteTarget'] =>
  async (id, options) =>
    parseTargetDeleted(await transport.delete(targetPath(id), { signal: options?.signal }))

export function parseTargetSeries(raw: unknown): TargetSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const column = parallel(t)
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    latencyMs: column(row.latencyMs, nullableNumber),
    latencyMaxMs: column(row.latencyMaxMs, nullableNumber),
    lossPercent: column(row.lossPercent, nullableNumber),
    measurements: column(row.measurements, (sample) => whole(sample)),
    failed: column(row.failed, (sample) => whole(sample)),
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
    parseTargetDetail(await transport.get(targetPath(id), { signal: options.signal }))

export const getTargetSeries =
  (transport: Transport): SentinelApi['getTargetSeries'] =>
  async ({ targetId, range, signal }: TargetSeriesOptions) =>
    parseTargetSeries(
      await transport.get(`targets/${encodeURIComponent(targetId)}/series/`, {
        signal,
        query: { range },
      }),
    )

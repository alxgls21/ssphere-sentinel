import type { SentinelApi } from '../client'
import type {
  DeviceAgent,
  DeviceConfig,
  DeviceDetail,
  DeviceInterface,
  DeviceList,
  DeviceListItem,
  DeviceListOptions,
  DevicePoll,
  DeviceReason,
  DeviceSeries,
  DeviceSeriesOptions,
  DeviceState,
  DeviceType,
  HealthStatus,
  InterfaceRates,
  InterfaceReason,
  InterfaceSeries,
  InterfaceSeriesOptions,
  InvalidReason,
  SnmpVersion,
} from '../types'
import { listQuery, parseCounts, parsePage } from './lists'
import {
  array,
  bad,
  flag,
  nullableNumber,
  nullableText,
  nullableTime,
  number,
  oneOf,
  parallel,
  record,
  text,
  time,
  whole,
} from './parse'
import type { Transport } from './transport'

/**
 * The console API's SNMP devices: the list (`devices/`), one device with its recent polls and
 * interfaces (`devices/<id>/`), a device's history (`devices/<id>/series/`) and an interface's
 * (`devices/<id>/interfaces/<ifIndex>/series/`). Every answer is validated and mapped onto the
 * view-models of api/types by naming each field: whatever else an answer carries is dropped, so a
 * credential could never reach a screen. One that does not fit is a `bad_response` error, never a
 * guess. The rates are the API's: nothing here works out a delta or a rate.
 */

const HEALTH: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']
const DEVICE_TYPE: readonly DeviceType[] = ['router', 'switch', 'firewall', 'other']
const VERSION: readonly SnmpVersion[] = ['2c', '3']
const AGENT_STATUS: readonly DeviceAgent['status'][] = ['online', 'offline', 'unknown']
const DEVICE_REASON: readonly DeviceReason[] = [
  'disabled',
  'no_agent',
  'agent_offline',
  'no_poll',
  'stale',
  'unreachable',
  'ok',
]
const INTERFACE_REASON: readonly InterfaceReason[] = [
  'device_unavailable',
  'absent',
  'admin_down',
  'up',
  'down',
  'other',
]
const INVALID_REASON: readonly InvalidReason[] = ['delta_state', 'interval', 'implausible', 'stale']

function parseAgent(raw: unknown): DeviceAgent | null {
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

function parseConfig(raw: unknown): DeviceConfig {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    type: oneOf(DEVICE_TYPE, row.type),
    address: text(row.address),
    enabled: flag(row.enabled),
    siteId: nullableText(row.siteId),
    snmpVersion: oneOf(VERSION, row.snmpVersion),
    port: whole(row.port, 1),
    pollIntervalSeconds: whole(row.pollIntervalSeconds, 1),
    timeoutSeconds: whole(row.timeoutSeconds, 1),
    retries: whole(row.retries),
    agentAssigned: flag(row.agentAssigned),
    agent: parseAgent(row.agent),
  }
}

function parseState(raw: unknown): DeviceState | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    reachable: flag(row.reachable),
    error: nullableText(row.error),
    responseMs: nullableNumber(row.responseMs),
    uptimeSeconds: row.uptimeSeconds === null ? null : whole(row.uptimeSeconds),
    sysName: nullableText(row.sysName),
    sysDescr: nullableText(row.sysDescr),
    sysObjectId: nullableText(row.sysObjectId),
    lastPollAt: time(row.lastPollAt),
    lastSuccessAt: nullableTime(row.lastSuccessAt),
    lastDiscoveryAt: nullableTime(row.lastDiscoveryAt),
    receivedAt: nullableTime(row.receivedAt),
  }
}

function parseItem(raw: unknown): DeviceListItem {
  const row = record(raw)
  const interfaces = record(row.interfaces)
  return {
    device: parseConfig(row.device),
    state: parseState(row.state),
    stale: flag(row.stale),
    health: oneOf(HEALTH, row.health),
    reason: oneOf(DEVICE_REASON, row.reason),
    interfaces: { total: whole(interfaces.total), counts: parseCounts(interfaces.counts) },
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
  }
}

export function parseDeviceList(raw: unknown): DeviceList {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseItem),
    page: parsePage(row.page),
    counts: parseCounts(row.counts),
    scopeTotal: whole(row.scopeTotal),
  }
}

function parsePoll(raw: unknown): DevicePoll {
  const row = record(raw)
  return {
    measuredAt: time(row.measuredAt),
    receivedAt: time(row.receivedAt),
    reachable: flag(row.reachable),
    responseMs: nullableNumber(row.responseMs),
    error: nullableText(row.error),
  }
}

function parseRates(raw: unknown): InterfaceRates | null {
  if (raw === null) return null
  const row = record(raw)
  const valid = flag(row.valid)
  const rates: InterfaceRates = {
    measuredAt: time(row.measuredAt),
    deltaState: text(row.deltaState),
    octetsBits: row.octetsBits === null ? null : whole(row.octetsBits),
    intervalSeconds: row.intervalSeconds === null ? null : number(row.intervalSeconds),
    valid,
    invalidReason: row.invalidReason === null ? null : oneOf(INVALID_REASON, row.invalidReason),
    inBps: nullableNumber(row.inBps),
    outBps: nullableNumber(row.outBps),
    inUtilizationPercent: nullableNumber(row.inUtilizationPercent),
    outUtilizationPercent: nullableNumber(row.outUtilizationPercent),
    inErrorsPerSec: nullableNumber(row.inErrorsPerSec),
    outErrorsPerSec: nullableNumber(row.outErrorsPerSec),
    inDiscardsPerSec: nullableNumber(row.inDiscardsPerSec),
    outDiscardsPerSec: nullableNumber(row.outDiscardsPerSec),
  }
  // The contract: an invalid sample says why and gives no rate. Anything else is not trusted.
  const hasRate = [
    rates.inBps,
    rates.outBps,
    rates.inUtilizationPercent,
    rates.outUtilizationPercent,
    rates.inErrorsPerSec,
    rates.outErrorsPerSec,
    rates.inDiscardsPerSec,
    rates.outDiscardsPerSec,
  ].some((value) => value !== null)
  if (valid === (rates.invalidReason !== null) || (!valid && hasRate)) throw bad()
  return rates
}

function parseInterface(raw: unknown): DeviceInterface {
  const row = record(raw)
  return {
    ifIndex: whole(row.ifIndex),
    name: text(row.name),
    descr: nullableText(row.descr),
    alias: nullableText(row.alias),
    type: whole(row.type),
    speedBps: row.speedBps === null ? null : whole(row.speedBps),
    adminStatus: text(row.adminStatus),
    operStatus: text(row.operStatus),
    operStatusChangedAt: nullableTime(row.operStatusChangedAt),
    health: oneOf(HEALTH, row.health),
    reason: oneOf(INTERFACE_REASON, row.reason),
    rates: parseRates(row.rates),
  }
}

export function parseDeviceDetail(raw: unknown): DeviceDetail {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseItem(row.item),
    polls: array(row.polls).map(parsePoll),
    interfaces: array(row.interfaces).map(parseInterface),
  }
}

export function parseDeviceSeries(raw: unknown): DeviceSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const column = parallel(t)
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    responseMs: column(row.responseMs, nullableNumber),
    reachablePolls: column(row.reachablePolls, (sample) => whole(sample)),
    failedPolls: column(row.failedPolls, (sample) => whole(sample)),
  }
}

export function parseInterfaceSeries(raw: unknown): InterfaceSeries {
  const row = record(raw)
  const t = array(row.t).map(number)
  const column = parallel(t)
  return {
    generatedAt: time(row.generatedAt),
    bucketMs: number(row.bucketMs),
    t,
    inBps: column(row.inBps, nullableNumber),
    outBps: column(row.outBps, nullableNumber),
    inBpsMax: column(row.inBpsMax, nullableNumber),
    outBpsMax: column(row.outBpsMax, nullableNumber),
    inErrorsPerSec: column(row.inErrorsPerSec, nullableNumber),
    outErrorsPerSec: column(row.outErrorsPerSec, nullableNumber),
    inDiscardsPerSec: column(row.inDiscardsPerSec, nullableNumber),
    outDiscardsPerSec: column(row.outDiscardsPerSec, nullableNumber),
    validSamples: column(row.validSamples, (sample) => whole(sample)),
    invalidSamples: column(row.invalidSamples, (sample) => whole(sample)),
  }
}

export const listDevices =
  (transport: Transport): SentinelApi['listDevices'] =>
  async (options: DeviceListOptions = {}) =>
    parseDeviceList(
      await transport.get('devices/', { signal: options.signal, query: listQuery(options) }),
    )

export const getDevice =
  (transport: Transport): SentinelApi['getDevice'] =>
  async (id, options = {}) =>
    parseDeviceDetail(
      await transport.get(`devices/${encodeURIComponent(id)}/`, { signal: options.signal }),
    )

export const getDeviceSeries =
  (transport: Transport): SentinelApi['getDeviceSeries'] =>
  async ({ deviceId, range, signal }: DeviceSeriesOptions) =>
    parseDeviceSeries(
      await transport.get(`devices/${encodeURIComponent(deviceId)}/series/`, {
        signal,
        query: { range },
      }),
    )

export const getInterfaceSeries =
  (transport: Transport): SentinelApi['getInterfaceSeries'] =>
  async ({ deviceId, ifIndex, range, signal }: InterfaceSeriesOptions) =>
    parseInterfaceSeries(
      await transport.get(
        `devices/${encodeURIComponent(deviceId)}/interfaces/${encodeURIComponent(String(ifIndex))}/series/`,
        { signal, query: { range } },
      ),
    )

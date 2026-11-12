import type { SentinelApi } from '../client'
import type {
  DeviceType,
  InventoryDevice,
  InventoryDeviceDetail,
  InventoryDeviceInput,
  InventoryDeviceListOptions,
  InventoryDevicePatch,
  SnmpInput,
  SnmpSettings,
  SnmpVersion,
} from '../types'
import { flag, oneOf, parseMonitoringAgent, record, text, time, whole, nullableText } from './parse'
import { body, notAll, pageText, parseDeleted, parseRecordList, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's inventory of devices (`inventory/devices/`, `inventory/devices/<id>/`): every
 * device, with or without an SNMP configuration, and the writes on them. The SNMP settings an
 * answer carries never include the credential profile, and the parser would not read one; the
 * profile goes out in a write only when the operator typed one, and is never kept here.
 */

const TYPE: readonly DeviceType[] = ['router', 'switch', 'firewall', 'other']
const VERSION: readonly SnmpVersion[] = ['2c', '3']

function parseSnmp(raw: unknown): SnmpSettings | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    version: oneOf(VERSION, row.version),
    port: whole(row.port, 1),
    pollIntervalSeconds: whole(row.pollIntervalSeconds, 1),
    timeoutSeconds: whole(row.timeoutSeconds, 1),
    retries: whole(row.retries),
  }
}

export function parseInventoryDevice(raw: unknown): InventoryDevice {
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    type: oneOf(TYPE, row.type),
    address: text(row.address),
    enabled: flag(row.enabled),
    description: text(row.description),
    siteId: nullableText(row.siteId),
    ...(row.customerName === undefined ? {} : { customerName: text(row.customerName) }),
    ...(row.siteName === undefined ? {} : { siteName: text(row.siteName) }),
    agentAssigned: flag(row.agentAssigned),
    agent: parseMonitoringAgent(row.agent),
    snmp: parseSnmp(row.snmp),
    hasHistory: flag(row.hasHistory),
    createdAt: time(row.createdAt),
    updatedAt: time(row.updatedAt),
  }
}

export function parseInventoryDeviceDetail(raw: unknown): InventoryDeviceDetail {
  const row = record(raw)
  return { generatedAt: time(row.generatedAt), item: parseInventoryDevice(row.item) }
}

function listQuery(options: InventoryDeviceListOptions): Record<string, string | undefined> {
  return {
    customer: options.scope?.customerId ?? undefined,
    site: options.scope?.siteId ?? undefined,
    q: searchText(options.q),
    snmp: notAll(options.snmp),
    sort: options.sort,
    dir: options.dir,
    page: pageText(options.page),
    pageSize: pageText(options.pageSize),
  }
}

/** A device id is a path segment: it is encoded, never trusted. */
const devicePath = (id: string) => `inventory/devices/${encodeURIComponent(id)}/`

/** The SNMP block, field by field: the profile only when given, so a blank field never clears it. */
function snmpBody(input: SnmpInput | null | undefined): Record<string, unknown> | null | undefined {
  if (input === null || input === undefined) return input
  return body({
    version: input.version,
    port: input.port,
    credentialProfile: input.credentialProfile,
    pollIntervalSeconds: input.pollIntervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    retries: input.retries,
  })
}

function deviceBody(input: InventoryDevicePatch): Record<string, unknown> {
  return body({
    name: input.name,
    address: input.address,
    type: input.type,
    enabled: input.enabled,
    description: input.description,
    siteId: input.siteId,
    agentId: input.agentId,
    snmp: snmpBody(input.snmp),
  })
}

export const listInventoryDevices =
  (transport: Transport): SentinelApi['listInventoryDevices'] =>
  async (options = {}) =>
    parseRecordList(
      await transport.get('inventory/devices/', {
        signal: options.signal,
        query: listQuery(options),
      }),
      parseInventoryDevice,
    )

export const getInventoryDevice =
  (transport: Transport): SentinelApi['getInventoryDevice'] =>
  async (id, options) =>
    parseInventoryDeviceDetail(await transport.get(devicePath(id), { signal: options?.signal }))

export const createInventoryDevice =
  (transport: Transport): SentinelApi['createInventoryDevice'] =>
  async (input: InventoryDeviceInput, options) =>
    parseInventoryDeviceDetail(
      await transport.post('inventory/devices/', deviceBody(input), { signal: options?.signal }),
    )

export const updateInventoryDevice =
  (transport: Transport): SentinelApi['updateInventoryDevice'] =>
  async (id, patch, options) =>
    parseInventoryDeviceDetail(
      await transport.patch(devicePath(id), deviceBody(patch), { signal: options?.signal }),
    )

export const deleteInventoryDevice =
  (transport: Transport): SentinelApi['deleteInventoryDevice'] =>
  async (id, options) =>
    parseDeleted(await transport.delete(devicePath(id), { signal: options?.signal }))

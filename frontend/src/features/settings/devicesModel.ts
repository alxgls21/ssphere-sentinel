import type {
  DeviceType,
  InventoryDevice,
  InventoryDeviceInput,
  InventoryDeviceListOptions,
  InventoryDevicePatch,
  InventorySnmpFilter,
  InventorySortKey,
  SnmpInput,
  SnmpVersion,
  SortDirection,
} from '@/api/types'
import type { FieldErrors } from '@/hooks/useSaveForm'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE, tooLong, wholeField } from './adminModel'

/**
 * What the devices list of Settings asks for, and the form of a device with its SNMP
 * configuration: what is typed, what is wrong with it, and what is sent. The credential profile
 * is typed and sent, never read back: a blank field keeps the one the device has.
 */

export interface DevicesQuery {
  q: string
  snmp: InventorySnmpFilter
  sort: InventorySortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_DEVICES_QUERY: DevicesQuery = {
  q: '',
  snmp: 'all',
  sort: 'name',
  dir: 'asc',
  page: 1,
}

export const SNMP_FILTERS: readonly InventorySnmpFilter[] = ['all', 'configured', 'none']
export const SNMP_FILTER_LABEL: Record<InventorySnmpFilter, string> = {
  all: 'ALL',
  configured: 'SNMP',
  none: 'NOT POLLED',
}
export const DEVICE_SORT_KEYS: readonly InventorySortKey[] = ['name', 'type', 'address', 'created']
export const DEVICE_SORT_LABEL: Record<InventorySortKey, string> = {
  name: 'Name',
  type: 'Type',
  address: 'Address',
  created: 'Created',
}
export const DEVICE_FIRST_DIR: Record<InventorySortKey, SortDirection> = {
  name: 'asc',
  type: 'asc',
  address: 'asc',
  created: 'desc',
}

export function parseDevicesQuery(params: URLSearchParams): DevicesQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const snmp = params.get('snmp')
  const key = isOneOf(DEVICE_SORT_KEYS, sort) ? sort : DEFAULT_DEVICES_QUERY.sort
  return {
    q: params.get('q') ?? '',
    snmp: isOneOf(SNMP_FILTERS, snmp) ? snmp : DEFAULT_DEVICES_QUERY.snmp,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : DEVICE_FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

export function writeDevicesQuery(params: URLSearchParams, query: DevicesQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'snmp', query.snmp, query.snmp === DEFAULT_DEVICES_QUERY.snmp)
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_DEVICES_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === DEVICE_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === DEFAULT_DEVICES_QUERY.page)
  return next
}

export const nextDevicesSort = (
  query: DevicesQuery,
  key: InventorySortKey,
): Pick<DevicesQuery, 'sort' | 'dir'> => nextListSort(query, key, DEVICE_FIRST_DIR)

export const devicesRequest = (query: DevicesQuery, q: string): InventoryDeviceListOptions => ({
  q,
  snmp: query.snmp,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

export const DEVICE_TYPES: readonly DeviceType[] = ['router', 'switch', 'firewall', 'other']
export const TYPE_LABEL: Record<DeviceType, string> = {
  router: 'Router',
  switch: 'Switch',
  firewall: 'Firewall',
  other: 'Other',
}
export const VERSIONS: readonly SnmpVersion[] = ['2c', '3']
export const VERSION_LABEL: Record<SnmpVersion, string> = { '2c': 'SNMPv2c', '3': 'SNMPv3' }

/** The bounds the server applies (its models'), so a value out of them is said here. */
export const DEVICE_LIMITS = {
  name: 255,
  address: 255,
  description: 2000,
  profile: 64,
  port: [1, 65535],
  interval: [30, 86400],
  timeout: [1, 60],
  retries: [0, 5],
} as const

export interface DeviceDraft {
  name: string
  type: DeviceType
  address: string
  enabled: boolean
  description: string
  /** The id of the site, or '' for none. */
  siteId: string
  /** The id of the agent, or '' for none. */
  agentId: string
  /** Polled by SNMP: the fields below apply. */
  snmp: boolean
  version: SnmpVersion
  port: string
  /** Typed to set it; blank keeps the profile the device has (there is none to show). */
  credentialProfile: string
  pollIntervalSeconds: string
  timeoutSeconds: string
  retries: string
}

/** The fields the form draws an error under, by the names the server gives them (`snmp.<field>` for the SNMP block). */
export type DeviceField =
  | 'name'
  | 'type'
  | 'address'
  | 'enabled'
  | 'description'
  | 'siteId'
  | 'agentId'
  | 'snmp'
  | 'snmp.version'
  | 'snmp.port'
  | 'snmp.credentialProfile'
  | 'snmp.pollIntervalSeconds'
  | 'snmp.timeoutSeconds'
  | 'snmp.retries'
  | 'snmp.nonField'
export const DEVICE_FIELDS: readonly DeviceField[] = [
  'name',
  'type',
  'address',
  'enabled',
  'description',
  'siteId',
  'agentId',
  'snmp',
  'snmp.version',
  'snmp.port',
  'snmp.credentialProfile',
  'snmp.pollIntervalSeconds',
  'snmp.timeoutSeconds',
  'snmp.retries',
  'snmp.nonField',
]

/** The server's defaults, as its models set them. */
export const NEW_DEVICE: DeviceDraft = {
  name: '',
  type: 'other',
  address: '',
  enabled: true,
  description: '',
  siteId: '',
  agentId: '',
  snmp: false,
  version: '3',
  port: '161',
  credentialProfile: '',
  pollIntervalSeconds: '300',
  timeoutSeconds: '5',
  retries: '1',
}

export const deviceDraft = (device: InventoryDevice): DeviceDraft => ({
  name: device.name,
  type: device.type,
  address: device.address,
  enabled: device.enabled,
  description: device.description,
  siteId: device.siteId ?? '',
  agentId: device.agent?.id ?? '',
  snmp: device.snmp !== null,
  version: device.snmp?.version ?? NEW_DEVICE.version,
  port: String(device.snmp?.port ?? NEW_DEVICE.port),
  credentialProfile: '',
  pollIntervalSeconds: String(device.snmp?.pollIntervalSeconds ?? NEW_DEVICE.pollIntervalSeconds),
  timeoutSeconds: String(device.snmp?.timeoutSeconds ?? NEW_DEVICE.timeoutSeconds),
  retries: String(device.snmp?.retries ?? NEW_DEVICE.retries),
})

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** `hadSnmp`: the device already has a configuration, so a blank profile keeps it. */
export function validateDevice(draft: DeviceDraft, hadSnmp: boolean): FieldErrors<DeviceField> {
  const errors: FieldErrors<DeviceField> = {}
  if (draft.name.trim() === '') errors.name = ['Required.']
  else if (draft.name.trim().length > DEVICE_LIMITS.name)
    errors.name = [tooLong(DEVICE_LIMITS.name)]
  if (draft.address.trim() === '') errors.address = ['Required.']
  else if (/\s/.test(draft.address.trim()) || draft.address.trim().length > DEVICE_LIMITS.address)
    errors.address = ['Expected a host name or an IP address.']
  if (draft.description.length > DEVICE_LIMITS.description)
    errors.description = [tooLong(DEVICE_LIMITS.description)]
  if (draft.snmp) {
    const port = wholeField(draft.port, DEVICE_LIMITS.port[0], DEVICE_LIMITS.port[1])
    if (port.error) errors['snmp.port'] = [port.error]
    const profile = draft.credentialProfile.trim()
    if (profile === '') {
      if (!hadSnmp)
        errors['snmp.credentialProfile'] = [
          'Required: the name of a profile in the agent’s credentials file.',
        ]
    } else if (profile.length > DEVICE_LIMITS.profile) {
      errors['snmp.credentialProfile'] = [tooLong(DEVICE_LIMITS.profile)]
    } else if (!PROFILE.test(profile)) {
      errors['snmp.credentialProfile'] = ["Use letters, digits, '.', '_' and '-'."]
    }
    const interval = wholeField(
      draft.pollIntervalSeconds,
      DEVICE_LIMITS.interval[0],
      DEVICE_LIMITS.interval[1],
    )
    if (interval.error) errors['snmp.pollIntervalSeconds'] = [interval.error]
    const timeout = wholeField(
      draft.timeoutSeconds,
      DEVICE_LIMITS.timeout[0],
      DEVICE_LIMITS.timeout[1],
    )
    if (timeout.error) errors['snmp.timeoutSeconds'] = [timeout.error]
    const retries = wholeField(draft.retries, DEVICE_LIMITS.retries[0], DEVICE_LIMITS.retries[1])
    if (retries.error) errors['snmp.retries'] = [retries.error]
    if (
      interval.value !== undefined &&
      timeout.value !== undefined &&
      retries.value !== undefined
    ) {
      if (timeout.value * (retries.value + 1) >= interval.value)
        errors['snmp.nonField'] = [
          'timeout × (retries + 1) must be shorter than the poll interval.',
        ]
    }
  }
  return errors
}

/** The SNMP block as typed; the profile only when typed. Call it on a draft that validated. */
function snmpInput(draft: DeviceDraft): SnmpInput {
  const profile = draft.credentialProfile.trim()
  return {
    version: draft.version,
    port: Number(draft.port.trim()),
    ...(profile === '' ? {} : { credentialProfile: profile }),
    pollIntervalSeconds: Number(draft.pollIntervalSeconds.trim()),
    timeoutSeconds: Number(draft.timeoutSeconds.trim()),
    retries: Number(draft.retries.trim()),
  }
}

export function deviceInput(draft: DeviceDraft): InventoryDeviceInput {
  return {
    name: draft.name.trim(),
    address: draft.address.trim(),
    type: draft.type,
    enabled: draft.enabled,
    description: draft.description,
    siteId: draft.siteId === '' ? null : draft.siteId,
    agentId: draft.agentId === '' ? null : draft.agentId,
    snmp: draft.snmp ? snmpInput(draft) : null,
  }
}

/** Only what changed against the device as read; null when nothing did. A profile typed is always a change. */
export function devicePatch(
  draft: DeviceDraft,
  device: InventoryDevice,
): InventoryDevicePatch | null {
  const input = deviceInput(draft)
  const patch: InventoryDevicePatch = {}
  if (input.name !== device.name) patch.name = input.name
  if (input.address !== device.address) patch.address = input.address
  if (input.type !== device.type) patch.type = input.type
  if (input.enabled !== device.enabled) patch.enabled = input.enabled
  if (input.description !== device.description) patch.description = input.description
  if (input.siteId !== device.siteId) patch.siteId = input.siteId
  if (input.agentId !== (device.agent?.id ?? null)) patch.agentId = input.agentId
  const wanted = input.snmp ?? null
  if (wanted === null) {
    if (device.snmp !== null) patch.snmp = null
  } else {
    const was = device.snmp
    const snmp: SnmpInput = {}
    if (was === null || wanted.version !== was.version) snmp.version = wanted.version
    if (was === null || wanted.port !== was.port) snmp.port = wanted.port
    if (wanted.credentialProfile !== undefined) snmp.credentialProfile = wanted.credentialProfile
    if (was === null || wanted.pollIntervalSeconds !== was.pollIntervalSeconds)
      snmp.pollIntervalSeconds = wanted.pollIntervalSeconds
    if (was === null || wanted.timeoutSeconds !== was.timeoutSeconds)
      snmp.timeoutSeconds = wanted.timeoutSeconds
    if (was === null || wanted.retries !== was.retries) snmp.retries = wanted.retries
    if (Object.keys(snmp).length > 0) patch.snmp = snmp
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/** "SNMPv3 · port 161" or "Not polled". */
export const snmpText = (device: InventoryDevice): string =>
  device.snmp ? `${VERSION_LABEL[device.snmp.version]} · port ${device.snmp.port}` : 'Not polled'

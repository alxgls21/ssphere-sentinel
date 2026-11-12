import type {
  SortDirection,
  TargetAgentEntry,
  TargetConfig,
  TargetInput,
  TargetListOptions,
  TargetPatch,
  TargetProtocol,
} from '@/api/types'
import type { FieldErrors } from '@/hooks/useSaveForm'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE, tooLong, wholeField } from './adminModel'

/**
 * What the targets list of Settings asks for, and the form of a target: what is typed, what is
 * wrong with it, and what is sent. The server checks everything again (the address, the port
 * against the protocol, the site and the agent): the checks here only save a round trip.
 */

export type TargetsSortKey = 'name' | 'status'

export interface TargetsQuery {
  q: string
  sort: TargetsSortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_TARGETS_QUERY: TargetsQuery = { q: '', sort: 'name', dir: 'asc', page: 1 }
export const TARGETS_SORT_KEYS: readonly TargetsSortKey[] = ['name', 'status']
export const TARGETS_SORT_LABEL: Record<TargetsSortKey, string> = { name: 'Name', status: 'State' }
export const TARGETS_FIRST_DIR: Record<TargetsSortKey, SortDirection> = {
  name: 'asc',
  status: 'desc',
}

export function parseTargetsQuery(params: URLSearchParams): TargetsQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const key = isOneOf(TARGETS_SORT_KEYS, sort) ? sort : DEFAULT_TARGETS_QUERY.sort
  return {
    q: params.get('q') ?? '',
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : TARGETS_FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

export function writeTargetsQuery(params: URLSearchParams, query: TargetsQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_TARGETS_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === TARGETS_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === DEFAULT_TARGETS_QUERY.page)
  return next
}

export const nextTargetsSort = (
  query: TargetsQuery,
  key: TargetsSortKey,
): Pick<TargetsQuery, 'sort' | 'dir'> => nextListSort(query, key, TARGETS_FIRST_DIR)

/** The list is the Network list's, unscoped: every target the account may see, by name or state. */
export const targetsRequest = (query: TargetsQuery, q: string): TargetListOptions => ({
  q,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

export const PROTOCOLS: readonly TargetProtocol[] = ['icmp', 'tcp']
export const PROTOCOL_CHOICES: { value: TargetProtocol; label: string }[] = [
  { value: 'icmp', label: 'ICMP (ping)' },
  { value: 'tcp', label: 'TCP (connect to a port)' },
]

/** The bounds the server applies (its model's), so a value out of them is said here. */
export const TARGET_LIMITS = {
  name: 255,
  address: 255,
  text: 255,
  port: [1, 65535],
  interval: [10, 86400],
  timeout: [1, 30],
} as const

export interface TargetDraft {
  name: string
  address: string
  protocol: TargetProtocol
  /** The TCP port as typed; ignored for ICMP. */
  port: string
  enabled: boolean
  intervalSeconds: string
  timeoutSeconds: string
  expectedSlaPercent: string
  customerLabel: string
  circuitId: string
  /** The id of the site, or '' for none. */
  siteId: string
  /** The id of the agent, or '' for none. */
  agentId: string
}

export type TargetField = keyof TargetDraft
export const TARGET_FIELDS: readonly TargetField[] = [
  'name',
  'address',
  'protocol',
  'port',
  'enabled',
  'intervalSeconds',
  'timeoutSeconds',
  'expectedSlaPercent',
  'customerLabel',
  'circuitId',
  'siteId',
  'agentId',
]

/** The server's defaults, as its model sets them. */
export const NEW_TARGET: TargetDraft = {
  name: '',
  address: '',
  protocol: 'icmp',
  port: '',
  enabled: true,
  intervalSeconds: '60',
  timeoutSeconds: '2',
  expectedSlaPercent: '99.9',
  customerLabel: '',
  circuitId: '',
  siteId: '',
  agentId: '',
}

export const targetDraft = (config: TargetConfig): TargetDraft => ({
  name: config.name,
  address: config.address,
  protocol: config.protocol,
  port: config.port === null ? '' : String(config.port),
  enabled: config.enabled,
  intervalSeconds: String(config.intervalSeconds),
  timeoutSeconds: String(config.timeoutSeconds),
  expectedSlaPercent: String(config.expectedSlaPercent),
  customerLabel: config.customerLabel ?? '',
  circuitId: config.circuitId ?? '',
  siteId: config.siteId ?? '',
  agentId: config.agent?.id ?? '',
})

/** A share from 0 to 100 with at most two decimals, as the server stores it. */
function slaPercent(text: string): { value: number; error?: undefined } | { error: string } {
  const trimmed = text.trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed) || Number(trimmed) > 100) {
    return { error: 'Expected a number from 0 to 100, with at most two decimals.' }
  }
  return { value: Number(trimmed) }
}

export function validateTarget(draft: TargetDraft): FieldErrors<TargetField> {
  const errors: FieldErrors<TargetField> = {}
  if (draft.name.trim() === '') errors.name = ['Required.']
  else if (draft.name.trim().length > TARGET_LIMITS.name)
    errors.name = [tooLong(TARGET_LIMITS.name)]
  if (draft.address.trim() === '') errors.address = ['Required.']
  else if (/\s/.test(draft.address.trim()) || draft.address.trim().length > TARGET_LIMITS.address)
    errors.address = ['Expected a host name or an IP address.']
  if (draft.protocol === 'tcp') {
    const port = wholeField(draft.port, TARGET_LIMITS.port[0], TARGET_LIMITS.port[1])
    if (port.error)
      errors.port = [draft.port.trim() === '' ? 'A TCP target needs a port.' : port.error]
  }
  const interval = wholeField(
    draft.intervalSeconds,
    TARGET_LIMITS.interval[0],
    TARGET_LIMITS.interval[1],
  )
  if (interval.error) errors.intervalSeconds = [interval.error]
  const timeout = wholeField(
    draft.timeoutSeconds,
    TARGET_LIMITS.timeout[0],
    TARGET_LIMITS.timeout[1],
  )
  if (timeout.error) errors.timeoutSeconds = [timeout.error]
  const sla = slaPercent(draft.expectedSlaPercent)
  if (sla.error) errors.expectedSlaPercent = [sla.error]
  if (draft.customerLabel.trim().length > TARGET_LIMITS.text)
    errors.customerLabel = [tooLong(TARGET_LIMITS.text)]
  if (draft.circuitId.trim().length > TARGET_LIMITS.text)
    errors.circuitId = [tooLong(TARGET_LIMITS.text)]
  return errors
}

/** Everything a target is created with; call it on a draft that validated. */
export function targetInput(draft: TargetDraft): TargetInput {
  return {
    name: draft.name.trim(),
    address: draft.address.trim(),
    protocol: draft.protocol,
    port: draft.protocol === 'tcp' ? Number(draft.port.trim()) : null,
    enabled: draft.enabled,
    intervalSeconds: Number(draft.intervalSeconds.trim()),
    timeoutSeconds: Number(draft.timeoutSeconds.trim()),
    expectedSlaPercent: Number(draft.expectedSlaPercent.trim()),
    customerLabel: draft.customerLabel.trim(),
    circuitId: draft.circuitId.trim(),
    siteId: draft.siteId === '' ? null : draft.siteId,
    agentId: draft.agentId === '' ? null : draft.agentId,
  }
}

/** Only what changed against the target as read; null when nothing did. */
export function targetPatch(draft: TargetDraft, config: TargetConfig): TargetPatch | null {
  const input = targetInput(draft)
  const patch: TargetPatch = {}
  if (input.name !== config.name) patch.name = input.name
  if (input.address !== config.address) patch.address = input.address
  if (input.protocol !== config.protocol || input.port !== config.port) {
    patch.protocol = input.protocol
    patch.port = input.port
  }
  if (input.enabled !== config.enabled) patch.enabled = input.enabled
  if (input.intervalSeconds !== config.intervalSeconds)
    patch.intervalSeconds = input.intervalSeconds
  if (input.timeoutSeconds !== config.timeoutSeconds) patch.timeoutSeconds = input.timeoutSeconds
  if (input.expectedSlaPercent !== config.expectedSlaPercent)
    patch.expectedSlaPercent = input.expectedSlaPercent
  if (input.customerLabel !== (config.customerLabel ?? ''))
    patch.customerLabel = input.customerLabel
  if (input.circuitId !== (config.circuitId ?? '')) patch.circuitId = input.circuitId
  if (input.siteId !== config.siteId) patch.siteId = input.siteId
  if (input.agentId !== (config.agent?.id ?? null)) patch.agentId = input.agentId
  return Object.keys(patch).length > 0 ? patch : null
}

/** The entry as it goes into the agent's file: one object of the `targets` list, indented as the example file is. */
export const agentEntryText = (entry: TargetAgentEntry): string => JSON.stringify(entry, null, 2)

/** "ICMP" or "TCP 443": the protocol and the port of a target, for a list. */
export const endpointWord = (config: Pick<TargetConfig, 'protocol' | 'port'>): string =>
  config.protocol === 'tcp' ? `TCP ${config.port ?? ''}`.trim() : 'ICMP'

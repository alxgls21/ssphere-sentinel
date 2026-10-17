import type {
  DeviceInterface,
  DeviceListItem,
  DeviceReason,
  DeviceType,
  InterfaceRates,
  InterfaceReason,
  SnmpVersion,
} from '@/api/types'
import { EMPTY, formatAge, formatBitsPerSecond, formatLatency, formatPercent } from './format'

/**
 * What an SNMP device and its interfaces say in words. The health and its reason are the console
 * API's: this only names them, and never works out a status, a delta or a rate. An interface that
 * is down never makes its device unhealthy (the API decides the device from its polls alone), so
 * the two are worded apart.
 */

export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  router: 'Router',
  switch: 'Switch',
  firewall: 'Firewall',
  other: 'Other',
}

export const SNMP_VERSION_LABEL: Record<SnmpVersion, string> = { '2c': 'SNMPv2c', '3': 'SNMPv3' }

/** The tag word of a device's reason. The health still decides the colour and the shape. */
export function deviceReasonWord(reason: DeviceReason): string {
  switch (reason) {
    case 'disabled':
      return 'DISABLED'
    case 'no_agent':
      return 'NO AGENT'
    case 'agent_offline':
      return 'AGENT OFFLINE'
    case 'no_poll':
      return 'NOT POLLED'
    case 'stale':
      return 'STALE'
    case 'unreachable':
      return 'UNREACHABLE'
    case 'ok':
      return 'REACHABLE'
  }
}

const POLL_ERROR: Record<string, string> = {
  timeout: 'timeout',
  unreachable: 'unreachable',
  auth_failure: 'authentication failure',
  dns_failure: 'DNS failure',
  protocol_error: 'protocol error',
  unsupported: 'unsupported (no IF-MIB)',
  unknown: 'unknown error',
}

/** The agent's poll error word, in words; an error this build does not know is shown as it came. */
export const pollErrorText = (error: string | null): string | null =>
  error === null ? null : (POLL_ERROR[error] ?? error)

/** The latest poll is the present state of the device: the API judged health from it. */
export const isCurrentDevice = (item: DeviceListItem): boolean =>
  item.state !== null && !item.stale && (item.reason === 'ok' || item.reason === 'unreachable')

/**
 * The reason, as a sentence an operator can read as it is. `nowMs` is the clock of the data. A
 * stale or unpolled device never reads as having a current state.
 */
export function deviceReasonSentence(item: DeviceListItem, nowMs: number): string {
  const { device, state } = item
  switch (item.reason) {
    case 'disabled':
      return 'Monitoring is switched off for this device, so nothing is being polled.'
    case 'no_agent':
      return 'No agent is assigned to poll this device.'
    case 'agent_offline':
      return device.agent?.status === 'unknown'
        ? 'Its agent has never reported, so nothing is being polled.'
        : 'Its agent is disabled or has stopped reporting, so nothing is being polled.'
    case 'no_poll':
      return 'It has not been polled yet.'
    case 'stale':
      return `The latest poll is ${state ? formatAge(state.lastPollAt, nowMs) : EMPTY} old: too old to describe the present, so it is the last poll, not the current state.`
    case 'unreachable': {
      const why = pollErrorText(state?.error ?? null)
      return `The latest poll could not reach the device${why ? `: ${why}` : ''}.`
    }
    case 'ok':
      return 'The latest poll reached the device.'
  }
}

/**
 * One line for a queue row: what the device is and the API's reason in a few words. A stale or
 * unreachable device never gives its last response as a present one; the age is the last poll's.
 */
export function deviceDetail(item: DeviceListItem, nowMs: number): string {
  const { device, state } = item
  const what = `${DEVICE_TYPE_LABEL[device.type]} ${device.address}`
  switch (item.reason) {
    case 'disabled':
      return `${what} · monitoring switched off`
    case 'no_agent':
      return `${what} · no agent assigned`
    case 'agent_offline':
      return `${what} · agent not reporting`
    case 'no_poll':
      return `${what} · never polled`
    case 'stale':
      return `${what} · last polled ${state ? formatAge(state.lastPollAt, nowMs) : EMPTY} ago, not current`
    case 'unreachable': {
      const why = pollErrorText(state?.error ?? null)
      return `${what} · no response${why ? `: ${why}` : ''}`
    }
    case 'ok':
      return `${what} · reached`
  }
}

/** One short line for a card or a notice: how long ago the device was last polled. */
export const polledAgo = (item: DeviceListItem, nowMs: number): string =>
  item.state === null ? 'never' : `${formatAge(item.state.lastPollAt, nowMs)} ago`

/** "SNMPv2c port 161". */
export const snmpText = (item: DeviceListItem): string =>
  `${SNMP_VERSION_LABEL[item.device.snmpVersion]} port ${item.device.port}`

/** "every 60 s, timeout 5 s, 2 retries". */
export const pollScheduleText = (item: DeviceListItem): string =>
  `every ${item.device.pollIntervalSeconds} s, timeout ${item.device.timeoutSeconds} s, ${item.device.retries} ${item.device.retries === 1 ? 'retry' : 'retries'}`

/** The response time of the latest poll, only as the present value where that poll is current and reached the device. */
export const responseText = (item: DeviceListItem): string =>
  isCurrentDevice(item) && item.reason === 'ok' ? formatLatency(item.state?.responseMs) : EMPTY

/**
 * The interfaces counted by their own health: "48 · 2 down · 1 unknown". The counts are the API's,
 * over the present interfaces, and a device that is not healthy has them all unknown.
 */
export function interfaceCountsText(item: DeviceListItem): string {
  const { total, counts } = item.interfaces
  const parts = [`${total}`]
  if (counts.warning > 0) parts.push(`${counts.warning} down`)
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`)
  return parts.join(' · ')
}

/** The spoken form of the same, naming every state including the healthy ones and the admin-down ones. */
export function interfaceCountsSpoken(item: DeviceListItem): string {
  const { total, counts } = item.interfaces
  if (total === 0) return 'no interfaces'
  return [
    `${total} interfaces`,
    `${counts.healthy} up`,
    `${counts.idle} admin down`,
    `${counts.warning} down`,
    `${counts.unknown} unknown`,
  ].join(', ')
}

/* ------------------------------------------------------------- interfaces */

/** The tag word of an interface's reason: up, down, switched off, and the cases with no verdict. */
export function interfaceReasonWord(reason: InterfaceReason): string {
  switch (reason) {
    case 'up':
      return 'UP'
    case 'down':
      return 'DOWN'
    case 'admin_down':
      return 'ADMIN DOWN'
    case 'device_unavailable':
      return 'DEVICE N/A'
    case 'absent':
      return 'ABSENT'
    case 'other':
      return 'UNKNOWN'
  }
}

export function interfaceReasonSentence(iface: DeviceInterface): string {
  switch (iface.reason) {
    case 'up':
      return 'Administratively and operationally up.'
    case 'down':
      return `Administratively up but operationally ${iface.operStatus}.`
    case 'admin_down':
      return 'Switched off on purpose (administratively down).'
    case 'device_unavailable':
      return 'Its device is not reachable or not current, so this status is the last one stored, not the present one.'
    case 'absent':
      return 'It is not in the device’s latest complete interface listing.'
    case 'other':
      return `Admin status ${iface.adminStatus}, operational status ${iface.operStatus}: neither a clear up nor a clear down.`
  }
}

/** "up / down": the IF-MIB words, exactly as the device reported them. */
export const interfaceStateText = (iface: DeviceInterface): string =>
  `admin ${iface.adminStatus} · oper ${iface.operStatus}`

/** The name, with the alias (what the operator wrote on the port) beside it. */
export const interfaceTitle = (iface: DeviceInterface): string =>
  iface.alias ? `${iface.name} (${iface.alias})` : iface.name

/* ------------------------------------------------------------------ rates */

const DELTA_STATE: Record<string, string> = {
  first: 'This is the first sample, so there is nothing to compare it with.',
  reboot: 'The device restarted since the previous sample, so its counters cannot be compared.',
  reset: 'A counter was reset, so the change since the previous sample is not known.',
  gap: 'The previous sample was too old to compare with.',
}

/** Why a sample gives no rate. A sample that gives rates has no such sentence. */
export function invalidSentence(rates: InterfaceRates): string | null {
  switch (rates.invalidReason) {
    case null:
      return null
    case 'delta_state':
      return `No rate: ${DELTA_STATE[rates.deltaState] ?? 'its counters could not be compared with the previous sample.'}`
    case 'interval':
      return 'No rate: the sample has no valid time interval.'
    case 'implausible':
      return 'No rate: it was above 1.5 times the interface speed, so it is not believed.'
    case 'stale':
      return 'No rate: the sample is older than the device’s stale limit, so it is not the present rate.'
  }
}

export type RateKind = 'bps' | 'percent' | 'perSecond'

/** A rate cell: the value, or a dash and why there is none. Never 0 for a value that is not known. */
export interface RateCell {
  text: string
  note?: string
}

const perSecond = (value: number): string => `${value.toFixed(value < 10 ? 2 : 1)}/s`

export function rateText(
  iface: DeviceInterface,
  pick: (rates: InterfaceRates) => number | null,
  kind: RateKind,
): RateCell {
  const { rates } = iface
  if (rates === null) return { text: EMPTY, note: 'This interface has not been sampled yet.' }
  if (!rates.valid) return { text: EMPTY, note: invalidSentence(rates) ?? undefined }
  const value = pick(rates)
  if (value === null) {
    return kind === 'percent' && iface.speedBps === null
      ? {
          text: EMPTY,
          note: 'The interface speed is not known, so utilization cannot be given; the bits per second stand.',
        }
      : { text: EMPTY, note: 'The device does not report this counter.' }
  }
  return {
    text:
      kind === 'bps'
        ? formatBitsPerSecond(value)
        : kind === 'percent'
          ? formatPercent(value, 1)
          : perSecond(value),
  }
}

/** The interface speed, or why there is none to quote. */
export const speedText = (iface: DeviceInterface): string =>
  iface.speedBps === null ? EMPTY : formatBitsPerSecond(iface.speedBps, 0)

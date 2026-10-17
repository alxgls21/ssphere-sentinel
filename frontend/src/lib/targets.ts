import type {
  TargetAvailability,
  TargetListItem,
  TargetMeasurement,
  TargetProtocol,
  TargetReason,
} from '@/api/types'
import { EMPTY, formatAge, formatLatency, formatPercent } from './format'
import { LATENCY_WARN_MS, LOSS_WARN_PERCENT } from './thresholds'

/**
 * What a network target says in words. The health and its reason are the console API's: this
 * only names them, and never works out a status from a measurement. The metric words follow the
 * protocol, because the one number means two things: for an ICMP target `lossPercent` is the
 * share of probe packets that got no answer, for a TCP target the share of connection attempts
 * that failed. A TCP failure is never called packet loss.
 */

export const PROTOCOL_LABEL: Record<TargetProtocol, string> = { icmp: 'ICMP', tcp: 'TCP' }

/** The limits the reasons quote: the console API's, from the session, or the console's own defaults. */
export interface TargetLimits {
  latencyWarnMs: number
  lossWarnPercent: number
  /** How many measurements in a row must fail for critical; null when the API did not say. */
  critFailures: number | null
  origin: 'server' | 'default'
}

export const DEFAULT_TARGET_LIMITS: TargetLimits = {
  latencyWarnMs: LATENCY_WARN_MS,
  lossWarnPercent: LOSS_WARN_PERCENT,
  critFailures: null,
  origin: 'default',
}

/** What `lossPercent` is, in full: the label of a chart, a table column, a spoken value. */
export const LOSS_LABEL: Record<TargetProtocol, string> = {
  icmp: 'Packet loss',
  tcp: 'Failed connection attempts',
}

/** The same in the few characters a cell has: `2% lost`, `2% failed`. */
export function lossText(protocol: TargetProtocol, percent: number | null): string {
  if (percent === null) return EMPTY
  return `${formatPercent(percent, percent < 10 ? 1 : 0)} ${protocol === 'icmp' ? 'lost' : 'failed'}`
}

/** One sentence of the value, for a screen reader: "packet loss 2.0 percent". */
export function lossSpoken(protocol: TargetProtocol, percent: number | null): string {
  return percent === null
    ? `${LOSS_LABEL[protocol].toLowerCase()} not measured`
    : `${LOSS_LABEL[protocol].toLowerCase()} ${percent.toFixed(1)} percent`
}

/** What the measurements of one round are made of, per protocol: "probe packets" or "connection attempts". */
export const PROBE_NOUN: Record<TargetProtocol, string> = {
  icmp: 'probe packets',
  tcp: 'connection attempts',
}

/** The tag word of a health reason. The health still decides the colour and the shape. */
export function reasonWord(reason: TargetReason, protocol: TargetProtocol): string {
  switch (reason) {
    case 'disabled':
      return 'DISABLED'
    case 'no_agent':
      return 'NO AGENT'
    case 'agent_offline':
      return 'AGENT OFFLINE'
    case 'no_measurement':
      return 'NO DATA'
    case 'stale':
      return 'STALE'
    case 'failing':
      return 'FAILING'
    case 'failed':
      return 'FAILED'
    case 'latency':
      return 'SLOW'
    case 'loss':
      return protocol === 'icmp' ? 'LOSS' : 'FAILURES'
    case 'ok':
      return 'OK'
  }
}

/** Reasons that rest on a current measurement: only these show it as the present reading. */
const JUDGED: readonly TargetReason[] = ['failing', 'failed', 'latency', 'loss', 'ok']

/** The measurement is the present reading of the target (the API judged health from it). */
export const isCurrent = (item: TargetListItem): boolean =>
  item.latest !== null && !item.stale && JUDGED.includes(item.reason)

/**
 * The reason, as a sentence an operator can read as it is: what the API decided and why. `nowMs`
 * is the clock of the data. A stale or unobserved target never reads as having a current value.
 */
export function reasonSentence(
  item: TargetListItem,
  nowMs: number,
  limits: TargetLimits = DEFAULT_TARGET_LIMITS,
): string {
  const { target, latest } = item
  switch (item.reason) {
    case 'disabled':
      return 'Monitoring is switched off for this target, so nothing is being measured.'
    case 'no_agent':
      return 'No agent is assigned to measure this target.'
    case 'agent_offline':
      return target.agent?.status === 'unknown'
        ? 'Its agent has never reported, so nothing is being measured.'
        : 'Its agent is disabled or has stopped reporting, so nothing is being measured.'
    case 'no_measurement':
      return 'Nothing has been measured yet.'
    case 'stale':
      return `The newest measurement is ${latest ? formatAge(latest.measuredAt, nowMs) : EMPTY} old: too old to describe the present, so it is the last measurement, not a current reading.`
    case 'failing':
      return limits.critFailures === null
        ? 'The latest measurements all failed.'
        : `The latest ${limits.critFailures} measurements all failed.`
    case 'failed':
      return 'The latest measurement failed.'
    case 'latency':
      return `Latency ${formatLatency(latest?.latencyMs)} is at or above the ${limits.latencyWarnMs} ms warning limit.`
    case 'loss':
      return target.protocol === 'icmp'
        ? `Packet loss ${formatPercent(latest?.lossPercent, 1)} is at or above the ${limits.lossWarnPercent}% warning limit.`
        : `${formatPercent(latest?.lossPercent, 1)} of connection attempts failed, at or above the ${limits.lossWarnPercent}% warning limit.`
    case 'ok':
      return 'It answered within the limits.'
  }
}

/** "ICMP", or "TCP 443". */
export const protocolText = (item: TargetListItem): string =>
  item.target.port === null
    ? PROTOCOL_LABEL[item.target.protocol]
    : `${PROTOCOL_LABEL[item.target.protocol]} ${item.target.port}`

/** What is probed: "10.0.0.1" for ICMP, "10.0.0.1:443" for TCP. */
export const endpointText = (item: TargetListItem): string =>
  item.target.port === null ? item.target.address : `${item.target.address}:${item.target.port}`

/** "every 60 s, timeout 5 s". */
export const scheduleText = (item: TargetListItem): string =>
  `every ${item.target.intervalSeconds} s, timeout ${item.target.timeoutSeconds} s`

/** How long ago the newest measurement was taken, or "never". */
export const measuredAgo = (latest: TargetMeasurement | null, nowMs: number): string =>
  latest === null ? 'never' : `${formatAge(latest.measuredAt, nowMs)} ago`

/** How many of the probes of a round were answered: "3 of 4 probe packets answered". */
export function probesText(measurement: TargetMeasurement, protocol: TargetProtocol): string {
  return `${measurement.successfulProbes} of ${measurement.probeCount} ${PROBE_NOUN[protocol]} answered`
}

/** The observed success rate: "99.5% of 1,420 measurements succeeded". Never an SLA or an uptime. */
export function observedText(availability: TargetAvailability): string {
  if (availability.percent === null || availability.measurements === 0) {
    return 'No measurements in the last 24 hours'
  }
  return `${formatPercent(availability.percent, availability.percent === 100 ? 0 : 1)} of ${availability.measurements.toLocaleString('en-US')} measurements succeeded`
}

/** How much of the window was measured at all. */
export function coverageText(availability: TargetAvailability): string {
  if (availability.coveragePercent === null) return EMPTY
  return `${formatPercent(availability.coveragePercent, 0)} of the window measured (${availability.measurements.toLocaleString('en-US')} of ${availability.expectedMeasurements.toLocaleString('en-US')} expected)`
}

/**
 * One short line for a queue row, from the API's reason and the newest measurement only: no limit
 * is quoted, because the list a row comes from does not carry them. A stale or unobserved target
 * says so, and never gives its last number as if it were present.
 */
export function reasonDetail(item: TargetListItem, nowMs: number): string {
  const { target, latest } = item
  const what = `${protocolText(item)} ${endpointText(item)}`
  switch (item.reason) {
    case 'disabled':
      return `${what} · monitoring switched off`
    case 'no_agent':
      return `${what} · no agent assigned`
    case 'agent_offline':
      return `${what} · agent not reporting`
    case 'no_measurement':
      return `${what} · never measured`
    case 'stale':
      return `${what} · last measured ${latest ? formatAge(latest.measuredAt, nowMs) : EMPTY} ago, not current`
    case 'failing':
      return `${what} · latest measurements all failed${latest?.failureReason ? `: ${latest.failureReason}` : ''}`
    case 'failed':
      return `${what} · latest measurement failed${latest?.failureReason ? `: ${latest.failureReason}` : ''}`
    case 'latency':
      return `${what} · latency ${formatLatency(latest?.latencyMs)}`
    case 'loss':
      return target.protocol === 'icmp'
        ? `${what} · packet loss ${formatPercent(latest?.lossPercent, 1)}`
        : `${what} · ${formatPercent(latest?.lossPercent, 1)} of connection attempts failed`
    case 'ok':
      return `${what} · answered within the limits`
  }
}

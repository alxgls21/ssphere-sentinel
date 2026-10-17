import type {
  DeviceDetail,
  DeviceInterface,
  DeviceList,
  DeviceListItem,
  DevicePoll,
  DeviceReason,
  DeviceSeries,
  InterfaceRates,
  InterfaceReason,
  InterfaceSeries,
  InvalidReason,
} from '@/api/types'
import { countStatuses, emptyCounts } from '@/lib/status'

/** Fixtures for the SNMP tests, in the shapes the console API serves. Imported by tests only. */

export const NOW = Date.parse('2026-10-17T10:00:00Z')
export const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

const HEALTH_OF: Record<DeviceReason, DeviceListItem['health']> = {
  disabled: 'idle',
  no_agent: 'unknown',
  agent_offline: 'unknown',
  no_poll: 'unknown',
  stale: 'unknown',
  unreachable: 'critical',
  ok: 'healthy',
}

interface ItemOptions {
  id?: string
  name?: string
  type?: 'router' | 'switch' | 'firewall' | 'other'
  reason?: DeviceReason
  agent?: 'online' | 'offline' | 'unknown' | 'hidden' | 'none'
  siteName?: string | null
  error?: string | null
  responseMs?: number | null
  /** The interfaces by health; healthy by default. */
  interfaces?: Partial<DeviceListItem['interfaces']['counts']>
  polledSecondsAgo?: number
}

/** One list item. The health follows the reason, as the console API decides it. */
export function item({
  id = 'dev-1',
  name = 'ath-core-sw',
  type = 'switch',
  reason = 'ok',
  agent = 'online',
  siteName = 'Athens DC',
  error = reason === 'unreachable' ? 'timeout' : null,
  responseMs = reason === 'ok' ? 12.4 : null,
  interfaces = { healthy: 20, idle: 3, warning: 1 },
  polledSecondsAgo = reason === 'stale' ? 7200 : 20,
}: ItemOptions = {}): DeviceListItem {
  const counts = { ...emptyCounts(), ...interfaces }
  const polled = reason !== 'no_poll' && reason !== 'disabled'
  return {
    device: {
      id,
      name,
      type,
      address: '10.20.0.250',
      enabled: reason !== 'disabled',
      siteId: siteName === null ? null : 'site-ath',
      snmpVersion: '2c',
      port: 161,
      pollIntervalSeconds: 60,
      timeoutSeconds: 5,
      retries: 2,
      agentAssigned: agent !== 'none',
      agent:
        agent === 'none' || agent === 'hidden'
          ? null
          : {
              id: 'agent-1',
              name: 'ath-probe',
              status: agent,
              lastSeenAt: agent === 'unknown' ? null : iso(30),
              serverId: 'srv-ath-probe',
              serverName: 'ath-probe-01',
            },
    },
    state: polled
      ? {
          reachable: reason !== 'unreachable',
          error,
          responseMs,
          uptimeSeconds: 86_400 * 3,
          sysName: 'ath-core-sw.example.net',
          sysDescr: 'Example OS 12.4 on a 48-port switch',
          sysObjectId: '1.3.6.1.4.1.9.1.1',
          lastPollAt: iso(polledSecondsAgo),
          lastSuccessAt: reason === 'unreachable' ? iso(600) : iso(polledSecondsAgo),
          lastDiscoveryAt: iso(3600),
          receivedAt: iso(polledSecondsAgo - 1),
        }
      : null,
    stale: reason === 'stale',
    health: HEALTH_OF[reason],
    reason,
    interfaces: { total: Object.values(counts).reduce((sum, n) => sum + n, 0), counts },
    ...(siteName === null ? {} : { customerName: 'Meridian', siteName }),
  }
}

export function list(items: DeviceListItem[], over: Partial<DeviceList> = {}): DeviceList {
  return {
    generatedAt: new Date(NOW).toISOString(),
    items,
    page: { number: 1, size: 50, total: items.length, pages: 1 },
    counts: { ...emptyCounts(), ...countStatuses(items.map((entry) => entry.health)) },
    scopeTotal: items.length,
    ...over,
  }
}

export const rates = (over: Partial<InterfaceRates> = {}): InterfaceRates => ({
  measuredAt: iso(20),
  deltaState: 'ok',
  octetsBits: 64,
  intervalSeconds: 60,
  valid: true,
  invalidReason: null,
  inBps: 420_000_000,
  outBps: 85_000_000,
  inUtilizationPercent: 42,
  outUtilizationPercent: 8.5,
  inErrorsPerSec: 0,
  outErrorsPerSec: 0.05,
  inDiscardsPerSec: 0,
  outDiscardsPerSec: 1.5,
  ...over,
})

/** A sample that gave no rate, and why. */
export const noRates = (
  invalidReason: InvalidReason,
  deltaState = invalidReason === 'delta_state' ? 'first' : 'ok',
): InterfaceRates =>
  rates({
    valid: false,
    invalidReason,
    deltaState,
    inBps: null,
    outBps: null,
    inUtilizationPercent: null,
    outUtilizationPercent: null,
    inErrorsPerSec: null,
    outErrorsPerSec: null,
    inDiscardsPerSec: null,
    outDiscardsPerSec: null,
  })

const HEALTH_OF_INTERFACE: Record<InterfaceReason, DeviceInterface['health']> = {
  up: 'healthy',
  down: 'warning',
  admin_down: 'idle',
  device_unavailable: 'unknown',
  absent: 'unknown',
  other: 'unknown',
}

export function iface(
  ifIndex: number,
  reason: InterfaceReason = 'up',
  over: Partial<DeviceInterface> = {},
): DeviceInterface {
  const admin = reason === 'admin_down' ? 'down' : 'up'
  const oper =
    reason === 'up' ? 'up' : reason === 'down' ? 'down' : reason === 'other' ? 'dormant' : 'down'
  return {
    ifIndex,
    name: `Gi1/0/${ifIndex}`,
    descr: `GigabitEthernet1/0/${ifIndex}`,
    alias: null,
    type: 6,
    speedBps: 1_000_000_000,
    adminStatus: admin,
    operStatus: oper,
    operStatusChangedAt: iso(86_400),
    health: HEALTH_OF_INTERFACE[reason],
    reason,
    rates: rates(),
    ...over,
  }
}

export const poll = (secondsAgo: number, over: Partial<DevicePoll> = {}): DevicePoll => ({
  measuredAt: iso(secondsAgo),
  receivedAt: iso(secondsAgo - 1),
  reachable: true,
  responseMs: 11,
  error: null,
  ...over,
})

export function detail(
  entry: DeviceListItem,
  interfaces: DeviceInterface[] = [iface(1), iface(2, 'down'), iface(3, 'admin_down')],
  over: Partial<DeviceDetail> = {},
): DeviceDetail {
  return {
    generatedAt: new Date(NOW).toISOString(),
    item: entry,
    polls: entry.state ? [poll(20)] : [],
    interfaces,
    ...over,
  }
}

const T = Array.from({ length: 6 }, (_, i) => NOW - (6 - i) * 60_000)

/** Six one-minute buckets: reachable, slow, nothing polled, all failed, and two reachable. */
export function deviceSeries(over: Partial<DeviceSeries> = {}): DeviceSeries {
  return {
    generatedAt: new Date(NOW).toISOString(),
    bucketMs: 60_000,
    t: T,
    responseMs: [10, 180, null, null, 12, 11],
    reachablePolls: [1, 1, 0, 0, 1, 1],
    failedPolls: [0, 0, 0, 1, 0, 0],
    ...over,
  }
}

/** Six one-minute buckets: usable, usable, nothing sampled, only unusable samples, and two usable. */
export function interfaceSeries(over: Partial<InterfaceSeries> = {}): InterfaceSeries {
  return {
    generatedAt: new Date(NOW).toISOString(),
    bucketMs: 60_000,
    t: T,
    inBps: [400e6, 800e6, null, null, 410e6, 420e6],
    outBps: [80e6, 90e6, null, null, 85e6, 85e6],
    inBpsMax: [500e6, 900e6, null, null, 450e6, 440e6],
    outBpsMax: [100e6, 120e6, null, null, 90e6, 88e6],
    inErrorsPerSec: [0, 0.2, null, null, 0, 0],
    outErrorsPerSec: [0, 0, null, null, 0, 0],
    inDiscardsPerSec: [0, 0, null, null, 1.5, 0],
    outDiscardsPerSec: [0, 0, null, null, 0, 0],
    validSamples: [1, 1, 0, 0, 1, 1],
    invalidSamples: [0, 0, 0, 2, 0, 0],
    ...over,
  }
}

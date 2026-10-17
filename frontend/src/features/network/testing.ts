import type {
  TargetDetail,
  TargetList,
  TargetListItem,
  TargetMeasurement,
  TargetReason,
  TargetSeries,
} from '@/api/types'
import { emptyCounts, countStatuses } from '@/lib/status'

/** Fixtures for the Network tests, in the shapes the console API serves. Imported by tests only. */

export const NOW = Date.parse('2026-10-17T10:00:00Z')
export const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

export const measurement = (over: Partial<TargetMeasurement> = {}): TargetMeasurement => ({
  measuredAt: iso(20),
  receivedAt: iso(19),
  success: true,
  latencyMs: 12.4,
  lossPercent: 0,
  probeCount: 4,
  successfulProbes: 4,
  failureReason: null,
  ...over,
})

const HEALTH_OF: Record<TargetReason, TargetListItem['health']> = {
  disabled: 'idle',
  no_agent: 'unknown',
  agent_offline: 'unknown',
  no_measurement: 'unknown',
  stale: 'unknown',
  failing: 'critical',
  failed: 'warning',
  latency: 'warning',
  loss: 'warning',
  ok: 'healthy',
}

interface ItemOptions {
  id?: string
  name?: string
  protocol?: 'icmp' | 'tcp'
  reason?: TargetReason
  latest?: TargetMeasurement | null
  agent?: 'online' | 'offline' | 'unknown' | 'hidden' | 'none'
  enabled?: boolean
  siteName?: string | null
}

/** One list item. The health follows the reason, as the console API decides it. */
export function item({
  id = 'tgt-1',
  name = 'ath-gateway',
  protocol = 'icmp',
  reason = 'ok',
  latest,
  agent = 'online',
  enabled = reason !== 'disabled',
  siteName = 'Athens DC',
}: ItemOptions = {}): TargetListItem {
  const measured =
    latest === undefined ? (reason === 'no_measurement' ? null : measurement()) : latest
  return {
    target: {
      id,
      name,
      address: protocol === 'tcp' ? 'api.example.net' : '10.20.0.1',
      protocol,
      port: protocol === 'tcp' ? 443 : null,
      enabled,
      intervalSeconds: 60,
      timeoutSeconds: 5,
      circuitId: 'CIR-0042',
      siteId: siteName === null ? null : 'site-ath',
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
    latest: measured,
    stale: reason === 'stale',
    health: HEALTH_OF[reason],
    reason,
    ...(siteName === null ? {} : { customerName: 'Meridian', siteName }),
  }
}

export function list(items: TargetListItem[], over: Partial<TargetList> = {}): TargetList {
  return {
    generatedAt: new Date(NOW).toISOString(),
    items,
    page: { number: 1, size: 50, total: items.length, pages: 1 },
    counts: { ...emptyCounts(), ...countStatuses(items.map((entry) => entry.health)) },
    scopeTotal: items.length,
    ...over,
  }
}

export function detail(entry: TargetListItem, over: Partial<TargetDetail> = {}): TargetDetail {
  return {
    generatedAt: new Date(NOW).toISOString(),
    item: entry,
    measurements: entry.latest ? [entry.latest] : [],
    availability24h: {
      from: iso(86_400),
      to: iso(0),
      measurements: 1400,
      successful: 1393,
      percent: 99.5,
      expectedMeasurements: 1440,
      coveragePercent: 97.2,
    },
    ...over,
  }
}

/** Six one-minute buckets: a quiet one, a slow one, a gap with no measurement, a failing one, and two more. */
export function series(over: Partial<TargetSeries> = {}): TargetSeries {
  const t = Array.from({ length: 6 }, (_, i) => NOW - (6 - i) * 60_000)
  return {
    generatedAt: new Date(NOW).toISOString(),
    bucketMs: 60_000,
    t,
    latencyMs: [10, 180, null, null, 12, 11],
    latencyMaxMs: [14, 260, null, null, 18, 13],
    lossPercent: [0, 3.5, null, null, 0, 0],
    measurements: [1, 1, 0, 1, 1, 1],
    failed: [0, 0, 0, 1, 0, 0],
    ...over,
  }
}

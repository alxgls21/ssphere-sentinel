import { describe, expect, it } from 'vitest'
import type { OverviewSummary, StatusCounts } from '@/api/types'
import { computeVerdict, sumCounts } from './verdict'

const counts = (over: Partial<StatusCounts> = {}): StatusCounts => ({
  healthy: 0,
  warning: 0,
  critical: 0,
  unknown: 0,
  idle: 0,
  ...over,
})

function summary(
  servers: Partial<StatusCounts>,
  containers: Partial<StatusCounts> = {},
): OverviewSummary {
  return {
    generatedAt: '2026-10-12T14:05:12Z',
    servers: { total: 0, counts: counts(servers) },
    containers: { total: 0, counts: counts(containers) },
  }
}

describe('computeVerdict', () => {
  it('is CRITICAL when anything is critical, counting across servers and containers', () => {
    const v = computeVerdict(
      summary({ healthy: 10, critical: 1 }, { healthy: 50, warning: 2, critical: 1, idle: 3 }),
      'live',
    )
    expect(v.state).toBe('critical')
    expect(v.word).toBe('CRITICAL')
    expect(v.status).toBe('critical')
    expect(v.needAttention).toBe(2 + 2) // 2 critical + 2 warning
    expect(v.counts.critical).toBe(2)
    expect(v.counts.warning).toBe(2)
  })

  it('excludes idle from the denominator', () => {
    const v = computeVerdict(summary({ healthy: 10 }, { healthy: 5, idle: 3 }), 'live')
    expect(v.monitored).toBe(15)
    expect(v.idle).toBe(3)
    expect(v.state).toBe('nominal')
    expect(v.needAttention).toBe(0)
  })

  it('is DEGRADED for warnings only, PARTIAL for unknowns only, NOMINAL otherwise', () => {
    expect(computeVerdict(summary({ healthy: 5, warning: 1 }), 'live').state).toBe('degraded')
    expect(computeVerdict(summary({ healthy: 5, unknown: 1 }), 'live').state).toBe('partial')
    expect(computeVerdict(summary({ healthy: 5 }), 'live').state).toBe('nominal')
  })

  it('never reads NOMINAL when unknowns exist (a dead dashboard must not look healthy)', () => {
    expect(computeVerdict(summary({ healthy: 100, unknown: 1 }), 'live').word).toBe('PARTIAL')
  })

  it('is NO DATA without a summary, with nothing monitored, or when the data is too old', () => {
    expect(computeVerdict(undefined, 'live').state).toBe('nodata')
    expect(computeVerdict(summary({}), 'live').state).toBe('nodata')
    const v = computeVerdict(summary({ healthy: 5 }), 'nodata')
    expect(v.state).toBe('nodata')
    expect(v.needAttention).toBeNull()
    expect(v.word).toBe('NO DATA')
  })

  it('keeps showing the verdict while merely stale or paused', () => {
    expect(computeVerdict(summary({ healthy: 5, critical: 1 }), 'stale').state).toBe('critical')
    expect(computeVerdict(summary({ healthy: 5 }), 'paused').state).toBe('nominal')
  })
})

describe('an offline server does not change what decides', () => {
  const withOffline = summary(
    { healthy: 13, warning: 2, critical: 1, offline: 1 },
    { healthy: 62, warning: 1, critical: 2, idle: 3 },
  )
  const without = summary(
    { healthy: 13, warning: 2, critical: 1 },
    { healthy: 62, warning: 1, critical: 2, idle: 3 },
  )

  it('is still CRITICAL with the same figures', () => {
    const flagged = computeVerdict(withOffline, 'live')
    const plain = computeVerdict(without, 'live')
    expect(flagged.state).toBe('critical')
    expect(flagged.word).toBe('CRITICAL')
    expect(flagged.status).toBe('critical')
    expect(flagged.needAttention).toBe(plain.needAttention)
    expect(flagged.needAttention).toBe(6)
    expect(flagged.monitored).toBe(plain.monitored)
    expect(flagged.monitored).toBe(81)
    expect(flagged.idle).toBe(plain.idle)
    expect(flagged.counts).toMatchObject({ critical: 3, warning: 3, healthy: 75, idle: 3 })
  })

  it('is CRITICAL even when the offline server is the only critical entity', () => {
    const only = computeVerdict(summary({ healthy: 5, critical: 1, offline: 1 }), 'live')
    expect(only.state).toBe('critical')
    expect(only.needAttention).toBe(1)
  })

  it('carries the offline members to the breakdown, inside the critical count', () => {
    expect(computeVerdict(withOffline, 'live').counts.offline).toBe(1)
    expect(computeVerdict(without, 'live').counts.offline).toBeUndefined()
  })

  it('adds offline members across domains, and notes none when there are none', () => {
    expect(
      sumCounts(
        counts({ critical: 2, offline: 1 }),
        counts({ critical: 1 }),
        counts({ critical: 1, offline: 1 }),
      ),
    ).toMatchObject({ critical: 4, offline: 2 })
    expect('offline' in sumCounts(counts({ critical: 1 }), counts({ warning: 1 }))).toBe(false)
  })
})

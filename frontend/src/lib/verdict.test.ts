import { describe, expect, it } from 'vitest'
import type { OverviewSummary, StatusCounts } from '@/api/types'
import { computeVerdict } from './verdict'

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
  targets: Partial<StatusCounts> = {},
): OverviewSummary {
  return {
    generatedAt: '2026-10-12T14:05:12Z',
    servers: { total: 0, online: 0, counts: counts(servers) },
    containers: { total: 0, running: 0, counts: counts(containers) },
    targets: { total: 0, up: 0, counts: counts(targets), successTrend: [] },
    devices: { inInventory: 0, byType: { router: 0, switch: 0, firewall: 0, other: 0 } },
  }
}

describe('computeVerdict', () => {
  it('is CRITICAL when anything is critical, counting across domains', () => {
    const v = computeVerdict(
      summary(
        { healthy: 10, critical: 1 },
        { healthy: 50, warning: 2, critical: 1, idle: 3 },
        { healthy: 30, warning: 1 },
      ),
      'live',
    )
    expect(v.state).toBe('critical')
    expect(v.word).toBe('CRITICAL')
    expect(v.status).toBe('critical')
    expect(v.needAttention).toBe(2 + 3) // 2 critical + 3 warning
    expect(v.counts.critical).toBe(2)
    expect(v.counts.warning).toBe(3)
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

import type { NetworkSeries } from '@/api/types'

/** 13:38 to 13:42 UTC at 1-minute buckets, with a gap (13:40) where every probe failed. */
export const T0 = Date.parse('2026-10-12T13:38:00Z')

export function makeSeries(overrides: Partial<NetworkSeries> = {}): NetworkSeries {
  const t = [0, 1, 2, 3, 4].map((minute) => T0 + minute * 60_000)
  return {
    generatedAt: '2026-10-12T13:43:00Z',
    bucketMs: 60_000,
    t,
    p95: [100, 212, null, 150, 142],
    p50: [60, 90, null, 80, 70],
    lossMean: [0, 0.5, null, 2.5, 2.1],
    failedProbes: [0, 0, 2, 0, 0],
    probeCount: [40, 40, 38, 40, 40],
    targetCount: 40,
    ...overrides,
  }
}

/** A series where nothing was measured: no probes ran in any bucket. */
export function makeEmptySeries(): NetworkSeries {
  return makeSeries({
    t: [],
    p95: [],
    p50: [],
    lossMean: [],
    failedProbes: [],
    probeCount: [],
  })
}

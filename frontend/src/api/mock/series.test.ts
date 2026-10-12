import { describe, expect, it } from 'vitest'
import type { RangeKey } from '@/api/types'
import { buildEstate } from './fixtures'
import {
  BUCKET_MS,
  RANGE_MS,
  buildNetworkSeries,
  percentile,
  probeAt,
  successTrend,
  type ProbeModel,
} from './series'
import { round1 } from './random'
import { MINUTE } from './time'

const ANCHOR = Date.UTC(2026, 9, 12, 14, 5, 12)
const models = buildEstate('story', { now: ANCHOR, anchor: ANCHOR }).probes
const RANGES: RangeKey[] = ['15m', '1h', '6h', '24h']

const mean = (values: (number | null)[]) => {
  const present = values.filter((value): value is number => value !== null)
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

describe('the bucket grid', () => {
  it.each(RANGES)('is aligned, complete and ends at the latest bucket boundary (%s)', (range) => {
    const series = buildNetworkSeries(models, range, ANCHOR)
    const bucket = BUCKET_MS[range]
    expect(series.bucketMs).toBe(bucket)
    expect(series.t).toHaveLength(RANGE_MS[range] / bucket)
    for (const t of series.t) expect(t % bucket).toBe(0)
    series.t.forEach((t, i) => i > 0 && expect(t - (series.t[i - 1] as number)).toBe(bucket))
    // Only completed buckets: the newest one ended at or before now, within one bucket of it.
    const end = (series.t.at(-1) as number) + bucket
    expect(end).toBeLessThanOrEqual(ANCHOR)
    expect(ANCHOR - end).toBeLessThan(bucket)
    expect(series.t[0]).toBeGreaterThanOrEqual(ANCHOR - RANGE_MS[range] - bucket)
    for (const column of [
      series.p50,
      series.p95,
      series.lossMean,
      series.failedProbes,
      series.probeCount,
    ]) {
      expect(column).toHaveLength(series.t.length)
    }
    expect(series.targetCount).toBe(models.length)
  })

  it('uses the spec buckets: 1 min up to 1h, 5 min at 6h, 15 min at 24h', () => {
    expect(BUCKET_MS).toEqual({ '15m': MINUTE, '1h': MINUTE, '6h': 5 * MINUTE, '24h': 15 * MINUTE })
  })

  it.each(RANGES)(
    'shifts by exactly one bucket when the clock advances one bucket (%s)',
    (range) => {
      const bucket = BUCKET_MS[range]
      const before = buildNetworkSeries(models, range, ANCHOR)
      const after = buildNetworkSeries(models, range, ANCHOR + bucket)
      expect(after.t).toEqual(before.t.slice(1).concat((before.t.at(-1) as number) + bucket))
      for (const key of ['p50', 'p95', 'lossMean', 'failedProbes', 'probeCount'] as const) {
        expect(after[key].slice(0, -1), key).toEqual(before[key].slice(1))
      }
    },
  )

  it('is the same series until the next bucket completes', () => {
    const a = buildNetworkSeries(models, '1h', ANCHOR)
    const b = buildNetworkSeries(models, '1h', ANCHOR + 20_000)
    expect({ ...b, generatedAt: '' }).toEqual({ ...a, generatedAt: '' })
  })

  it('is deterministic', () => {
    expect(buildNetworkSeries(models, '6h', ANCHOR)).toEqual(
      buildNetworkSeries(models, '6h', ANCHOR),
    )
  })

  it('counts probes in line with the targets and their cadence', () => {
    const series = buildNetworkSeries(models, '15m', ANCHOR)
    for (const count of series.probeCount) {
      expect(count).toBeGreaterThanOrEqual(models.length - 1)
      expect(count).toBeLessThanOrEqual(models.length + 4)
    }
  })
})

describe('the story in the series', () => {
  const hour = buildNetworkSeries(models, '1h', ANCHOR)
  const early = (column: (number | null)[]) => column.slice(0, 20)
  const late = (column: (number | null)[]) => column.slice(-15)

  it('lifts p95 and loss when the Frankfurt link degrades, and crosses the warn line', () => {
    expect(mean(late(hour.p95))).toBeGreaterThan(mean(early(hour.p95)) * 1.5)
    expect(Math.max(...early(hour.p95).map((v) => v ?? 0))).toBeLessThan(150)
    expect(mean(late(hour.p95))).toBeGreaterThan(150)
    expect(mean(late(hour.lossMean))).toBeGreaterThan(mean(early(hour.lossMean)))
  })

  it('keeps the median low: most targets are fast', () => {
    for (const value of hour.p50) expect(value as number).toBeLessThan(30)
  })

  it('raises failed probes when the Piraeus targets go dark, and not before', () => {
    const outageStart = hour.t.findIndex((t) => t >= ANCHOR - 12 * MINUTE)
    expect(mean(hour.failedProbes.slice(outageStart))).toBeGreaterThanOrEqual(2)
    expect(mean(hour.failedProbes.slice(0, 30))).toBeLessThan(0.5)
  })

  it('shows older, resolved incidents on the longer ranges', () => {
    const day = buildNetworkSeries(models, '24h', ANCHOR)
    const around = day.failedProbes.filter(
      (_, i) =>
        (day.t[i] as number) >= ANCHOR - 815 * MINUTE &&
        (day.t[i] as number) <= ANCHOR - 785 * MINUTE,
    )
    expect(around.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(9)
  })

  it('keeps every percentile consistent', () => {
    for (const range of RANGES) {
      const series = buildNetworkSeries(models, range, ANCHOR)
      series.p95.forEach((p95, i) => {
        const p50 = series.p50[i] as number
        expect(p95 as number).toBeGreaterThanOrEqual(p50)
        expect(p50).toBeGreaterThan(0)
      })
      for (const loss of series.lossMean) expect(loss as number).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('gaps and empties', () => {
  const dead: ProbeModel = {
    targetId: 'tgt-dead',
    name: 'dead',
    protocol: 'icmp',
    intervalMs: MINUTE,
    phaseMs: 0,
    latencyMs: 5,
    jitter: 0.1,
    lossPercent: 0,
    flakyRate: 0,
    silent: false,
    episodes: [{ from: 0, to: null, failure: 'host_unreachable' }],
  }

  it('uses null, not zero, when nothing succeeded in a bucket', () => {
    const series = buildNetworkSeries([dead], '15m', ANCHOR)
    expect(series.p50.every((v) => v === null)).toBe(true)
    expect(series.p95.every((v) => v === null)).toBe(true)
    expect(series.lossMean.every((v) => v === null)).toBe(true)
    expect(series.failedProbes).toEqual(series.probeCount)
    expect(series.probeCount.every((count) => count === 1)).toBe(true)
  })

  it('returns empty columns when nothing is monitored', () => {
    const series = buildNetworkSeries([], '1h', ANCHOR)
    expect(series.t).toEqual([])
    expect(series.p95).toEqual([])
    expect(series.targetCount).toBe(0)
  })

  it('ignores targets that report nothing but still counts them', () => {
    const silent: ProbeModel = { ...dead, silent: true }
    const series = buildNetworkSeries([silent], '15m', ANCHOR)
    expect(series.probeCount.every((count) => count === 0)).toBe(true)
    expect(series.targetCount).toBe(1)
  })
})

describe('probes', () => {
  const sample = models.find((m) => m.name === 'fra-isp-a') as ProbeModel

  it('are a pure function of target and absolute time', () => {
    expect(probeAt(sample, 12_345)).toEqual(probeAt(sample, 12_345))
    expect(probeAt(sample, 12_345)).not.toEqual(probeAt(sample, 12_346))
  })

  it('lose packets in steps of one ping while a link is degraded', () => {
    const degraded = Math.floor((ANCHOR - sample.phaseMs) / sample.intervalMs)
    const losses = Array.from({ length: 50 }, (_, i) => probeAt(sample, degraded - i).lossPercent)
    for (const loss of losses) expect(loss % 10).toBe(0)
    expect(mean(losses)).toBeGreaterThan(3)
    expect(mean(losses)).toBeLessThan(9)
  })
})

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48)
    expect(percentile([7], 0.95)).toBe(7)
    expect(percentile([], 0.5)).toBeNull()
  })
})

describe('successTrend', () => {
  it('has 12 points that dip when the outage starts', () => {
    const trend = successTrend(models, ANCHOR)
    expect(trend).toHaveLength(12)
    for (const rate of trend) {
      expect(rate).toBeLessThanOrEqual(100)
      expect(rate).toBeGreaterThan(80)
    }
    expect(mean(trend.slice(-3))).toBeLessThan(mean(trend.slice(0, 6)))
  })

  it('is the success rate of the very probes the 5-minute series buckets count', () => {
    const trend = successTrend(models, ANCHOR)
    const series = buildNetworkSeries(models, '6h', ANCHOR)
    const first = series.t.length - trend.length
    trend.forEach((rate, i) => {
      const probes = series.probeCount[first + i] as number
      const failed = series.failedProbes[first + i] as number
      expect(rate).toBe(round1(((probes - failed) / probes) * 100))
    })
  })

  it('is empty when nothing is probed', () => {
    expect(successTrend([], ANCHOR)).toEqual([])
    const silent = models.map((model) => ({ ...model, silent: true }))
    expect(successTrend(silent, ANCHOR)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  lossOverIndexes,
  spikeIndexes,
  worstSpikeIndex,
} from '@/features/overview/latency/latencyModel'
import { SAMPLE_SERIES } from './data'
import { SAMPLE_SPIKE_SERIES } from './latency'

describe('sample spike series', () => {
  it('keeps the shape of the sample series: parallel arrays, one missed minute', () => {
    const { t, p95, p50, lossMean, failedProbes, probeCount } = SAMPLE_SPIKE_SERIES
    for (const column of [p95, p50, lossMean, failedProbes, probeCount]) {
      expect(column).toHaveLength(t.length)
    }
    expect(p95.indexOf(null)).toBe(SAMPLE_SERIES.p95.indexOf(null))
    expect(p95.indexOf(null)).toBe(p50.indexOf(null))
  })

  it('leaves the sample series it is built from as it was', () => {
    expect(SAMPLE_SPIKE_SERIES.p95).not.toBe(SAMPLE_SERIES.p95)
    expect(Math.max(...SAMPLE_SERIES.p95.filter((value) => value !== null))).toBeLessThan(232)
  })

  it('has a lone spike in the window and a sustained climb at its end', () => {
    const spikes = spikeIndexes(SAMPLE_SPIKE_SERIES)
    expect(spikes).toContain(11)
    expect(spikes.length).toBeGreaterThan(2)
    // The spike is alone: its neighbors are within the limit.
    expect(spikes).not.toContain(10)
    expect(spikes).not.toContain(12)
    // It is the worst sample, so it is the one the chart labels.
    expect(worstSpikeIndex(SAMPLE_SPIKE_SERIES)).toBe(11)
  })

  it('has loss at or over its limit, so both limits show a mark', () => {
    expect(lossOverIndexes(SAMPLE_SPIKE_SERIES).length).toBeGreaterThan(0)
  })
})

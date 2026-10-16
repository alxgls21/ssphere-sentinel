import { describe, expect, it } from 'vitest'
import { formatTime } from '@/lib/format'
import {
  SPARK_HEIGHT,
  SPARK_WIDTH,
  TAIL_Y,
  describeSeries,
  seriesFigures,
  sparklinePoints,
  sparklineRuns,
  trailingGap,
  type Point,
} from './geometry'

const PERCENT = [0, 100] as const

/** The points that exist: a gap has none. */
const present = (points: readonly (Point | null)[]) =>
  points.filter((point): point is Point => point !== null)

describe('sparklinePoints', () => {
  const series = [98, 99, 100, 99, 97, 98, 100, 99, 99, 98, 99, 99]

  it('draws one point per value, oldest on the left, inside the canvas', () => {
    const points = present(sparklinePoints(series, PERCENT))
    expect(points).toHaveLength(12)
    const xs = points.map(([x]) => x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    // Room is left for the end dot (r 4) and its 2px ring on the right.
    expect(xs[0]).toBeGreaterThanOrEqual(1)
    expect(xs.at(-1)).toBeLessThanOrEqual(SPARK_WIDTH - 5)
    for (const [, y] of points) {
      expect(y).toBeGreaterThanOrEqual(5)
      expect(y).toBeLessThanOrEqual(SPARK_HEIGHT - 5)
    }
  })

  it('puts higher values higher up on the fixed domain', () => {
    const [low, mid, high] = present(sparklinePoints([0, 50, 100], PERCENT))
    expect(low?.[1]).toBeGreaterThan(mid?.[1] ?? 0)
    expect(mid?.[1]).toBeGreaterThan(high?.[1] ?? 0)
  })

  it('keeps a 98-100% series nearly flat rather than stretching it (fixed 0-100 domain)', () => {
    const ys = present(sparklinePoints(series, PERCENT)).map(([, y]) => y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
  })

  it('clamps values outside the domain instead of drawing outside the box', () => {
    const points = sparklinePoints([-50, 250], PERCENT)
    const top = sparklinePoints([0, 100], PERCENT)
    expect(points).toEqual(top)
  })

  it('honours a custom domain', () => {
    const [first, second] = present(sparklinePoints([10, 20], [10, 20]))
    expect(first?.[1]).toBeGreaterThan(second?.[1] ?? 0)
  })

  it('centres a series on a degenerate domain', () => {
    const [point] = present(sparklinePoints([5, 5], [5, 5]))
    expect(point?.[1]).toBe(SPARK_HEIGHT / 2)
  })

  it('draws no points for fewer than two samples', () => {
    expect(sparklinePoints([], PERCENT)).toEqual([])
    expect(sparklinePoints([99], PERCENT)).toEqual([])
    expect(sparklinePoints([99, Number.NaN], PERCENT)).toEqual([])
    expect(sparklinePoints([null, 99, null], PERCENT)).toEqual([])
  })

  it('draws nothing for a series with no sample at all', () => {
    expect(sparklinePoints([null, null, null], PERCENT)).toEqual([])
    expect(sparklinePoints([undefined, Number.NaN, Number.POSITIVE_INFINITY], PERCENT)).toEqual([])
  })

  describe('with missing samples', () => {
    it('has one entry per value, null where a sample is missing, and invents no point', () => {
      const points = sparklinePoints([10, 20, null, undefined, Number.NaN, 60, 70], PERCENT)
      expect(points).toHaveLength(7)
      expect(points.map((point) => point === null)).toEqual([
        false,
        false,
        true,
        true,
        true,
        false,
        false,
      ])
    })

    it('keeps the time axis: a sample sits where its place in the series puts it, gap or not', () => {
      const whole = sparklinePoints([10, 20, 30, 40, 50, 60], PERCENT)
      const gapped = sparklinePoints([10, 20, null, null, 50, 60], PERCENT)
      for (const index of [0, 1, 4, 5]) expect(gapped[index]?.[0]).toBe(whole[index]?.[0])
      // Closing the gap would have moved the fifth sample to where the third one is.
      expect(gapped[4]?.[0]).toBeGreaterThan(whole[2]?.[0] ?? 0)
    })

    it('spans the same width however many buckets there are', () => {
      const points = sparklinePoints(
        Array.from({ length: 60 }, () => 50),
        PERCENT,
      )
      const [first, last] = [points[0], points[59]]
      expect(first?.[0]).toBe(1)
      expect(last?.[0]).toBe(SPARK_WIDTH - 5)
    })
  })
})

describe('sparklineRuns', () => {
  it('is one run for a series with no gap', () => {
    const runs = sparklineRuns(sparklinePoints([10, 20, 30], PERCENT))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toHaveLength(3)
  })

  it('breaks the line at a missing sample: no segment crosses a gap', () => {
    const points = sparklinePoints([10, 20, null, 40, 50, 60], PERCENT)
    const runs = sparklineRuns(points)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual([points[0], points[1]])
    expect(runs[1]).toEqual([points[3], points[4], points[5]])
  })

  it('leaves a lone sample between gaps as a run of one, for a dot', () => {
    const runs = sparklineRuns(sparklinePoints([10, null, 30, null, 50, 60], PERCENT))
    expect(runs.map((run) => run.length)).toEqual([1, 1, 2])
  })

  it('splits on every kind of missing value', () => {
    const runs = sparklineRuns(sparklinePoints([1, undefined, 2, Number.NaN, 3, 4], PERCENT))
    expect(runs.map((run) => run.length)).toEqual([1, 1, 2])
  })

  it('has no run for a series that draws nothing', () => {
    expect(sparklineRuns(sparklinePoints([null, null], PERCENT))).toEqual([])
    expect(sparklineRuns([])).toEqual([])
  })
})

describe('trailingGap', () => {
  it('is null when the newest bucket has a sample', () => {
    expect(trailingGap(sparklinePoints([10, 20, 30], PERCENT))).toBeNull()
    expect(trailingGap(sparklinePoints([10, null, 30], PERCENT))).toBeNull()
    expect(trailingGap([])).toBeNull()
  })

  it('runs from the newest sample to the last bucket when the series ends on a gap', () => {
    const points = sparklinePoints([10, 20, 30, null, null], PERCENT)
    const gap = trailingGap(points)
    expect(gap?.from).toEqual(points[2])
    // The time axis ends where the last bucket sits, as it would with a sample there.
    expect(gap?.toX).toBe(sparklinePoints([1, 1, 1, 1, 1], PERCENT)[4]?.[0])
    expect(gap?.toX).toBeGreaterThan(gap?.from[0] ?? 0)
  })

  it('draws its tail under the 0% level, so it never reads as a value', () => {
    const zero = sparklinePoints([0, 0], PERCENT)[0]
    expect(TAIL_Y).toBeGreaterThan(zero?.[1] ?? 0)
    expect(TAIL_Y).toBeLessThan(SPARK_HEIGHT)
  })

  it('does not count a gap in the middle', () => {
    expect(trailingGap(sparklinePoints([10, null, null, 40], PERCENT))).toBeNull()
  })
})

describe('describeSeries', () => {
  it('reads the range and the latest value', () => {
    expect(describeSeries('Success rate last hour', [98, 99, 100, 99], 'percent')).toBe(
      'Success rate last hour: 98 to 100 percent, now 99',
    )
  })

  it('calls the latest value the last, not now, once the series is stale', () => {
    expect(describeSeries('Success rate', [98, 99, 100, 99], 'percent', undefined, true)).toBe(
      'Success rate: 98 to 100 percent, last 99',
    )
    expect(
      describeSeries(
        'CPU',
        [10, 20, 30],
        'percent',
        { times: [0, 60_000, 120_000], tz: 'utc' },
        true,
      ),
    ).toContain('last 30 percent')
  })

  it('rounds to one decimal and drops a trailing zero', () => {
    expect(describeSeries('Loss', [97.04, 99.5, 99.5], 'percent')).toBe(
      'Loss: 97 to 99.5 percent, now 99.5',
    )
  })

  it('says "throughout" when the range collapses to one value', () => {
    expect(describeSeries('Success rate', [100, 100, 100], 'percent')).toBe(
      'Success rate: 100 percent throughout',
    )
  })

  it('says there is no history for fewer than two values', () => {
    expect(describeSeries('Success rate', [], 'percent')).toBe('Success rate: no history')
    expect(describeSeries('Success rate', [99], 'percent')).toBe('Success rate: no history')
    expect(describeSeries('Success rate', [null, 99, null], 'percent')).toBe(
      'Success rate: no history',
    )
  })

  it('speaks the unit it is given', () => {
    expect(describeSeries('Latency', [10, 20], 'milliseconds')).toBe(
      'Latency: 10 to 20 milliseconds, now 20',
    )
  })

  it('counts the buckets that held no sample', () => {
    expect(describeSeries('CPU', [10, null, 30, 40], 'percent')).toBe(
      'CPU: 10 to 40 percent, now 40, 1 of 4 samples missing',
    )
  })

  it('says a series that ends on a gap went quiet, and does not call its last value "now"', () => {
    expect(describeSeries('CPU', [10, 20, null, null], 'percent')).toBe(
      'CPU: 10 to 20 percent, last 20, 2 of 4 samples missing, no samples in the last 2 of 4',
    )
  })
})

describe('seriesFigures with the bucket times', () => {
  const MINUTE = 60_000
  const START = Date.parse('2026-10-12T13:00:00Z')
  const times = (count: number) => Array.from({ length: count }, (_, i) => START + i * MINUTE)

  it('names the period, then now, min, max, average and that no sample is missing', () => {
    expect(seriesFigures([10, 20, 30, 40], 'percent', { times: times(4), tz: 'utc' })).toEqual([
      '13:00 to 13:03 UTC',
      'now 40 percent',
      'min 10 percent',
      'max 40 percent',
      'average 25 percent',
      'no samples missing',
    ])
  })

  it('counts missing samples and says since when the host has been quiet', () => {
    expect(
      seriesFigures([10, null, 30, 20, null, null], 'percent', { times: times(6), tz: 'utc' }),
    ).toEqual([
      '13:00 to 13:05 UTC',
      'last 20 percent',
      'min 10 percent',
      'max 30 percent',
      'average 20 percent',
      '3 of 6 samples missing',
      'no samples since 13:04 UTC',
    ])
  })

  it('writes the times in the chosen timezone', () => {
    const local = seriesFigures([10, 20], 'percent', { times: times(2), tz: 'local' })
    const [first, last] = [START, START + MINUTE].map((ms) => formatTime(ms, 'local', false))
    expect(local?.[0]).toBe(`${first} to ${last} local`)
  })

  it('collapses a flat series to one statement', () => {
    expect(seriesFigures([50, 50, 50], 'percent', { times: times(3), tz: 'utc' })).toEqual([
      '13:00 to 13:02 UTC',
      '50 percent throughout',
      'no samples missing',
    ])
  })

  it('averages only the samples that exist', () => {
    const figures = seriesFigures([10, null, null, 30], 'percent', { times: times(4), tz: 'utc' })
    expect(figures).toContain('average 20 percent')
  })

  it('ignores times that do not line up with the values', () => {
    expect(seriesFigures([10, 20, 30], 'percent', { times: times(2), tz: 'utc' })).toEqual([
      '10 to 30 percent',
      'now 30',
    ])
  })

  it('gives no figures for fewer than two samples', () => {
    expect(seriesFigures([null, 10, null], 'percent', { times: times(3), tz: 'utc' })).toBeNull()
  })
})

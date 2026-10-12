import { describe, expect, it } from 'vitest'
import { SPARK_HEIGHT, SPARK_WIDTH, describeSeries, sparklinePoints } from './geometry'

const PERCENT = [0, 100] as const

describe('sparklinePoints', () => {
  const series = [98, 99, 100, 99, 97, 98, 100, 99, 99, 98, 99, 99]

  it('draws one point per value, oldest on the left, inside the canvas', () => {
    const points = sparklinePoints(series, PERCENT)
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
    const [low, mid, high] = sparklinePoints([0, 50, 100], PERCENT)
    expect(low?.[1]).toBeGreaterThan(mid?.[1] ?? 0)
    expect(mid?.[1]).toBeGreaterThan(high?.[1] ?? 0)
  })

  it('keeps a 98-100% series nearly flat rather than stretching it (fixed 0-100 domain)', () => {
    const ys = sparklinePoints(series, PERCENT).map(([, y]) => y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1)
  })

  it('clamps values outside the domain instead of drawing outside the box', () => {
    const points = sparklinePoints([-50, 250], PERCENT)
    const top = sparklinePoints([0, 100], PERCENT)
    expect(points).toEqual(top)
  })

  it('honours a custom domain', () => {
    const [first, second] = sparklinePoints([10, 20], [10, 20])
    expect(first?.[1]).toBeGreaterThan(second?.[1] ?? 0)
  })

  it('centres a series on a degenerate domain', () => {
    const [point] = sparklinePoints([5, 5], [5, 5])
    expect(point?.[1]).toBe(SPARK_HEIGHT / 2)
  })

  it('draws no line for fewer than two usable values', () => {
    expect(sparklinePoints([], PERCENT)).toEqual([])
    expect(sparklinePoints([99], PERCENT)).toEqual([])
    expect(sparklinePoints([99, Number.NaN], PERCENT)).toEqual([])
  })
})

describe('describeSeries', () => {
  it('reads the range and the latest value', () => {
    expect(describeSeries('Success rate last hour', [98, 99, 100, 99], 'percent')).toBe(
      'Success rate last hour: 98 to 100 percent, now 99',
    )
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
  })

  it('speaks the unit it is given', () => {
    expect(describeSeries('Latency', [10, 20], 'milliseconds')).toBe(
      'Latency: 10 to 20 milliseconds, now 20',
    )
  })
})

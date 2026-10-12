import { describe, expect, it, vi } from 'vitest'
import type { ChartInstance } from './echarts'
import {
  growingGridHeight,
  niceAxis,
  sharedCrosshair,
  timeAxis,
  timeCursorX,
  timeExtent,
  valueAxis,
} from './timeSeries'

const T0 = Date.parse('2026-10-12T13:38:00Z')

describe('niceAxis', () => {
  it('picks the smallest 1-2-5 interval that fits the allowed number of steps', () => {
    expect(niceAxis(165, 4)).toEqual({ max: 200, interval: 50 })
    expect(niceAxis(212, 4)).toEqual({ max: 300, interval: 100 })
    expect(niceAxis(2, 2)).toEqual({ max: 2, interval: 1 })
    expect(niceAxis(12, 2)).toEqual({ max: 20, interval: 10 })
    expect(niceAxis(1800, 4)).toEqual({ max: 2000, interval: 500 })
  })

  it('always covers the value', () => {
    for (const value of [1, 7, 49, 50, 51, 163, 999, 4321]) {
      expect(niceAxis(value, 4).max).toBeGreaterThanOrEqual(value)
    }
  })
})

describe('timeExtent', () => {
  it('pads the first and last sample by half a bucket so no column is cut by the plot edge', () => {
    expect(timeExtent([T0, T0 + 60_000, T0 + 120_000], 60_000)).toEqual({
      min: T0 - 30_000,
      max: T0 + 150_000,
    })
  })

  it('leaves the scale to the chart when there are no samples', () => {
    expect(timeExtent([], 60_000)).toEqual({})
  })
})

describe('timeAxis', () => {
  const extent = { min: 1, max: 2 }

  it('is a time scale with the extent it is given, four ticks at most', () => {
    expect(timeAxis({ gridIndex: 1, extent, tz: 'utc', labelled: true })).toMatchObject({
      type: 'time',
      gridIndex: 1,
      min: 1,
      max: 2,
      splitNumber: 4,
    })
  })

  it('labels the clock in the active timezone, and only where asked', () => {
    const labelled = timeAxis({ gridIndex: 0, extent, tz: 'utc', labelled: true })
    const bare = timeAxis({ gridIndex: 0, extent, tz: 'utc', labelled: false })
    const label = (labelled.axisLabel as { formatter: (value: number) => string }).formatter
    expect(label(T0)).toBe('13:38')
    expect((bare.axisLabel as { show: boolean }).show).toBe(false)
  })
})

describe('valueAxis', () => {
  it('starts at zero and ends on the nice maximum, so a magnitude is never truncated', () => {
    const axis = valueAxis({
      gridIndex: 0,
      axis: { max: 300, interval: 100 },
      format: (value) => `${value} ms`,
    })
    expect(axis).toMatchObject({ type: 'value', min: 0, max: 300, interval: 100 })
    expect((axis.axisLabel as { formatter: (value: number) => string }).formatter(200)).toBe(
      '200 ms',
    )
  })
})

describe('sharedCrosshair', () => {
  const content = (index: number) => ({
    title: `sample ${index}`,
    rows: [{ key: 'line' as const, color: 'red', value: '1', label: 'p95' }],
  })

  it('links the pointer across every x axis, on the timezone the scale runs in', () => {
    const utc = sharedCrosshair({ tz: 'utc', content })
    expect(utc.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] })
    expect(utc.useUTC).toBe(true)
    expect(sharedCrosshair({ tz: 'local', content }).useUTC).toBe(false)
  })

  it('is one axis-triggered tooltip that lists the hovered sample, as DOM text rather than HTML', () => {
    const tooltip = sharedCrosshair({ tz: 'utc', content }).tooltip as unknown as {
      trigger: string
      formatter: (params: unknown) => HTMLElement | string
    }
    expect(tooltip.trigger).toBe('axis')
    const node = tooltip.formatter([{ dataIndex: 3 }]) as HTMLElement
    expect(node.textContent).toContain('sample 3')
    expect(node.textContent).toContain('p95')
  })

  it('shows nothing when the hovered point is unknown', () => {
    const tooltip = sharedCrosshair({ tz: 'utc', content }).tooltip as unknown as {
      formatter: (params: unknown) => unknown
    }
    expect(tooltip.formatter([])).toBe('')
  })
})

describe('growingGridHeight', () => {
  it('is the minimum before anything is measured', () => {
    expect(growingGridHeight(undefined, 1, 90, 128)).toBe(128)
    expect(growingGridHeight(0, 1, 90, 128)).toBe(128)
  })

  it('gives every spare pixel of a taller plot to the grid', () => {
    expect(growingGridHeight(300, 1, 90, 128)).toBe(210)
  })

  it('never shrinks below the minimum, however little room it is measured with', () => {
    expect(growingGridHeight(150, 1, 90, 128)).toBe(128)
  })

  it('works in base px at any root font size', () => {
    expect(growingGridHeight(450, 1.5, 90, 128)).toBe(210)
  })
})

describe('timeCursorX', () => {
  const chart = (x: number | number[]) =>
    ({ convertToPixel: vi.fn(() => x) }) as unknown as ChartInstance

  it('asks the chart for the sample x on the shared time axis', () => {
    const instance = chart(123)
    expect(timeCursorX(instance, T0)).toBe(123)
    expect(instance.convertToPixel).toHaveBeenCalledWith({ xAxisIndex: 0 }, T0)
  })

  it('answers null while the chart cannot convert the time', () => {
    expect(timeCursorX(chart([]), T0)).toBeNull()
    expect(timeCursorX(chart(Number.NaN), T0)).toBeNull()
  })
})

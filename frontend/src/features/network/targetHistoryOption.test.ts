import { describe, expect, it } from 'vitest'
import type { BarSeriesOption, ChartOption, LineSeriesOption } from '@/charts/echarts'
import { CHART_COLOR_TOKENS, type ChartColors, type ChartTokens } from '@/charts/theme'
import { REFERENCE_SERIES_PREFIX } from '@/charts/timeSeries'
import type { TargetLimits } from '@/lib/targets'
import { TARGET_CHART_HEIGHT_PX, buildTargetOption, targetGridHeight } from './targetHistoryOption'
import { series } from './testing'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors
const tokens: ChartTokens = { colors, fontFamily: 'mono', scale: 1 }

const build = (
  over: {
    hidden?: string[]
    height?: number
    limits?: TargetLimits
    protocol?: 'icmp' | 'tcp'
  } = {},
): ChartOption =>
  buildTargetOption({
    protocol: over.protocol ?? 'icmp',
    series: series(),
    tz: 'utc',
    hidden: new Set(over.hidden ?? []),
    tokens,
    height: over.height,
    limits: over.limits,
  })
const all = (option: ChartOption) =>
  [option.series ?? []].flat() as (LineSeriesOption & BarSeriesOption)[]
const data = (option: ChartOption) =>
  all(option).filter((s) => !String(s.id).startsWith(REFERENCE_SERIES_PREFIX))
const list = (value: unknown) => [value ?? []].flat() as Record<string, unknown>[]

describe('buildTargetOption', () => {
  it('draws latency, loss and failed measurements as three grids on one time axis', () => {
    const option = build()
    expect(data(option).map((s) => [s.id, s.type, s.xAxisIndex])).toEqual([
      ['latency', 'line', 0],
      ['latencyMax', 'line', 0],
      ['loss', 'line', 1],
      ['failed', 'bar', 2],
    ])
    expect(list(option.grid)).toHaveLength(3)
    expect(list(option.xAxis).map((axis) => (axis.axisLabel as { show: boolean }).show)).toEqual([
      false,
      false,
      true,
    ])
  })

  it('never fills a gap: null buckets stay null and the lines do not connect over them', () => {
    const lines = data(build()).filter((s) => s.type === 'line')
    for (const line of lines) expect(line.connectNulls).toBe(false)
    const latency = data(build()).find((s) => s.id === 'latency')
    expect(((latency?.data ?? []) as [number, number | null][]).map(([, value]) => value)).toEqual([
      10,
      180,
      null,
      null,
      12,
      11,
    ])
  })

  it('draws a bucket with no measurement as nothing, apart from one with only failures', () => {
    const failed = data(build()).find((s) => s.id === 'failed')
    expect(((failed?.data ?? []) as [number, number | null][]).map(([, value]) => value)).toEqual([
      0,
      0,
      null,
      1,
      0,
      0,
    ])
  })

  it('omits a hidden series, and keeps the reference lines whatever is hidden', () => {
    const option = build({ hidden: ['latency', 'latencyMax', 'loss', 'failed'] })
    expect(data(option)).toEqual([])
    expect(all(option).map((s) => s.id)).toEqual(['reference:latency-warn', 'reference:loss-warn'])
  })

  it('draws the warning limits, said to be the console default when the API gave none', () => {
    const marks = all(build()).filter((s) => String(s.id).startsWith(REFERENCE_SERIES_PREFIX))
    const label = (s: (typeof marks)[number]) =>
      (s.markLine as { label: { formatter: string } }).label.formatter
    expect(marks.map(label)).toEqual(['warn 150 ms (UI default)', 'warn 2% loss (UI default)'])
  })

  it('says the limits are set on the server when they are, and names TCP loss as failed', () => {
    const limits: TargetLimits = {
      latencyWarnMs: 200,
      lossWarnPercent: 5,
      critFailures: 3,
      origin: 'server',
    }
    const marks = all(build({ limits, protocol: 'tcp' })).filter((s) =>
      String(s.id).startsWith(REFERENCE_SERIES_PREFIX),
    )
    const labels = marks.map(
      (s) => (s.markLine as { label: { formatter: string } }).label.formatter,
    )
    expect(labels).toEqual([
      'warn 200 ms (set on the server)',
      'warn 5% failed (set on the server)',
    ])
  })

  it('starts every axis at zero with round ticks, and counts failures in whole numbers', () => {
    const axes = list(build().yAxis)
    expect(axes.map((axis) => axis.min)).toEqual([0, 0, 0])
    expect(axes[0]?.max).toBeGreaterThanOrEqual(260)
    expect(axes[2]).toMatchObject({ max: 1, interval: 1 })
  })

  it('grows the plot with its panel and never goes below the minimum', () => {
    expect(targetGridHeight(undefined, 1)).toBe(48)
    expect(targetGridHeight(TARGET_CHART_HEIGHT_PX - 40, 1)).toBe(48)
    expect(targetGridHeight(TARGET_CHART_HEIGHT_PX + 90, 1)).toBeCloseTo(78)
  })
})

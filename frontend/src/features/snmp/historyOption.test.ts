import { describe, expect, it } from 'vitest'
import type { BarSeriesOption, ChartOption, LineSeriesOption } from '@/charts/echarts'
import { CHART_COLOR_TOKENS, type ChartColors, type ChartTokens } from '@/charts/theme'
import {
  SNMP_CHART_HEIGHT_PX,
  buildDeviceOption,
  buildInterfaceOption,
  snmpGridHeight,
} from './historyOption'
import { deviceSeries, interfaceSeries } from './testing'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors
const tokens: ChartTokens = { colors, fontFamily: 'mono', scale: 1 }

type Series = LineSeriesOption & BarSeriesOption
const all = (option: ChartOption) => [option.series ?? []].flat() as Series[]
const list = (value: unknown) => [value ?? []].flat() as Record<string, unknown>[]
const valuesOf = (option: ChartOption, id: string) =>
  ((all(option).find((s) => s.id === id)?.data ?? []) as [number, number | null][]).map(
    ([, value]) => value,
  )

const device = (hidden: string[] = []) =>
  buildDeviceOption({ series: deviceSeries(), tz: 'utc', hidden: new Set(hidden), tokens })
const iface = (hidden: string[] = [], series = interfaceSeries()) =>
  buildInterfaceOption({ series, tz: 'utc', hidden: new Set(hidden), tokens })

describe('buildDeviceOption', () => {
  it('draws response time, reachable and failed polls on three grids with one time axis', () => {
    const option = device()
    expect(all(option).map((s) => [s.id, s.type, s.xAxisIndex])).toEqual([
      ['response', 'line', 0],
      ['reachable', 'bar', 1],
      ['failed', 'bar', 2],
    ])
    expect(list(option.grid)).toHaveLength(3)
    expect(list(option.xAxis).map((axis) => (axis.axisLabel as { show: boolean }).show)).toEqual([
      false,
      false,
      true,
    ])
  })

  it('never fills a gap: null buckets stay null and the line does not connect over them', () => {
    const option = device()
    expect(all(option)[0]?.connectNulls).toBe(false)
    expect(valuesOf(option, 'response')).toEqual([10, 180, null, null, 12, 11])
    expect(valuesOf(option, 'reachable')).toEqual([1, 1, null, 0, 1, 1])
    expect(valuesOf(option, 'failed')).toEqual([0, 0, null, 1, 0, 0])
  })

  it('omits a hidden series', () => {
    expect(all(device(['response', 'failed'])).map((s) => s.id)).toEqual(['reachable'])
  })

  it('starts every axis at zero with round ticks', () => {
    const axes = list(device().yAxis)
    expect(axes.map((axis) => axis.min)).toEqual([0, 0, 0])
    expect(axes[0]?.max).toBeGreaterThanOrEqual(180)
    expect(axes[2]).toMatchObject({ max: 1, interval: 1 })
  })
})

describe('buildInterfaceOption', () => {
  it('draws traffic, errors and discards on three grids, in and out together', () => {
    const option = iface()
    expect(all(option).map((s) => [s.id, s.xAxisIndex])).toEqual([
      ['inBps', 0],
      ['outBps', 0],
      ['inBpsMax', 0],
      ['outBpsMax', 0],
      ['inErrorsPerSec', 1],
      ['outErrorsPerSec', 1],
      ['inDiscardsPerSec', 2],
      ['outDiscardsPerSec', 2],
    ])
    for (const s of all(option)) expect(s.type).toBe('line')
  })

  it('draws a maximum as a thin line behind the mean, in the hue of its direction', () => {
    const [inMean, inMax] = all(iface()).filter((s) => ['inBps', 'inBpsMax'].includes(String(s.id)))
    const width = (s: Series | undefined) => (s?.lineStyle as { width: number } | undefined)?.width
    expect(width(inMean)).toBe(2)
    expect(width(inMax)).toBe(1)
    const color = (s: Series | undefined) => (s?.lineStyle as { color: string } | undefined)?.color
    expect(color(inMean)).toBeDefined()
    expect(color(inMean)).toBe(color(inMax))
  })

  it('never draws a sample without a rate: its bucket is a gap, not zero traffic', () => {
    const option = iface()
    expect(valuesOf(option, 'inBps')).toEqual([400e6, 800e6, null, null, 410e6, 420e6])
    // The bucket with two unusable samples has no value on any line.
    for (const s of all(option)) expect(valuesOf(option, String(s.id))[3]).toBeNull()
    for (const s of all(option)) expect(s.connectNulls).toBe(false)
  })

  it('keeps a valid zero as zero', () => {
    expect(valuesOf(iface(), 'inErrorsPerSec')).toEqual([0, 0.2, null, null, 0, 0])
  })

  it('omits a hidden series', () => {
    const option = iface(['inBpsMax', 'outBpsMax', 'inErrorsPerSec', 'outErrorsPerSec'])
    expect(all(option).map((s) => s.id)).toEqual([
      'inBps',
      'outBps',
      'inDiscardsPerSec',
      'outDiscardsPerSec',
    ])
  })

  it('scales the traffic axis to the highest value drawn, from zero, and counts per second from zero', () => {
    const axes = list(iface().yAxis)
    expect(axes.map((axis) => axis.min)).toEqual([0, 0, 0])
    expect(axes[0]?.max).toBeGreaterThanOrEqual(900e6)
    const quiet = list(iface(['inBpsMax', 'outBpsMax', 'inBps']).yAxis)
    expect(quiet[0]?.max).toBeLessThan(axes[0]?.max as number)
  })
})

describe('the plot grows with its panel', () => {
  it('never goes below the minimum', () => {
    expect(snmpGridHeight(undefined, 1)).toBe(48)
    expect(snmpGridHeight(SNMP_CHART_HEIGHT_PX - 40, 1)).toBe(48)
    expect(snmpGridHeight(SNMP_CHART_HEIGHT_PX + 90, 1)).toBeCloseTo(78)
  })
})

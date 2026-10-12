import { describe, expect, it } from 'vitest'
import type { ServerSeries } from '@/api/types'
import type { ChartOption, LineSeriesOption } from '@/charts/echarts'
import { CHART_COLOR_TOKENS, type ChartColors, type ChartTokens } from '@/charts/theme'
import { describeSample, historyTable, summarizeHistory, tooltipContent } from './historyModel'
import { HISTORY_CHART_HEIGHT_PX, buildHistoryOption, historyGridHeight } from './historyOption'

const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors
const tokens: ChartTokens = { colors, fontFamily: 'mono', scale: 1 }

const T0 = Date.parse('2026-10-12T13:38:00Z')
const series = (over: Partial<ServerSeries> = {}): ServerSeries => ({
  generatedAt: '2026-10-12T13:43:00Z',
  bucketMs: 60_000,
  t: [0, 1, 2, 3].map((minute) => T0 + minute * 60_000),
  cpu: [10, 20, 30, null],
  memory: [50, 51, 52, null],
  disk: [70, 70.5, 71, null],
  ...over,
})

const build = (hidden: string[] = [], height?: number): ChartOption =>
  buildHistoryOption({ series: series(), tz: 'utc', hidden: new Set(hidden), tokens, height })
const lines = (option: ChartOption) => [option.series ?? []].flat() as LineSeriesOption[]
const list = (value: unknown) => [value ?? []].flat() as Record<string, unknown>[]

describe('buildHistoryOption', () => {
  it('draws CPU, RAM and disk as three small multiples on one time axis', () => {
    const option = build()
    expect(lines(option).map((s) => [s.id, s.xAxisIndex, s.yAxisIndex])).toEqual([
      ['cpu', 0, 0],
      ['memory', 1, 1],
      ['disk', 2, 2],
    ])
    expect(list(option.grid)).toHaveLength(3)
    // Only the bottom grid carries the clock.
    expect(list(option.xAxis).map((axis) => (axis.axisLabel as { show: boolean }).show)).toEqual([
      false,
      false,
      true,
    ])
    expect(option.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] })
  })

  it('binds each color to its metric, so hiding one never repaints another', () => {
    const colorOf = (option: ChartOption, id: string) =>
      lines(option).find((s) => s.id === id)?.lineStyle?.color
    expect(colorOf(build(), 'memory')).toBe('token:series2')
    expect(colorOf(build(['cpu']), 'memory')).toBe('token:series2')
    expect(lines(build(['cpu'])).map((s) => s.id)).toEqual(['memory', 'disk'])
  })

  it('leaves a gap where the server stopped reporting, never an interpolated line', () => {
    const cpu = lines(build()).find((s) => s.id === 'cpu')!
    expect(cpu.connectNulls).toBe(false)
    expect((cpu.data as unknown[][])[3]).toEqual([T0 + 180_000, null])
  })

  it('marks the last real sample, not the empty bucket after it', () => {
    const cpu = lines(build()).find((s) => s.id === 'cpu')!
    expect((cpu.markPoint as { data: { coord: number[] }[] }).data[0]?.coord).toEqual([
      T0 + 120_000,
      30,
    ])
  })

  it('draws every grid from 0 to 100 percent with the warning line labelled once', () => {
    const option = build()
    for (const axis of list(option.yAxis)) expect(axis).toMatchObject({ min: 0, max: 100 })
    const labelled = lines(option).map(
      (s) => (s.markLine as { label: { show: boolean } }).label.show,
    )
    expect(labelled).toEqual([true, false, false])
  })

  it('gives the spare room of a taller plot to the three grids equally', () => {
    expect(historyGridHeight(undefined, 1)).toBe(56)
    expect(historyGridHeight(HISTORY_CHART_HEIGHT_PX + 30, 1)).toBe(66)
    expect(historyGridHeight(HISTORY_CHART_HEIGHT_PX - 20, 1)).toBe(56)
    expect(list(build([], HISTORY_CHART_HEIGHT_PX + 30).grid).map((g) => g.height)).toEqual([
      66, 66, 66,
    ])
  })
})

describe('what the chart says in words', () => {
  it('summarises the latest sample, and says when the line stopped early', () => {
    expect(summarizeHistory('db-01', series(), '1h', 'utc')).toContain(
      'at 13:40 UTC, the last sample before it stopped reporting',
    )
    const live = series({ cpu: [1, 2, 3, 4], memory: [5, 6, 7, 8], disk: [9, 9, 9, 9] })
    expect(summarizeHistory('db-01', live, '6h', 'utc')).toBe(
      'Resource history of db-01, last 6 hours: CPU 4.0 percent, RAM 8.0 percent, Disk 9.0 percent now',
    )
    expect(
      summarizeHistory('x', series({ t: [], cpu: [], memory: [], disk: [] }), '1h', 'utc'),
    ).toBe('Resource history of x, last hour: no samples')
  })

  it('reads each sample aloud, including the gaps', () => {
    expect(describeSample(series(), 0, 'utc')).toBe(
      '13:38 UTC, CPU 10.0 percent, RAM 50.0 percent, Disk 70.0 percent',
    )
    expect(describeSample(series(), 3, 'utc')).toContain('CPU no data')
  })

  it('lists one tooltip row per visible series', () => {
    const content = tooltipContent(series(), 1, 'utc', new Set(['memory']), colors)
    expect(content.title).toBe('13:39')
    expect(content.rows.map((row) => [row.label, row.value])).toEqual([
      ['CPU', '20.0%'],
      ['Disk', '70.5%'],
    ])
  })

  it('has a table twin of every sample, newest first, with dashes for gaps', () => {
    const table = historyTable('db-01', series(), '1h', 'utc')
    expect(table.rows).toHaveLength(4)
    expect(table.rows[0]).toMatchObject({ header: '13:41', cells: ['—', '—', '—'] })
    expect(table.rows[3]).toMatchObject({ header: '13:38', cells: ['10.0%', '50.0%', '70.0%'] })
    expect(table.columns.map((column) => column.label)).toEqual([
      'Time (UTC)',
      'CPU',
      'RAM',
      'Disk',
    ])
  })
})

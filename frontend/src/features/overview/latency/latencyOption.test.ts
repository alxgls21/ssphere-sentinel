import { describe, expect, it, vi } from 'vitest'
import type {
  BarSeriesOption,
  ChartInstance,
  ChartOption,
  LineSeriesOption,
} from '@/charts/echarts'
import { isReferenceSeries } from '@/charts/testing/referenceSeries'
import { CHART_COLOR_TOKENS, type ChartColors, type ChartTokens } from '@/charts/theme'
import { LATENCY_WARN_MS, LOSS_WARN_PERCENT } from '@/lib/thresholds'
import { LATENCY_CHART_HEIGHT_PX, LATENCY_GEOMETRY } from './latencyGeometry'
import { SPIKE_HEADROOM_PX } from './latencyLayout'
import {
  buildLatencyOption,
  latencyCursorPoint,
  latencyGridHeight,
  type LatencyOptionInput,
} from './latencyOption'
import { T0, makeSeries } from './testSeries'

/** Every token is a marker string, so an assertion shows exactly which token a mark is wired to. */
const colors = Object.fromEntries(
  Object.keys(CHART_COLOR_TOKENS).map((name) => [name, `token:${name}`]),
) as ChartColors
const tokens: ChartTokens = { colors, fontFamily: 'mono', scale: 1 }

function build(overrides: Partial<LatencyOptionInput> = {}): ChartOption {
  return buildLatencyOption({
    series: makeSeries(),
    tz: 'utc',
    hidden: new Set(),
    tokens,
    compact: false,
    ...overrides,
  })
}

type AnySeries = LineSeriesOption | BarSeriesOption
const seriesOf = (option: ChartOption): AnySeries[] => [option.series ?? []].flat() as AnySeries[]
/** The series the legend toggles: everything but the static references. */
const dataSeries = (option: ChartOption) => seriesOf(option).filter((s) => !isReferenceSeries(s))
const find = (option: ChartOption, id: string) => seriesOf(option).find((s) => s.id === id)
const line = (option: ChartOption, id: string) => find(option, id) as LineSeriesOption
const grids = (option: ChartOption) => [option.grid ?? []].flat()
const xAxes = (option: ChartOption) => [option.xAxis ?? []].flat()
const yAxes = (option: ChartOption) => [option.yAxis ?? []].flat()
const scaleOf = (axis: unknown) => axis as { min: number; max: number; interval: number }
const marks = (series: AnySeries | undefined) =>
  ((series?.markPoint as { data?: Record<string, unknown>[] } | undefined)?.data ?? []) as Record<
    string,
    unknown
  >[]

describe('series wiring', () => {
  it('draws p95 in primary and p50 in slate, both 2px round lines in the latency grid', () => {
    const option = build()
    for (const [id, color] of [
      ['p95', 'token:primary'],
      ['p50', 'token:seriesOther'],
    ] as const) {
      expect(find(option, id)).toMatchObject({
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        smooth: false,
        lineStyle: { width: 2, color, join: 'round', cap: 'round' },
      })
    }
  })

  it('draws packet loss as azure columns in the lower grid, capped at 6px, round at the data end only', () => {
    expect(find(build(), 'loss')).toMatchObject({
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      barMaxWidth: 6,
      itemStyle: { color: 'token:series2', borderRadius: [2, 2, 0, 0] },
    })
  })

  it('orders the series p95, p50, loss, failed probes, then the two static limits', () => {
    expect(seriesOf(build()).map((s) => s.id)).toEqual([
      'p95',
      'p50',
      'loss',
      'failed',
      'reference:latency',
      'reference:loss',
    ])
    expect(dataSeries(build()).map((s) => s.id)).toEqual(['p95', 'p50', 'loss', 'failed'])
  })

  it('draws p95, the reading to act on, over p50 where the two meet', () => {
    const option = build()
    expect(Number(line(option, 'p95').z)).toBeGreaterThan(Number(line(option, 'p50').z))
  })

  it('leaves a gap for a bucket without data: null values, no interpolation', () => {
    const p95 = line(build(), 'p95')
    expect(p95.connectNulls).toBe(false)
    expect(p95.data).toEqual([
      [T0, 100],
      [T0 + 60_000, 212],
      [T0 + 120_000, null],
      [T0 + 180_000, 150],
      [T0 + 240_000, 142],
    ])
  })

  it('hides symbols except the hovered one; the last point is a mark with a panel-colored ring', () => {
    const p95 = line(build(), 'p95')
    expect(p95.showSymbol).toBe(false)
    expect(p95.markPoint).toMatchObject({
      symbol: 'circle',
      symbolSize: 8,
      itemStyle: { color: 'token:primary', borderColor: 'token:panel', borderWidth: 2 },
    })
    expect(marks(p95)[0]).toMatchObject({ name: 'last', coord: [T0 + 240_000, 142] })
    // p50 has only its end mark: it is context, so it carries no spike marks.
    expect(marks(line(build(), 'p50'))).toHaveLength(1)
  })

  it('puts the end label on p95 and loss only, in the text color rather than a series color', () => {
    const option = build()
    expect(line(option, 'p95').markPoint).toMatchObject({
      label: { show: true, formatter: '142 ms', color: 'token:fg' },
    })
    expect(line(option, 'p50').markPoint).toMatchObject({ label: { show: false } })
    const lossEnd = marks(find(option, 'loss')).find((mark) => mark.symbol === 'circle')
    expect(lossEnd).toMatchObject({
      coord: [T0 + 240_000, 2.1],
      label: { show: true, formatter: '2.1%', color: 'token:fg' },
    })
  })

  it('drops end labels in a compact container and gives their inset back', () => {
    const option = build({ compact: true })
    expect(line(option, 'p95').markPoint).toMatchObject({ label: { show: false } })
    expect(
      marks(find(option, 'loss')).every((mark) => (mark.label as { show: boolean }).show === false),
    ).toBe(true)
    expect(grids(option).map((g) => g.right)).toEqual([8, 8])
  })

  it('uses the last measured point for the end mark when the newest bucket is empty', () => {
    const option = build({
      series: makeSeries({ p95: [100, 212, null, 150, null], lossMean: [0, 0.5, null, 2.5, null] }),
    })
    expect(marks(line(option, 'p95'))[0]).toMatchObject({ coord: [T0 + 180_000, 150] })
    expect(line(option, 'p95').markPoint).toMatchObject({ label: { formatter: '150 ms' } })
  })

  it('marks loss at or over the 2% threshold with a warning triangle, so state is not color alone', () => {
    const triangles = marks(find(build(), 'loss')).filter((mark) => mark.symbol === 'triangle')
    expect(triangles.map((mark) => mark.coord)).toEqual([
      [T0 + 180_000, 2.5],
      [T0 + 240_000, 2.1],
    ])
    expect(triangles[0]).toMatchObject({ itemStyle: { color: 'token:warning' } })
  })

  it('draws failed probes as critical diamonds on the loss baseline: a line series with no line', () => {
    const failed = line(build(), 'failed')
    expect(failed).toMatchObject({
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      symbol: 'diamond',
      lineStyle: { width: 0 },
      itemStyle: { color: 'token:critical' },
    })
    expect((failed.data as number[][]).every(([, value]) => value === 0)).toBe(true)
    const size = failed.symbolSize as (value: unknown, params: { dataIndex: number }) => number
    expect(size(0, { dataIndex: 2 })).toBeGreaterThanOrEqual(8)
    expect(size(0, { dataIndex: 1 })).toBe(0)
  })

  it('bundles no scatter series', () => {
    expect(seriesOf(build()).every((s) => s.type === 'line' || s.type === 'bar')).toBe(true)
  })
})

describe('warn limits', () => {
  const limit = (option: ChartOption, id: 'latency' | 'loss') =>
    find(option, `reference:${id}`) as LineSeriesOption
  const markLineOf = (series: LineSeriesOption | undefined) =>
    series?.markLine as { data: { yAxis: number }[]; label: Record<string, unknown> } | undefined

  it('draws the latency limit as one solid 1px warning line at 150 ms in the latency grid', () => {
    const series = limit(build(), 'latency')
    expect(series).toMatchObject({ type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [] })
    expect(series.markLine).toMatchObject({
      symbol: 'none',
      lineStyle: { color: 'token:warning', width: 1, type: 'solid', opacity: 0.6 },
      data: [{ yAxis: LATENCY_WARN_MS }],
    })
  })

  it('draws the loss limit the same way at 2% in the loss grid', () => {
    const series = limit(build(), 'loss')
    expect(series).toMatchObject({ type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: [] })
    expect(series.markLine).toMatchObject({
      symbol: 'none',
      lineStyle: { color: 'token:warning', width: 1, type: 'solid', opacity: 0.6 },
      data: [{ yAxis: LOSS_WARN_PERCENT }],
    })
  })

  it('labels each line in the same grammar, fg-faint at full contrast and 11px, a UI default', () => {
    for (const [id, text] of [
      ['latency', 'warn 150 ms (UI default)'],
      ['loss', 'warn 2% (UI default)'],
    ] as const) {
      expect(markLineOf(limit(build(), id))?.label).toMatchObject({
        show: true,
        formatter: text,
        color: 'token:fgFaint',
        opacity: 1,
        fontSize: 11,
      })
    }
  })

  it('keeps both lines whatever the legend has hidden: they ride on series of their own', () => {
    for (const hidden of [
      ['p95'],
      ['p95', 'p50'],
      ['loss', 'failed'],
      ['p95', 'p50', 'loss', 'failed'],
    ]) {
      const option = build({ hidden: new Set(hidden) })
      for (const id of ['latency', 'loss'] as const) {
        expect(markLineOf(limit(option, id))?.data).toHaveLength(1)
      }
    }
  })

  it('draws no mark line on a data series, so a hidden series takes no limit with it', () => {
    expect(dataSeries(build()).some((s) => s.markLine)).toBe(false)
  })

  it('is no legend entry and no tooltip row: the references have no data to hover', () => {
    for (const id of ['latency', 'loss'] as const) expect(limit(build(), id).data).toEqual([])
    const tooltip = build().tooltip as unknown as { formatter: (params: unknown) => HTMLElement }
    // A sample within both limits: the limits themselves are not rows.
    expect(tooltip.formatter([{ dataIndex: 0 }]).textContent).not.toContain('warn')
  })

  it('puts a label in the corner of its line that the data leaves clear', () => {
    // The default is the start of the line, above it.
    const calm = build({
      series: makeSeries({ p95: [60, 70, null, 65, 62], lossMean: [0, 0, null, 0, 0] }),
    })
    expect(markLineOf(limit(calm, 'latency'))?.label.position).toBe('insideStartTop')
    expect(markLineOf(limit(calm, 'loss'))?.label.position).toBe('insideStartTop')
    // A spike just over the line in the first half crowds the space above it: the label goes below.
    const crowded = build({
      series: makeSeries({ p95: [160, 155, null, 60, 60], p50: [50, 50, null, 50, 50] }),
    })
    expect(markLineOf(limit(crowded, 'latency'))?.label.position).not.toBe('insideStartTop')
  })

  it('leaves the label at the start of the line when the spikes are all in the second half', () => {
    const t = Array.from({ length: 10 }, (_, i) => T0 + i * 60_000)
    const p95 = [90, 90, 90, 90, 90, 90, 200, 200, 200, 200]
    const series = makeSeries({
      t,
      p95,
      p50: p95.map(() => 50),
      lossMean: p95.map(() => 0),
      failedProbes: p95.map(() => 0),
      probeCount: p95.map(() => 40),
    })
    expect(markLineOf(limit(build({ series }), 'latency'))?.label.position).toBe('insideStartTop')
  })

  it('keeps the labels out of the compact container too', () => {
    const option = build({ compact: true })
    for (const id of ['latency', 'loss'] as const) {
      expect(markLineOf(limit(option, id))?.label.show).toBe(true)
    }
  })
})

describe('latency spikes', () => {
  const spikeMarks = (option: ChartOption) =>
    marks(line(option, 'p95')).filter((mark) => mark.symbol === 'triangle')
  type Mark = Record<string, unknown> | undefined
  const labelOf = (mark: Mark) =>
    (mark?.label ?? {}) as { show?: boolean; formatter?: string; align?: string }
  /** How far above its sample a mark sits, in px (negative offsets go up). */
  const riseOf = (mark: Mark) => -((mark?.symbolOffset as number[] | undefined)?.[1] ?? 0)

  it('puts a warning triangle on every p95 sample over the limit, and on no other', () => {
    expect(spikeMarks(build()).map((mark) => mark.coord)).toEqual([[T0 + 60_000, 212]])
    const series = makeSeries({ p95: [151, 149, 150, 150.4, 300] })
    expect(spikeMarks(build({ series })).map((mark) => mark.coord)).toEqual([
      [T0, 151],
      [T0 + 240_000, 300],
    ])
  })

  it('judges the limit as displayed: 150.4 ms is not a spike, 150.5 ms is', () => {
    expect(
      spikeMarks(build({ series: makeSeries({ p95: [150.4, 150.4, 150.4, 150.4, 150.4] }) })),
    ).toEqual([])
    expect(
      spikeMarks(build({ series: makeSeries({ p95: [150.5, 90, 90, 90, 90] }) })),
    ).toHaveLength(1)
  })

  it('draws no triangle without a spike, and none on a missed sample', () => {
    const calm = makeSeries({ p95: [100, 120, null, 140, 150] })
    expect(spikeMarks(build({ series: calm }))).toEqual([])
    const gap = makeSeries({ p95: [200, null, null, 200, null] })
    expect(spikeMarks(build({ series: gap })).map((mark) => mark.coord)).toEqual([
      [T0, 200],
      [T0 + 180_000, 200],
    ])
  })

  it('draws the triangle the way the loss columns do: 8px, warning token, rising above the sample', () => {
    const [mark] = spikeMarks(build())
    expect(mark).toMatchObject({
      symbol: 'triangle',
      symbolSize: 8,
      itemStyle: { color: 'token:warning' },
    })
    expect(riseOf(mark)).toBeGreaterThan(0)
  })

  it('keeps the triangle clear of the end dot, which is 5px out with its ring', () => {
    const [mark] = spikeMarks(build())
    // The triangle is 8px tall and centred `rise` above the sample: its base is rise - 4 above it.
    expect(riseOf(mark) - 4).toBeGreaterThan(5)
  })

  it('scales the triangle and its rise with the root font size', () => {
    const [mark] = spikeMarks(build({ tokens: { ...tokens, scale: 1.5 } }))
    expect(mark).toMatchObject({ symbolSize: 12 })
    expect(riseOf(mark)).toBeCloseTo(riseOf(spikeMarks(build())[0]) * 1.5)
  })

  it('shows marks only while p95 is visible: they belong to the p95 series', () => {
    expect(find(build({ hidden: new Set(['p95']) }), 'p95')).toBeUndefined()
    const onlyP50 = build({ hidden: new Set(['p95']) })
    expect(
      seriesOf(onlyP50).some((s) =>
        marks(s).some(
          (mark) => mark.symbol === 'triangle' && mark.name === 'latency over threshold',
        ),
      ),
    ).toBe(false)
  })

  it('labels the single worst spike with its value and time, and no other sample', () => {
    const series = makeSeries({ p95: [160, 212, null, 180, 142] })
    const labelled = spikeMarks(build({ series })).filter((mark) => labelOf(mark).show)
    expect(labelled).toHaveLength(1)
    expect(labelled[0]).toMatchObject({
      coord: [T0 + 60_000, 212],
      label: { show: true, formatter: '212 ms at 13:39Z', color: 'token:fg' },
    })
  })

  it('labels no spike when nothing is over the limit', () => {
    const calm = makeSeries({ p95: [100, 120, null, 140, 150] })
    expect(
      marks(line(build({ series: calm }), 'p95')).some(
        (mark) => mark.name !== 'last' && (mark.label as { show?: boolean }).show,
      ),
    ).toBe(false)
  })

  it('states the worst spike in the active timezone', () => {
    expect(labelOf(spikeMarks(build({ tz: 'local' }))[0]).formatter).not.toContain('Z')
  })

  it('writes the label in 12px text color above its triangle, never in a series color', () => {
    const [mark] = spikeMarks(build())
    expect(mark?.label).toMatchObject({
      position: 'top',
      fontSize: 12,
      color: 'token:fg',
    })
  })

  it('aligns the label to its side near an edge, so it stays inside the plot', () => {
    const at = (index: number) => {
      const p95 = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90]
      p95[index] = 230
      const t = Array.from({ length: 10 }, (_, i) => T0 + i * 60_000)
      const series = makeSeries({
        t,
        p95,
        p50: p95.map(() => 50),
        lossMean: p95.map(() => 0),
        failedProbes: p95.map(() => 0),
        probeCount: p95.map(() => 40),
      })
      const [mark] = spikeMarks(build({ series })).filter((m) => labelOf(m).show)
      return labelOf(mark).align
    }
    expect(at(0)).toBe('left')
    expect(at(5)).toBe('center')
    expect(at(9)).toBe('right')
  })

  it('keeps the marks and the worst label in a compact container, which drops only the end labels', () => {
    const option = build({ compact: true })
    expect(spikeMarks(option)).toHaveLength(1)
    expect(labelOf(spikeMarks(option)[0]).show).toBe(true)
    expect(line(option, 'p95').markPoint).toMatchObject({ label: { show: false } })
  })

  it('leaves room above the worst spike for its triangle and label, whatever the peak', () => {
    for (const peak of [160, 200, 212, 250, 300, 400, 800, 1000]) {
      const option = build({ series: makeSeries({ p95: [100, peak, null, 150, 142] }) })
      const [axis] = yAxes(option).map(scaleOf)
      const gridPx = LATENCY_GEOMETRY.latency
      const above = LATENCY_GEOMETRY.top + ((axis?.max ?? 0) - peak) * (gridPx / (axis?.max ?? 1))
      // Triangle plus label need SPIKE_HEADROOM_PX inside the grid beyond the top inset.
      expect(above - LATENCY_GEOMETRY.top).toBeGreaterThanOrEqual(SPIKE_HEADROOM_PX - 1e-6)
    }
  })

  it('keeps the axis the same when the legend hides a series', () => {
    const scale = (option: ChartOption) =>
      yAxes(option)
        .map(scaleOf)
        .map(({ max }) => max)
    expect(scale(build({ hidden: new Set(['p95']) }))).toEqual(scale(build()))
  })
})

describe('loss limit marks', () => {
  it('marks a column at or over the limit as displayed: 1.96 reads 2.0, so it is marked', () => {
    const series = makeSeries({ lossMean: [1.94, 1.96, null, 2, 3] })
    const triangles = marks(find(build({ series }), 'loss')).filter((m) => m.symbol === 'triangle')
    expect(triangles.map((m) => m.coord)).toEqual([
      [T0 + 60_000, 1.96],
      [T0 + 180_000, 2],
      [T0 + 240_000, 3],
    ])
  })

  it('draws no triangle on a missed sample', () => {
    const series = makeSeries({ lossMean: [3, null, null, null, null] })
    const triangles = marks(find(build({ series }), 'loss')).filter((m) => m.symbol === 'triangle')
    expect(triangles.map((m) => m.coord)).toEqual([[T0, 3]])
  })
})

describe('legend toggling', () => {
  it('omits hidden series and leaves the survivors on their own colors', () => {
    const option = build({ hidden: new Set(['p95']) })
    expect(dataSeries(option).map((s) => s.id)).toEqual(['p50', 'loss', 'failed'])
    expect(find(option, 'p50')).toMatchObject({ lineStyle: { color: 'token:seriesOther' } })
  })

  it('keeps the axes stable when a series is hidden', () => {
    const scale = (option: ChartOption) =>
      yAxes(option)
        .map(scaleOf)
        .map(({ min, max, interval }) => ({ min, max, interval }))
    expect(scale(build({ hidden: new Set(['p95']) }))).toEqual(scale(build()))
  })
})

describe('grids and axes', () => {
  it('stacks a 128px latency grid over a 48px loss grid with the spec insets', () => {
    const [latency, loss] = grids(build())
    expect(latency).toMatchObject({ left: 44, right: 56, top: 8, height: 128 })
    expect(loss).toMatchObject({ left: 44, right: 56, top: 146, height: 48 })
  })

  it('sizes the 222px container to include the 28px x-axis band', () => {
    const [, loss] = grids(build())
    const lossBottom = Number(loss?.top) + Number(loss?.height)
    expect(LATENCY_CHART_HEIGHT_PX).toBe(222)
    expect(lossBottom + LATENCY_GEOMETRY.axisBand).toBe(LATENCY_CHART_HEIGHT_PX)
  })

  it('scales px geometry and symbols with the root font size', () => {
    const option = build({ tokens: { ...tokens, scale: 1.5 } })
    expect(grids(option)[0]).toMatchObject({ left: 66, top: 12, height: 192 })
    expect(line(option, 'p95')).toMatchObject({ symbolSize: 12 })
  })

  it('shares one time axis: both x axes cover the same extent, half a bucket past the data', () => {
    const [top, bottom] = xAxes(build())
    expect(top).toMatchObject({ type: 'time', gridIndex: 0 })
    expect(bottom).toMatchObject({ type: 'time', gridIndex: 1 })
    expect(top?.min).toBe(T0 - 30_000)
    expect(top?.max).toBe(T0 + 240_000 + 30_000)
    expect(top?.min).toBe(bottom?.min)
    expect(top?.max).toBe(bottom?.max)
  })

  it('labels the time axis on the bottom grid only, as HH:mm in the active timezone', () => {
    const [top, bottom] = xAxes(build())
    expect(top?.axisLabel).toMatchObject({ show: false })
    const label = bottom?.axisLabel as { show: boolean; formatter: (value: number) => string }
    expect(label.show).toBe(true)
    expect(label.formatter(T0)).toBe('13:38')
  })

  it('formats the axis in local time when asked and tells ECharts which clock to cut ticks on', () => {
    const local = build({ tz: 'local' })
    expect(local.useUTC).toBe(false)
    expect(build({ tz: 'utc' }).useUTC).toBe(true)
    const label = xAxes(local)[1]?.axisLabel as { formatter: (value: number) => string }
    const date = new Date(T0)
    expect(label.formatter(T0)).toBe(
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    )
  })

  it('never uses a dual axis: one y axis per grid, and each series reads its own grid only', () => {
    const option = build()
    const y = yAxes(option)
    expect(y).toHaveLength(2)
    expect(y.map((axis) => axis.gridIndex)).toEqual([0, 1])
    for (const series of seriesOf(option)) {
      expect(series.yAxisIndex).toBe(series.xAxisIndex)
    }
    expect(y.some((axis) => axis.position === 'right')).toBe(false)
  })

  it('starts every y axis at zero with 3 to 5 round ticks', () => {
    for (const series of [
      makeSeries(),
      makeSeries({ p95: [30, 40, 35, 38, 36], p50: [20, 22, 21, 20, 22] }),
      makeSeries({ p95: [900, 1800, 700, 600, 650] }),
    ]) {
      const latency = scaleOf(yAxes(build({ series }))[0])
      const ticks = latency.max / latency.interval + 1
      expect(latency.min).toBe(0)
      expect(ticks).toBeGreaterThanOrEqual(3)
      expect(ticks).toBeLessThanOrEqual(5)
    }
  })

  it('keeps the 150 ms threshold on the latency axis even when every value is low', () => {
    const [latency] = yAxes(build({ series: makeSeries({ p95: [30, 40, 35, 38, 36] }) }))
    expect(Number(latency?.max)).toBeGreaterThan(LATENCY_WARN_MS)
  })

  it('runs the loss axis from 0 past the 2% limit, leaving room above the line for its label', () => {
    const [, loss] = yAxes(build({ series: makeSeries({ lossMean: [0, 0, 0, 0, 0.2] }) }))
    expect(loss).toMatchObject({ min: 0, max: 4 })
    expect(Number(loss?.max)).toBeGreaterThan(LOSS_WARN_PERCENT)
    const [, high] = yAxes(build({ series: makeSeries({ lossMean: [0, 12, 0, 3, 0] }) }))
    expect(Number(high?.max)).toBeGreaterThanOrEqual(12)
  })

  it('puts units in the tick labels, not in axis names', () => {
    const [latency, loss] = yAxes(build())
    const fmt = (axis: unknown) =>
      (axis as { axisLabel: { formatter: (value: number) => string } }).axisLabel.formatter
    expect(fmt(latency)(150)).toBe('150ms')
    expect(fmt(latency)(1500)).toBe('1.5s')
    expect(fmt(loss)(2)).toBe('2%')
    expect(latency?.name).toBeUndefined()
  })
})

describe('linked crosshair and tooltip', () => {
  it('links the crosshair across every x axis', () => {
    expect(build().axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] })
  })

  it('triggers on the axis and builds a DOM element at the hovered sample, with every visible series', () => {
    const tooltip = build().tooltip as unknown as {
      trigger: string
      formatter: (params: unknown) => HTMLElement
    }
    expect(tooltip.trigger).toBe('axis')
    const node = tooltip.formatter([{ dataIndex: 4 }])
    expect(node).toBeInstanceOf(HTMLElement)
    expect(node.textContent).toContain('13:42Z')
    for (const text of [
      '142 ms',
      'p95',
      '70 ms',
      'p50',
      '2.1%',
      'loss',
      '0 of 40',
      'failed probes',
    ]) {
      expect(node.textContent).toContain(text)
    }
  })

  it('says in the tooltip which values are over their limits, in words under a warning triangle', () => {
    const tooltip = build().tooltip as unknown as { formatter: (params: unknown) => HTMLElement }
    // Sample 1: p95 212 ms is over the limit, loss 0.5% is not.
    const node = tooltip.formatter([{ dataIndex: 1 }])
    expect(node.textContent).toContain('62 ms over warn')
    expect(node.querySelectorAll('.bg-warning')).toHaveLength(1)
    // Sample 4: loss 2.1% is over its limit, p95 142 ms is not.
    const later = tooltip.formatter([{ dataIndex: 4 }])
    expect(later.textContent).toContain('0.1% over warn')
    expect(later.textContent).not.toContain('ms over warn')
  })

  it('says no data in the tooltip for a missed sample, and flags nothing', () => {
    const tooltip = build().tooltip as unknown as { formatter: (params: unknown) => HTMLElement }
    const node = tooltip.formatter([{ dataIndex: 2 }])
    expect(node.textContent).toContain('no data')
    expect(node.textContent).toContain('2 of 38')
    expect(node.textContent).not.toContain('over warn')
  })

  it('leaves a hidden series out of the tooltip too', () => {
    const tooltip = build({ hidden: new Set(['p50']) }).tooltip as unknown as {
      formatter: (params: unknown) => HTMLElement
    }
    expect(tooltip.formatter([{ dataIndex: 4 }]).textContent).not.toContain('p50')
  })

  it('shows nothing when the hovered point is unknown', () => {
    const tooltip = build().tooltip as unknown as { formatter: (params: unknown) => unknown }
    expect(tooltip.formatter([])).toBe('')
  })
})

describe('keyboard cursor point', () => {
  const chart = (x: number | number[], height = LATENCY_CHART_HEIGHT_PX) =>
    ({ convertToPixel: vi.fn(() => x), getHeight: () => height }) as unknown as ChartInstance

  it('asks the chart for the sample x on the shared time axis and sits inside the latency grid', () => {
    const instance = chart(123)
    expect(latencyCursorPoint(instance, T0)).toEqual([123, 72])
    expect(instance.convertToPixel).toHaveBeenCalledWith({ xAxisIndex: 0 }, T0)
  })

  it('follows the latency grid when the plot grew: the middle of the taller grid', () => {
    // 222px is the reference (a 128px grid, middle at 8 + 64 = 72); 100px more goes to the grid.
    expect(latencyCursorPoint(chart(123, LATENCY_CHART_HEIGHT_PX + 100), T0)).toEqual([123, 122])
  })

  it('answers null while the chart cannot convert the time', () => {
    expect(latencyCursorPoint(chart([]), T0)).toBeNull()
    expect(latencyCursorPoint(chart(Number.NaN), T0)).toBeNull()
  })
})

describe('latencyGridHeight', () => {
  const stack =
    LATENCY_GEOMETRY.top + LATENCY_GEOMETRY.gap + LATENCY_GEOMETRY.loss + LATENCY_GEOMETRY.axisBand

  it('is the reference grid at the reference plot size, and before anything is measured', () => {
    expect(latencyGridHeight(LATENCY_CHART_HEIGHT_PX, 1)).toBe(LATENCY_GEOMETRY.latency)
    expect(latencyGridHeight(undefined, 1)).toBe(LATENCY_GEOMETRY.latency)
    expect(latencyGridHeight(0, 1)).toBe(LATENCY_GEOMETRY.latency)
  })

  it('gives every extra pixel of a taller plot to the latency grid, never to the loss grid', () => {
    expect(latencyGridHeight(LATENCY_CHART_HEIGHT_PX + 40, 1)).toBe(LATENCY_GEOMETRY.latency + 40)
    expect(latencyGridHeight(stack + 300, 1)).toBe(300)
  })

  it('never shrinks below the minimum plot, however little room it is measured with', () => {
    expect(latencyGridHeight(LATENCY_CHART_HEIGHT_PX - 24, 1)).toBe(LATENCY_GEOMETRY.latency)
    expect(latencyGridHeight(stack + 10, 1)).toBe(LATENCY_GEOMETRY.latency)
  })

  it('works in base px at any root font size', () => {
    // At a 1.5x root the same plot is 1.5x as many screen px.
    expect(latencyGridHeight(LATENCY_CHART_HEIGHT_PX * 1.5, 1.5)).toBe(LATENCY_GEOMETRY.latency)
  })
})

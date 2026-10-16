import type { NetworkSeries } from '@/api/types'
import type {
  BarSeriesOption,
  ChartInstance,
  ChartOption,
  LineSeriesOption,
} from '@/charts/echarts'
import { BASE_ROOT_PX, readRootFontSize, type ChartTokens } from '@/charts/theme'
import {
  growingGridHeight,
  niceAxis,
  referenceLine,
  sharedCrosshair,
  timeAxis,
  timeCursorX,
  timeExtent,
  valueAxis,
} from '@/charts/timeSeries'
import { formatInteger, formatLatency, formatPercent, type Timezone } from '@/lib/format'
import { LATENCY_WARN_MS, LOSS_WARN_PERCENT } from '@/lib/thresholds'
import { LATENCY_GEOMETRY } from './latencyGeometry'
import {
  LATENCY_WARN_LABEL,
  LOSS_WARN_LABEL,
  lastValueIndex,
  lossOverIndexes,
  spikeIndexes,
  tooltipContent,
  worstSpikeIndex,
  worstSpikeText,
} from './latencyModel'
import {
  LIMIT_LABEL_FONT_PX,
  LOSS_AXIS_FLOOR,
  LOSS_TRIANGLE_RISE_PX,
  SPIKE_LABEL_GAP_PX,
  SPIKE_TRIANGLE_RISE_PX,
  TRIANGLE_PX,
  VALUE_LABEL_FONT_PX,
  axisFractions,
  latencyAxisTarget,
  latencyOccupants,
  lossOccupants,
  placeLimitLabel,
  textWidthPx,
  worstAlign,
} from './latencyLayout'

/**
 * Two grids on one shared time axis, never a dual axis: p95 and p50 latency
 * above, packet-loss columns and failed-probe diamonds below. Each grid draws
 * its warning limit, and a warning triangle marks every sample over it. Pure:
 * data and tokens in, an ECharts option out, so the wiring is testable without
 * a canvas.
 */

function latencyTick(value: number): string {
  return value >= 1000 ? `${Number((value / 1000).toFixed(1))}s` : `${formatInteger(value)}ms`
}

export interface LatencyOptionInput {
  series: NetworkSeries
  tz: Timezone
  /** Series ids the legend has switched off. */
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  /** A narrow container: end labels are dropped and their inset reclaimed. */
  compact: boolean
  /** The plot container's height in CSS px. Omitted: the minimum geometry. */
  height?: number
}

const present = (values: readonly (number | null)[]): number[] =>
  values.filter((value): value is number => value != null)

/**
 * Height of the latency grid in base px: whatever the plot container has beyond
 * the stack's other parts (top inset, gap, loss grid, x-axis band), but never
 * less than the minimum plot gives it. With no measurement yet it is that minimum.
 */
export function latencyGridHeight(containerPx: number | undefined, scale: number): number {
  const g = LATENCY_GEOMETRY
  return growingGridHeight(containerPx, scale, g.top + g.gap + g.loss + g.axisBand, g.latency)
}

export function buildLatencyOption({
  series,
  tz,
  hidden,
  tokens,
  compact,
  height,
}: LatencyOptionInput): ChartOption {
  const { colors, fontFamily, scale } = tokens
  const g = LATENCY_GEOMETRY
  const px = (value: number) => value * scale
  const visible = (id: string) => !hidden.has(id)

  const extent = timeExtent(series.t, series.bucketMs)
  const at = axisFractions(series.t, extent.min, extent.max)
  const spikes = spikeIndexes(series)
  const lossOver = lossOverIndexes(series)
  const worst = worstSpikeIndex(series)
  const worstText = worst >= 0 ? worstSpikeText(series, worst, tz) : ''

  const points = (values: readonly (number | null)[]): [number, number | null][] =>
    series.t.map((time, index) => [time, values[index] ?? null])

  const lastPoint = (values: readonly (number | null)[]): [number, number] | null => {
    const index = lastValueIndex(values)
    const time = series.t[index]
    const value = values[index]
    return time === undefined || value == null ? null : [time, value]
  }

  /** Direct value labels: the end of a line, the worst spike. Text color, never a series color. */
  const valueLabel = {
    color: colors.fg,
    fontFamily,
    fontSize: px(VALUE_LABEL_FONT_PX),
    fontWeight: 500,
  } as const
  const endLabel = { ...valueLabel, position: 'right', distance: px(8) } as const

  /** The warning triangle over a sample past its limit, as on the loss columns. */
  const warningTriangle = (name: string, coord: [number, number], rise: number) => ({
    name,
    coord,
    symbol: 'triangle',
    symbolSize: px(TRIANGLE_PX),
    symbolOffset: [0, -px(rise)],
    itemStyle: { color: colors.warning, borderWidth: 0 },
    label: { show: false },
  })

  /**
   * The last measured point of a line: an 8px dot with a 2px panel ring, and optionally its value
   * as a label. On p95 also a triangle over every sample above the limit, the worst of them
   * labelled with its value and time above its triangle.
   */
  const lineEnd = (
    values: readonly (number | null)[],
    color: string,
    labelled: boolean,
    spiking: readonly number[] = [],
  ): LineSeriesOption['markPoint'] => {
    const last = lastPoint(values)
    const triangles = spiking.flatMap((index) => {
      const time = series.t[index]
      const value = values[index]
      if (time === undefined || value == null) return []
      const mark = warningTriangle('latency over threshold', [time, value], SPIKE_TRIANGLE_RISE_PX)
      return [
        index === worst
          ? {
              ...mark,
              label: {
                ...valueLabel,
                show: true,
                position: 'top',
                distance: px(SPIKE_LABEL_GAP_PX),
                align: worstAlign(at[index] ?? 0, worstText),
                formatter: worstText,
              },
            }
          : mark,
      ]
    })
    if (!last && triangles.length === 0) return undefined
    return {
      silent: true,
      animation: false,
      symbol: 'circle',
      symbolSize: px(8),
      itemStyle: { color, borderColor: colors.panel, borderWidth: 2 },
      label: { ...endLabel, show: labelled && !compact, formatter: formatLatency(last?.[1]) },
      // The end dot first: a triangle that reaches it is drawn whole, over the dot.
      data: [...(last ? [{ name: 'last', coord: last }] : []), ...triangles],
    }
  }

  const latencyLine = (id: 'p95' | 'p50', values: readonly (number | null)[]): LineSeriesOption => {
    const color = id === 'p95' ? colors.primary : colors.seriesOther
    return {
      id,
      name: id,
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      // p95 is the reading to act on: it draws over p50 where the two meet.
      z: id === 'p95' ? 4 : 3,
      data: points(values),
      // Measurements are discrete: a missed probe is a gap, never an interpolated line.
      smooth: false,
      connectNulls: false,
      // Symbols appear only on the hovered sample (and the last point, as a mark).
      showSymbol: false,
      symbol: 'circle',
      symbolSize: px(8),
      lineStyle: { width: 2, color, join: 'round', cap: 'round' },
      itemStyle: { color, borderColor: colors.panel, borderWidth: 2 },
      emphasis: { scale: false, lineStyle: { width: 2 } },
      // Direct end label and spike marks on p95 only: p50 is context.
      markPoint: lineEnd(values, color, id === 'p95', id === 'p95' ? spikes : []),
    }
  }

  const lossColumns = (): BarSeriesOption => {
    const lossPoints = points(series.lossMean)
    const tip = lastPoint(series.lossMean)
    const triangles = lossOver.flatMap((index) => {
      const time = series.t[index]
      const value = series.lossMean[index]
      return time === undefined || value == null
        ? []
        : [warningTriangle('loss at or over threshold', [time, value], LOSS_TRIANGLE_RISE_PX)]
    })
    return {
      id: 'loss',
      name: 'loss',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      z: 2,
      data: lossPoints,
      barMaxWidth: px(6),
      // A 2px surface gap between neighbouring columns at 1-minute buckets.
      barCategoryGap: '40%',
      // Rounded at the data end, square at the baseline.
      itemStyle: { color: colors.series2, borderRadius: [2, 2, 0, 0] },
      markPoint: {
        silent: true,
        animation: false,
        data: [
          // A column at or over the loss threshold carries a triangle, so the state is not color alone.
          ...triangles,
          ...(tip
            ? [
                {
                  name: 'last',
                  coord: tip,
                  // A zero-size mark carries the label: with symbol 'none' ECharts draws no label at all.
                  symbol: 'circle',
                  symbolSize: 0,
                  label: {
                    ...endLabel,
                    show: !compact,
                    formatter: formatPercent(tip[1], 1),
                  },
                },
              ]
            : []),
        ],
      },
    }
  }

  /** Failed probes: a line series with symbol 'diamond' and no line, so no ScatterChart is bundled. */
  const failedProbes = (): LineSeriesOption => ({
    id: 'failed',
    name: 'failed probes',
    type: 'line',
    xAxisIndex: 1,
    yAxisIndex: 1,
    z: 4,
    // Every sample sits on the baseline; only buckets with failures get a visible symbol.
    data: series.t.map((time) => [time, 0]),
    showSymbol: true,
    symbol: 'diamond',
    symbolSize: (_value: unknown, params: { dataIndex: number }) =>
      (series.failedProbes[params.dataIndex] ?? 0) > 0 ? px(9) : 0,
    lineStyle: { width: 0 },
    itemStyle: { color: colors.critical, borderColor: colors.panel, borderWidth: 1 },
    emphasis: { scale: false },
  })

  const latencyLines = [
    ...(visible('p95') ? [latencyLine('p95', series.p95)] : []),
    ...(visible('p50') ? [latencyLine('p50', series.p50)] : []),
  ]

  const latencyHeight = latencyGridHeight(height, scale)
  const latencyAxis = niceAxis(
    latencyAxisTarget(
      Math.max(0, ...present(series.p95)),
      Math.max(0, ...present(series.p50)),
      worst >= 0,
      latencyHeight,
    ),
    4,
  )
  const lossAxis = niceAxis(Math.max(LOSS_AXIS_FLOOR, ...present(series.lossMean)), 2)

  // Both limits are static references, drawn whatever the legend has hidden. Each label takes the
  // corner of its line that the data leaves clear.
  const limitLines = [
    referenceLine({
      id: 'latency',
      gridIndex: 0,
      value: LATENCY_WARN_MS,
      label: LATENCY_WARN_LABEL,
      position: placeLimitLabel(
        latencyOccupants({
          at,
          p95: series.p95,
          p50: series.p50,
          axisMax: latencyAxis.max,
          gridPx: latencyHeight,
          spikes,
          worst,
          worstText,
          last: lastValueIndex(series.p95),
        }),
        textWidthPx(LATENCY_WARN_LABEL, LIMIT_LABEL_FONT_PX),
      ),
      tokens,
    }),
    referenceLine({
      id: 'loss',
      gridIndex: 1,
      value: LOSS_WARN_PERCENT,
      label: LOSS_WARN_LABEL,
      position: placeLimitLabel(
        lossOccupants({
          at,
          loss: series.lossMean,
          axisMax: lossAxis.max,
          gridPx: g.loss,
          over: lossOver,
        }),
        textWidthPx(LOSS_WARN_LABEL, LIMIT_LABEL_FONT_PX),
      ),
      tokens,
    }),
  ]

  const left = px(g.left)
  const right = px(compact ? g.rightCompact : g.right)
  const bottomGridTop = g.top + latencyHeight + g.gap

  return {
    // outerBoundsMode none: the insets are exact, so both grids align on the shared time axis.
    grid: [
      { left, right, top: px(g.top), height: px(latencyHeight), outerBoundsMode: 'none' },
      { left, right, top: px(bottomGridTop), height: px(g.loss), outerBoundsMode: 'none' },
    ],
    xAxis: [
      timeAxis({ gridIndex: 0, extent, tz, labelled: false }),
      timeAxis({ gridIndex: 1, extent, tz, labelled: true }),
    ],
    yAxis: [
      valueAxis({ gridIndex: 0, axis: latencyAxis, format: latencyTick }),
      valueAxis({ gridIndex: 1, axis: lossAxis, format: (value) => `${value}%` }),
    ],
    // One crosshair across both grids, one tooltip, the timezone the scale runs in.
    ...sharedCrosshair({
      tz,
      content: (index) => tooltipContent(series, index, tz, hidden, colors),
    }),
    series: [
      ...latencyLines,
      ...(visible('loss') ? [lossColumns()] : []),
      ...(visible('failed') ? [failedProbes()] : []),
      ...limitLines,
    ],
  }
}

/**
 * Where the keyboard cursor puts the crosshair for the sample at `time`: that
 * sample's x, vertically inside the latency grid (the tooltip is linked to both).
 */
export function latencyCursorPoint(
  chart: ChartInstance,
  time: number,
): readonly [number, number] | null {
  const x = timeCursorX(chart, time)
  if (x === null) return null
  const scale = readRootFontSize() / BASE_ROOT_PX
  const latencyHeight = latencyGridHeight(chart.getHeight(), scale)
  return [x, (LATENCY_GEOMETRY.top + latencyHeight / 2) * scale]
}

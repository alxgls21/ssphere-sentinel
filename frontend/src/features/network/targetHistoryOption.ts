import type { TargetProtocol, TargetSeries } from '@/api/types'
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
import { formatLatency, type Timezone } from '@/lib/format'
import { DEFAULT_TARGET_LIMITS, type TargetLimits } from '@/lib/targets'
import { historySpecs, tooltipContent, valuesOf, type TargetHistoryId } from './targetHistoryModel'

/**
 * Three small multiples on one shared time axis: latency (the mean and the highest of the
 * measurements that succeeded), loss (what the protocol measures, from the same measurements) and
 * the count of failed measurements. A bucket with nothing to average is a gap, never a
 * interpolated line or a zero. Pure: data and tokens in, an option out.
 */

/** Geometry at the 16px root, in px. */
const G = { left: 52, right: 12, top: 8, grid: 48, gap: 10, axisBand: 28 } as const
const GRIDS = 3

const FIXED = G.top + (GRIDS - 1) * G.gap + G.axisBand

/** The minimum plot (x-axis band included): the figure grows from here. */
export const TARGET_CHART_HEIGHT_PX = FIXED + GRIDS * G.grid

/** Height of each grid in base px: the plot's spare room is shared by the three. */
export function targetGridHeight(containerPx: number | undefined, scale: number): number {
  return growingGridHeight(containerPx, scale, FIXED, GRIDS * G.grid) / GRIDS
}

const maxOf = (values: readonly (number | null)[]): number =>
  values.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0)

export interface TargetOptionInput {
  protocol: TargetProtocol
  series: TargetSeries
  tz: Timezone
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  /** The plot container's height in CSS px. Omitted: the minimum geometry. */
  height?: number
  limits?: TargetLimits
}

export function buildTargetOption({
  protocol,
  series,
  tz,
  hidden,
  tokens,
  height,
  limits = DEFAULT_TARGET_LIMITS,
}: TargetOptionInput): ChartOption {
  const { colors, scale } = tokens
  const px = (value: number) => value * scale
  const gridHeight = targetGridHeight(height, scale)
  const extent = timeExtent(series.t, series.bucketMs)
  const specs = historySpecs(protocol)
  const origin = limits.origin === 'server' ? 'set on the server' : 'UI default'

  const shown = (id: TargetHistoryId) => !hidden.has(id)
  const latencyTop = Math.max(
    ...(shown('latency') ? [maxOf(series.latencyMs)] : [0]),
    ...(shown('latencyMax') ? [maxOf(series.latencyMaxMs)] : [0]),
    limits.latencyWarnMs,
  )
  const lossTop = Math.max(shown('loss') ? maxOf(series.lossPercent) : 0, limits.lossWarnPercent)
  const failedTop = Math.max(shown('failed') ? maxOf(valuesOf(series, 'failed')) : 0, 1)
  const axes = [niceAxis(latencyTop, 4), niceAxis(lossTop, 2), niceAxis(failedTop, 2)]

  const lines = specs.flatMap((spec): (LineSeriesOption | BarSeriesOption)[] => {
    if (hidden.has(spec.id)) return []
    const stroke = colors[spec.color]
    const values = valuesOf(series, spec.id)
    const data = series.t.map((t, index) => [t, values[index] ?? null])
    if (spec.id === 'failed') {
      return [
        {
          id: spec.id,
          name: spec.id,
          type: 'bar',
          xAxisIndex: spec.grid,
          yAxisIndex: spec.grid,
          z: 2,
          data,
          barMaxWidth: px(6),
          // Rounded at the data end, square at the baseline.
          itemStyle: { color: stroke, borderRadius: [2, 2, 0, 0] },
        },
      ]
    }
    return [
      {
        id: spec.id,
        name: spec.id,
        type: 'line',
        xAxisIndex: spec.grid,
        yAxisIndex: spec.grid,
        z: 3,
        data,
        // A bucket with nothing to average is a gap, never an interpolated line.
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: px(8),
        lineStyle: { width: 2, color: stroke, join: 'round', cap: 'round' },
        itemStyle: { color: stroke, borderColor: colors.panel, borderWidth: 2 },
        emphasis: { scale: false, lineStyle: { width: 2 } },
      },
    ]
  })

  const top = (index: number) => G.top + index * (gridHeight + G.gap)
  const lastGrid = GRIDS - 1
  const formats = [
    (value: number) => formatLatency(value),
    (value: number) => `${value}%`,
    (value: number) => String(value),
  ]

  return {
    // outerBoundsMode none: the insets are exact, so every grid aligns on the shared time axis.
    grid: axes.map((_, index) => ({
      left: px(G.left),
      right: px(G.right),
      top: px(top(index)),
      height: px(gridHeight),
      outerBoundsMode: 'none' as const,
    })),
    xAxis: axes.map((_, index) =>
      timeAxis({ gridIndex: index, extent, tz, labelled: index === lastGrid }),
    ),
    yAxis: axes.map((axis, index) =>
      valueAxis({ gridIndex: index, axis, format: formats[index] ?? String }),
    ),
    ...sharedCrosshair({
      tz,
      content: (index) => tooltipContent(protocol, series, index, tz, hidden, colors),
    }),
    series: [
      ...lines,
      referenceLine({
        id: 'latency-warn',
        gridIndex: 0,
        value: limits.latencyWarnMs,
        label: `warn ${limits.latencyWarnMs} ms (${origin})`,
        position: 'insideStartTop',
        tokens,
      }),
      referenceLine({
        id: 'loss-warn',
        gridIndex: 1,
        value: limits.lossWarnPercent,
        label: `warn ${limits.lossWarnPercent}% ${protocol === 'icmp' ? 'loss' : 'failed'} (${origin})`,
        position: 'insideStartTop',
        tokens,
      }),
    ],
  }
}

/**
 * Where the keyboard cursor puts the crosshair for the bucket at `time`: that bucket's x, vertically
 * inside the first grid (the tooltip is linked to all).
 */
export function targetCursorPoint(
  chart: ChartInstance,
  time: number,
): readonly [number, number] | null {
  const x = timeCursorX(chart, time)
  if (x === null) return null
  const scale = readRootFontSize() / BASE_ROOT_PX
  return [x, (G.top + targetGridHeight(chart.getHeight(), scale) / 2) * scale]
}

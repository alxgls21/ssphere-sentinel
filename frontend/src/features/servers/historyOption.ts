import type { ServerSeries } from '@/api/types'
import type { ChartInstance, ChartOption, LineSeriesOption } from '@/charts/echarts'
import { BASE_ROOT_PX, readRootFontSize, type ChartTokens } from '@/charts/theme'
import {
  growingGridHeight,
  sharedCrosshair,
  timeAxis,
  timeCursorX,
  timeExtent,
  valueAxis,
} from '@/charts/timeSeries'
import type { Timezone } from '@/lib/format'
import { RESOURCE_WARN_PERCENT } from '@/lib/thresholds'
import { HISTORY_SERIES, tooltipContent, valuesOf } from './historyModel'

/**
 * Three small multiples on one shared time axis: CPU, RAM and disk each get a
 * grid of their own, all 0-100 %. Same unit, but very different dynamics (disk
 * barely moves; CPU never stops), so one shared scale would flatten two of them.
 * Pure: data and tokens in, an option out.
 */

/** Geometry at the 16px root, in px. */
const G = { left: 44, right: 12, top: 8, grid: 56, gap: 10, axisBand: 28 } as const

const FIXED = G.top + (HISTORY_SERIES.length - 1) * G.gap + G.axisBand

/** The minimum plot (x-axis band included): the figure grows from here. */
export const HISTORY_CHART_HEIGHT_PX = FIXED + HISTORY_SERIES.length * G.grid

/** Height of each grid in base px: the plot's spare room is shared by the three. */
export function historyGridHeight(containerPx: number | undefined, scale: number): number {
  return (
    growingGridHeight(containerPx, scale, FIXED, HISTORY_SERIES.length * G.grid) /
    HISTORY_SERIES.length
  )
}

export interface HistoryOptionInput {
  series: ServerSeries
  tz: Timezone
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  /** The plot container's height in CSS px. Omitted: the minimum geometry. */
  height?: number
  /** The warning limit to draw, and whose it is. Omitted: the console's default. */
  limit?: { warn: number; origin: 'server' | 'default' }
}

export function buildHistoryOption({
  series,
  tz,
  hidden,
  tokens,
  height,
  limit = { warn: RESOURCE_WARN_PERCENT, origin: 'default' },
}: HistoryOptionInput): ChartOption {
  const { colors, fontFamily, scale } = tokens
  const px = (value: number) => value * scale
  const gridHeight = historyGridHeight(height, scale)
  const extent = timeExtent(series.t, series.bucketMs)

  const lines = HISTORY_SERIES.flatMap(({ id, color }, gridIndex): LineSeriesOption[] => {
    if (hidden.has(id)) return []
    const stroke = colors[color]
    const values = valuesOf(series, id)
    let lastAt = -1
    values.forEach((value, index) => {
      if (value != null) lastAt = index
    })
    const time = series.t[lastAt]
    const value = values[lastAt]
    return [
      {
        id,
        name: id,
        type: 'line',
        xAxisIndex: gridIndex,
        yAxisIndex: gridIndex,
        z: 3,
        data: series.t.map((t, index) => [t, values[index] ?? null]),
        // A missed sample is a gap, never an interpolated line: an offline host's line simply stops.
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: px(8),
        lineStyle: { width: 2, color: stroke, join: 'round', cap: 'round' },
        itemStyle: { color: stroke, borderColor: colors.panel, borderWidth: 2 },
        emphasis: { scale: false, lineStyle: { width: 2 } },
        markPoint:
          time === undefined || value == null
            ? undefined
            : {
                silent: true,
                animation: false,
                symbol: 'circle',
                symbolSize: px(8),
                itemStyle: { color: stroke, borderColor: colors.panel, borderWidth: 2 },
                label: { show: false },
                data: [{ name: 'last', coord: [time, value] }],
              },
        markLine: {
          silent: true,
          animation: false,
          symbol: 'none',
          lineStyle: { color: colors.warning, opacity: 0.6, width: 1, type: 'solid' },
          label: {
            show: gridIndex === 0,
            position: 'insideStartTop',
            formatter: `warn ${limit.warn}% (${limit.origin === 'server' ? 'set on the server' : 'UI default'})`,
            color: colors.fgFaint,
            opacity: 1,
            fontFamily,
            fontSize: px(11),
          },
          data: [{ yAxis: limit.warn }],
        },
      },
    ]
  })

  const top = (index: number) => G.top + index * (gridHeight + G.gap)
  const lastGrid = HISTORY_SERIES.length - 1
  const percentAxis = { max: 100, interval: 50 }

  return {
    // outerBoundsMode none: the insets are exact, so every grid aligns on the shared time axis.
    grid: HISTORY_SERIES.map((_, index) => ({
      left: px(G.left),
      right: px(G.right),
      top: px(top(index)),
      height: px(gridHeight),
      outerBoundsMode: 'none' as const,
    })),
    xAxis: HISTORY_SERIES.map((_, index) =>
      timeAxis({ gridIndex: index, extent, tz, labelled: index === lastGrid }),
    ),
    yAxis: HISTORY_SERIES.map((_, index) =>
      valueAxis({ gridIndex: index, axis: percentAxis, format: (value) => `${value}%` }),
    ),
    ...sharedCrosshair({
      tz,
      content: (index) => tooltipContent(series, index, tz, hidden, colors),
    }),
    series: lines,
  }
}

/**
 * Where the keyboard cursor puts the crosshair for the sample at `time`: that
 * sample's x, vertically inside the first grid (the tooltip is linked to all).
 */
export function historyCursorPoint(
  chart: ChartInstance,
  time: number,
): readonly [number, number] | null {
  const x = timeCursorX(chart, time)
  if (x === null) return null
  const scale = readRootFontSize() / BASE_ROOT_PX
  return [x, (G.top + historyGridHeight(chart.getHeight(), scale) / 2) * scale]
}

import type { DeviceSeries, InterfaceSeries } from '@/api/types'
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
  sharedCrosshair,
  timeAxis,
  timeCursorX,
  timeExtent,
  valueAxis,
  type NiceAxis,
} from '@/charts/timeSeries'
import { formatBitsPerSecond, formatLatency, type Timezone } from '@/lib/format'
import {
  DEVICE_SPECS,
  INTERFACE_SPECS,
  deviceTooltip,
  deviceValues,
  interfaceTooltip,
  interfaceValues,
  type DeviceHistoryId,
  type HistorySpec,
  type InterfaceHistoryId,
} from './historyModel'

/**
 * Three small multiples on one shared time axis, for a device (response time, reachable polls,
 * failed polls) and for an interface (traffic, errors per second, discards per second). A bucket
 * with nothing to average is a gap, never an interpolated line or a zero. Pure: data and tokens in,
 * an option out.
 */

/** Geometry at the 16px root, in px. */
const G = { left: 60, right: 12, top: 8, grid: 48, gap: 10, axisBand: 28 } as const
const GRIDS = 3

const FIXED = G.top + (GRIDS - 1) * G.gap + G.axisBand

/** The minimum plot (x-axis band included): the figure grows from here. */
export const SNMP_CHART_HEIGHT_PX = FIXED + GRIDS * G.grid

/** Height of each grid in base px: the plot's spare room is shared by the three. */
export function snmpGridHeight(containerPx: number | undefined, scale: number): number {
  return growingGridHeight(containerPx, scale, FIXED, GRIDS * G.grid) / GRIDS
}

const maxOf = (values: readonly (number | null)[]): number =>
  values.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0)

interface Stack<Id extends string> {
  specs: readonly HistorySpec<Id>[]
  t: readonly number[]
  bucketMs: number
  values: (id: Id) => (number | null)[]
  /** The value axis of each grid, from what is drawn on it. */
  axes: readonly NiceAxis[]
  formats: readonly ((value: number) => string)[]
  tz: Timezone
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  height?: number
  content: Parameters<typeof sharedCrosshair>[0]['content']
}

function buildStack<Id extends string>(input: Stack<Id>): ChartOption {
  const { specs, t, bucketMs, values, axes, formats, tz, hidden, tokens, height, content } = input
  const { colors, scale } = tokens
  const px = (value: number) => value * scale
  const gridHeight = snmpGridHeight(height, scale)
  const extent = timeExtent(t, bucketMs)

  const series = specs.flatMap((spec): (LineSeriesOption | BarSeriesOption)[] => {
    if (hidden.has(spec.id)) return []
    const stroke = colors[spec.color]
    const data = values(spec.id).map((value, index) => [t[index] ?? 0, value ?? null])
    if (spec.bar) {
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
        z: spec.thin ? 2 : 3,
        data,
        // A bucket with nothing to average is a gap, never an interpolated line.
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: px(8),
        lineStyle: {
          width: spec.thin ? 1 : 2,
          color: stroke,
          opacity: spec.thin ? 0.6 : 1,
          join: 'round',
          cap: 'round',
        },
        itemStyle: { color: stroke, borderColor: colors.panel, borderWidth: 2 },
        emphasis: { scale: false, lineStyle: { width: spec.thin ? 1 : 2 } },
      },
    ]
  })

  const top = (index: number) => G.top + index * (gridHeight + G.gap)
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
      timeAxis({ gridIndex: index, extent, tz, labelled: index === GRIDS - 1 }),
    ),
    yAxis: axes.map((axis, index) =>
      valueAxis({ gridIndex: index, axis, format: formats[index] ?? String }),
    ),
    ...sharedCrosshair({ tz, content }),
    series,
  }
}

/** The top of the axis of one grid: what is drawn on it, as it is not hidden, and never less than 1. */
function axisTop<Id extends string>(
  specs: readonly HistorySpec<Id>[],
  grid: number,
  hidden: ReadonlySet<string>,
  values: (id: Id) => (number | null)[],
): number {
  return Math.max(
    1,
    ...specs
      .filter((spec) => spec.grid === grid && !hidden.has(spec.id))
      .map((spec) => maxOf(values(spec.id))),
  )
}

interface Common {
  tz: Timezone
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  /** The plot container's height in CSS px. Omitted: the minimum geometry. */
  height?: number
}

export function buildDeviceOption({
  series,
  ...common
}: Common & { series: DeviceSeries }): ChartOption {
  const values = (id: DeviceHistoryId) => deviceValues(series, id)
  const axes = [0, 1, 2].map((grid) =>
    niceAxis(axisTop(DEVICE_SPECS, grid, common.hidden, values), grid === 0 ? 4 : 2),
  )
  return buildStack({
    ...common,
    specs: DEVICE_SPECS,
    t: series.t,
    bucketMs: series.bucketMs,
    values,
    axes,
    formats: [(value) => formatLatency(value), String, String],
    content: (index) =>
      deviceTooltip(series, index, common.tz, common.hidden, common.tokens.colors),
  })
}

export function buildInterfaceOption({
  series,
  ...common
}: Common & { series: InterfaceSeries }): ChartOption {
  const values = (id: InterfaceHistoryId) => interfaceValues(series, id)
  const axes = [0, 1, 2].map((grid) =>
    niceAxis(axisTop(INTERFACE_SPECS, grid, common.hidden, values), grid === 0 ? 4 : 2),
  )
  return buildStack({
    ...common,
    specs: INTERFACE_SPECS,
    t: series.t,
    bucketMs: series.bucketMs,
    values,
    axes,
    formats: [
      (value) => formatBitsPerSecond(value, 0),
      (value) => `${value}/s`,
      (value) => `${value}/s`,
    ],
    content: (index) =>
      interfaceTooltip(series, index, common.tz, common.hidden, common.tokens.colors),
  })
}

/**
 * Where the keyboard cursor puts the crosshair for the bucket at `time`: that bucket's x, vertically
 * inside the first grid (the tooltip is linked to all).
 */
export function snmpCursorPoint(
  chart: ChartInstance,
  time: number,
): readonly [number, number] | null {
  const x = timeCursorX(chart, time)
  if (x === null) return null
  const scale = readRootFontSize() / BASE_ROOT_PX
  return [x, (G.top + snmpGridHeight(chart.getHeight(), scale) / 2) * scale]
}

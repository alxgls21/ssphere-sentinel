import type { LegendEntry } from '@/charts/ChartLegend'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { ChartOption, LineSeriesOption } from '@/charts/echarts'
import { cssColor, type ChartColorName, type ChartColors, type ChartTokens } from '@/charts/theme'
import {
  growingGridHeight,
  niceAxis,
  sharedCrosshair,
  timeAxis,
  timeExtent,
  valueAxis,
} from '@/charts/timeSeries'
import type { TooltipContent } from '@/charts/tooltip'
import { formatBitsPerSecond, formatTime, timezoneLabel, type Timezone } from '@/lib/format'
import { SAMPLE_TIME } from './data'

/**
 * A second chart for the gallery, built only from the shared frame and the
 * shared time-series pieces. It exists to show that a new monitoring chart
 * (here one grid, two measures of one unit) gets the same legend, crosshair,
 * keyboard cursor and table twin as the Overview's latency chart for free, and
 * to give the chart contract test a second consumer. The numbers are invented.
 */

export interface BandwidthSeries {
  bucketMs: number
  t: number[]
  /** Bits per second received and sent: one unit, so one axis. */
  inBps: number[]
  outBps: number[]
}

const BUCKET_MS = 60_000
const SAMPLES = 30

function sampleBandwidth(): BandwidthSeries {
  const t = Array.from(
    { length: SAMPLES },
    (_, index) => SAMPLE_TIME - (SAMPLES - 1 - index) * BUCKET_MS,
  )
  return {
    bucketMs: BUCKET_MS,
    t,
    inBps: t.map((_, i) => Math.round(420e6 + 160e6 * Math.sin(i / 4) + 40e6 * Math.sin(i * 1.7))),
    outBps: t.map((_, i) => Math.round(110e6 + 45e6 * Math.cos(i / 3) + 12e6 * Math.sin(i * 2.3))),
  }
}

export const SAMPLE_BANDWIDTH: BandwidthSeries = sampleBandwidth()

export type BandwidthSeriesId = 'in' | 'out'

interface BandwidthSeriesSpec {
  id: BandwidthSeriesId
  label: string
  /** Color is bound to the direction, never to its rank among the visible series. */
  color: ChartColorName
}

const SPECS: readonly BandwidthSeriesSpec[] = [
  { id: 'in', label: 'in', color: 'primary' },
  { id: 'out', label: 'out', color: 'series2' },
]

export const BANDWIDTH_SERIES_IDS: readonly BandwidthSeriesId[] = SPECS.map(({ id }) => id)

export const BANDWIDTH_LEGEND: readonly LegendEntry[] = SPECS.map(({ id, label, color }) => ({
  id,
  label,
  shape: 'line',
  color: cssColor(color),
}))

/** Chart geometry at the 16px root, in px. */
const GEOMETRY = { left: 52, right: 12, top: 8, grid: 128, axisBand: 28 } as const

/** The minimum plot, x-axis band included: the figure grows from here. */
export const BANDWIDTH_CHART_HEIGHT_PX = GEOMETRY.top + GEOMETRY.grid + GEOMETRY.axisBand

const valuesOf = (series: BandwidthSeries, id: BandwidthSeriesId) =>
  id === 'in' ? series.inBps : series.outBps

interface BandwidthOptionInput {
  series: BandwidthSeries
  tz: Timezone
  hidden: ReadonlySet<string>
  tokens: ChartTokens
  /** The plot container's height in CSS px. Omitted: the minimum geometry. */
  height?: number
}

export function tooltipContent(
  series: BandwidthSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  return {
    title: formatTime(series.t[index] ?? 0, tz, false),
    rows: SPECS.filter(({ id }) => !hidden.has(id)).map((spec) => ({
      key: 'line',
      color: colors[spec.color],
      value: formatBitsPerSecond(valuesOf(series, spec.id)[index]),
      label: spec.label,
    })),
  }
}

export function buildBandwidthOption({
  series,
  tz,
  hidden,
  tokens,
  height,
}: BandwidthOptionInput): ChartOption {
  const { colors, scale } = tokens
  const px = (value: number) => value * scale
  const visible = SPECS.filter(({ id }) => !hidden.has(id))

  const lines = visible.map(({ id, color }): LineSeriesOption => {
    const stroke = colors[color]
    return {
      id,
      name: id,
      type: 'line',
      z: 3,
      data: series.t.map((time, index) => [time, valuesOf(series, id)[index] ?? null]),
      smooth: false,
      connectNulls: false,
      showSymbol: false,
      symbol: 'circle',
      symbolSize: px(8),
      lineStyle: { width: 2, color: stroke, join: 'round', cap: 'round' },
      itemStyle: { color: stroke, borderColor: colors.panel, borderWidth: 2 },
      emphasis: { scale: false, lineStyle: { width: 2 } },
    }
  })

  const peak = Math.max(...series.inBps, ...series.outBps)
  const gridHeight = growingGridHeight(
    height,
    scale,
    GEOMETRY.top + GEOMETRY.axisBand,
    GEOMETRY.grid,
  )

  return {
    grid: {
      left: px(GEOMETRY.left),
      right: px(GEOMETRY.right),
      top: px(GEOMETRY.top),
      height: px(gridHeight),
      outerBoundsMode: 'none',
    },
    xAxis: timeAxis({
      gridIndex: 0,
      extent: timeExtent(series.t, series.bucketMs),
      tz,
      labelled: true,
    }),
    yAxis: valueAxis({
      gridIndex: 0,
      axis: niceAxis(peak, 4),
      format: (value) => formatBitsPerSecond(value, 0),
    }),
    ...sharedCrosshair({
      tz,
      content: (index) => tooltipContent(series, index, tz, hidden, colors),
    }),
    series: lines,
  }
}

export function summarizeBandwidth(series: BandwidthSeries): string {
  const last = series.t.length - 1
  return `Bandwidth, last ${series.t.length} minutes: in ${formatBitsPerSecond(series.inBps[last])} now, out ${formatBitsPerSecond(series.outBps[last])} now (sample data)`
}

export function describeBandwidth(series: BandwidthSeries, index: number, tz: Timezone): string {
  return [
    `${formatTime(series.t[index] ?? 0, tz, false)} ${timezoneLabel(tz)}`,
    `in ${formatBitsPerSecond(series.inBps[index])}`,
    `out ${formatBitsPerSecond(series.outBps[index])}`,
  ].join(', ')
}

/** The table twin: newest first, like every chart table. */
export function bandwidthTable(series: BandwidthSeries, tz: Timezone): ChartTableModel {
  return {
    caption: `Bandwidth in and out, last ${series.t.length} minutes (sample data), newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      { label: 'In', numeric: true },
      { label: 'Out', numeric: true },
    ],
    rows: series.t
      .map((time, index) => ({
        key: String(time),
        header: formatTime(time, tz, false),
        cells: [
          formatBitsPerSecond(series.inBps[index]),
          formatBitsPerSecond(series.outBps[index]),
        ],
      }))
      .reverse(),
  }
}

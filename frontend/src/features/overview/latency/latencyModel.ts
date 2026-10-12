import type { NetworkSeries, RangeKey } from '@/api/types'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { TooltipContent, TooltipRow } from '@/charts/tooltip'
import type { ChartColorName, ChartColors } from '@/charts/theme'
import {
  formatLatency,
  formatPercent,
  formatTime,
  timezoneLabel,
  EMPTY,
  type Timezone,
} from '@/lib/format'

/**
 * Everything the latency chart says in words and numbers, from one place: the
 * tooltip, the spoken cursor value, the figure summary and the table twin all
 * read the same samples, so they can never disagree with each other.
 */

export type LatencySeriesId = 'p95' | 'p50' | 'loss' | 'failed'

export interface LatencySeriesSpec {
  id: LatencySeriesId
  label: string
  /** The mark the series is drawn with: the legend and tooltip keys mirror it. */
  shape: 'line' | 'rect' | 'diamond'
  /** Token slot. Color is bound to the metric, never to its rank among visible series. */
  color: ChartColorName
}

export const LATENCY_SERIES: readonly LatencySeriesSpec[] = [
  { id: 'p95', label: 'p95', shape: 'line', color: 'primary' },
  { id: 'p50', label: 'p50', shape: 'line', color: 'seriesOther' },
  { id: 'loss', label: 'loss', shape: 'rect', color: 'series2' },
  { id: 'failed', label: 'failed probes', shape: 'diamond', color: 'critical' },
]

export const LATENCY_SERIES_IDS: readonly LatencySeriesId[] = LATENCY_SERIES.map(({ id }) => id)

export interface LatencySample {
  t: number
  p95: number | null
  p50: number | null
  loss: number | null
  failed: number
  probes: number
}

export function sampleAt(series: NetworkSeries, index: number): LatencySample {
  return {
    t: series.t[index] ?? 0,
    p95: series.p95[index] ?? null,
    p50: series.p50[index] ?? null,
    loss: series.lossMean[index] ?? null,
    failed: series.failedProbes[index] ?? 0,
    probes: series.probeCount[index] ?? 0,
  }
}

/** Index of the newest sample that has a value, or -1 when the metric has none. */
export function lastValueIndex(values: readonly (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i -= 1) if (values[i] != null) return i
  return -1
}

export function hasMeasurements(series: NetworkSeries): boolean {
  return series.t.length > 0 && series.probeCount.some((count) => count > 0)
}

const RANGE_WORDS: Record<RangeKey, string> = {
  '15m': 'last 15 minutes',
  '1h': 'last hour',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
}

/** HH:mm in the active timezone; a trailing Z marks UTC, as everywhere in the console. */
export function clockLabel(ms: number, tz: Timezone): string {
  return `${formatTime(ms, tz, false)}${tz === 'utc' ? 'Z' : ''}`
}

function spokenClock(ms: number, tz: Timezone): string {
  return `${formatTime(ms, tz, false)} ${timezoneLabel(tz)}`
}

const spokenPercent = (value: number) => `${value.toFixed(1)} percent`

/** "Network latency, last hour: p95 142 ms now, peak 212 ms at 13:41 UTC, loss 2.1 percent". */
export function summarizeLatency(series: NetworkSeries, range: RangeKey, tz: Timezone): string {
  const head = `Network latency, ${RANGE_WORDS[range]}`
  const nowAt = lastValueIndex(series.p95)
  if (nowAt < 0) return `${head}: no p95 measurements`

  let peakAt = nowAt
  series.p95.forEach((value, i) => {
    if (value != null && value > (series.p95[peakAt] ?? 0)) peakAt = i
  })
  const parts = [
    `p95 ${formatLatency(series.p95[nowAt])} now`,
    `peak ${formatLatency(series.p95[peakAt])} at ${spokenClock(series.t[peakAt] ?? 0, tz)}`,
  ]
  const lossAt = lastValueIndex(series.lossMean)
  if (lossAt >= 0) parts.push(`loss ${spokenPercent(series.lossMean[lossAt] ?? 0)}`)
  const failed = series.failedProbes.reduce((sum, count) => sum + count, 0)
  if (failed > 0) parts.push(`${failed} failed ${failed === 1 ? 'probe' : 'probes'}`)
  return `${head}: ${parts.join(', ')}`
}

const failedText = (sample: LatencySample) => `${sample.failed} of ${sample.probes}`

/** The sample as one spoken sentence: the aria-valuetext of the keyboard cursor. */
export function describeSample(series: NetworkSeries, index: number, tz: Timezone): string {
  const s = sampleAt(series, index)
  return [
    spokenClock(s.t, tz),
    `p95 ${s.p95 == null ? 'no data' : formatLatency(s.p95)}`,
    `p50 ${s.p50 == null ? 'no data' : formatLatency(s.p50)}`,
    `loss ${s.loss == null ? 'no data' : spokenPercent(s.loss)}`,
    `failed probes ${failedText(s)}`,
  ].join(', ')
}

/** One tooltip row per visible series at the hovered sample. */
export function tooltipContent(
  series: NetworkSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  const s = sampleAt(series, index)
  const values: Record<LatencySeriesId, string> = {
    p95: formatLatency(s.p95),
    p50: formatLatency(s.p50),
    loss: formatPercent(s.loss, 1),
    failed: failedText(s),
  }
  const rows: TooltipRow[] = LATENCY_SERIES.filter(({ id }) => !hidden.has(id)).map((spec) => ({
    key: spec.shape,
    color: colors[spec.color],
    value: values[spec.id],
    label: spec.label,
  }))
  return { title: clockLabel(s.t, tz), rows }
}

/** The table twin: the same samples, newest first because an operator reads "now" first. */
export function latencyTable(
  series: NetworkSeries,
  range: RangeKey,
  tz: Timezone,
): ChartTableModel {
  const rows = series.t
    .map((_, index) => {
      const s = sampleAt(series, index)
      return {
        key: String(s.t),
        header: formatTime(s.t, tz, false),
        cells: [
          formatLatency(s.p95),
          formatLatency(s.p50),
          s.loss == null ? EMPTY : formatPercent(s.loss, 1),
          failedText(s),
        ],
      }
    })
    .reverse()
  return {
    caption: `Network latency and loss, ${RANGE_WORDS[range]}, newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      { label: 'p95', numeric: true },
      { label: 'p50', numeric: true },
      { label: 'Loss', numeric: true },
      { label: 'Failed probes', numeric: true },
    ],
    rows,
  }
}

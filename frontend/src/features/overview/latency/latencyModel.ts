import type { NetworkSeries, RangeKey } from '@/api/types'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { TooltipContent, TooltipRow } from '@/charts/tooltip'
import type { ChartColorName, ChartColors } from '@/charts/theme'
import {
  formatClock,
  formatLatency,
  formatPercent,
  formatTime,
  timezoneLabel,
  type Timezone,
} from '@/lib/format'
import { RANGE_WORDS } from '@/lib/range'
import {
  LATENCY_WARN_MS,
  LOSS_WARN_PERCENT,
  latencyExceedsWarn,
  lossExceedsWarn,
} from '@/lib/thresholds'

/**
 * Everything the latency chart says in words and numbers, from one place: the
 * tooltip, the spoken cursor value, the figure summary, the table twin and the
 * marks on the plot all read the same samples and judge the same limits, so
 * they can never disagree with each other.
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

function spokenClock(ms: number, tz: Timezone): string {
  return `${formatTime(ms, tz, false)} ${timezoneLabel(tz)}`
}

const spokenPercent = (value: number) => `${value.toFixed(1)} percent`

/** How each limit is named wherever it is shown: on the plot and in the summary. */
export const LATENCY_WARN_LABEL = `warn ${LATENCY_WARN_MS} ms (UI default)`
export const LOSS_WARN_LABEL = `warn ${LOSS_WARN_PERCENT}% (UI default)`

const NO_DATA = 'no data'

const shown = (value: number | null, format: (value: number) => string) =>
  value == null ? NO_DATA : format(value)

/** Index of the highest value, the first one on a tie, or -1 when the metric has none. */
export function peakIndex(values: readonly (number | null)[]): number {
  let peak = -1
  values.forEach((value, index) => {
    if (value != null && (peak < 0 || value > (values[peak] ?? 0))) peak = index
  })
  return peak
}

/** A p95 sample over the latency warning limit, judged to whole milliseconds like it is shown. */
export const isSpike = (p95: number | null | undefined): boolean =>
  p95 != null && latencyExceedsWarn(p95)

/** A loss sample at or over the loss warning limit, judged to one decimal like it is shown. */
export const isLossOver = (loss: number | null | undefined): boolean =>
  loss != null && lossExceedsWarn(loss)

const indexesWhere = (
  values: readonly (number | null)[],
  test: (value: number | null) => boolean,
) => values.flatMap((value, index) => (test(value) ? [index] : []))

/** The samples whose p95 is over the limit: the ones the plot marks. */
export const spikeIndexes = (series: NetworkSeries): number[] => indexesWhere(series.p95, isSpike)

/** The samples whose loss is at or over the limit. */
export const lossOverIndexes = (series: NetworkSeries): number[] =>
  indexesWhere(series.lossMean, isLossOver)

/** The highest p95 sample when it is over the limit, else -1: the one spike the plot labels. */
export function worstSpikeIndex(series: NetworkSeries): number {
  const peak = peakIndex(series.p95)
  return isSpike(series.p95[peak]) ? peak : -1
}

/** "212 ms at 13:41Z": the label on the worst spike. */
export function worstSpikeText(series: NetworkSeries, index: number, tz: Timezone): string {
  return `${formatLatency(series.p95[index])} at ${formatClock(series.t[index] ?? 0, tz, false)}`
}

export type LimitedSeriesId = 'p95' | 'loss'

/**
 * How far a sample is past its warning limit, in words ("62 ms over warn"), or
 * null while it is within it. Judged as the value is shown, so it never says
 * "over" beside a value that reads as the limit. p50 is context and has no limit
 * of its own. `spoken` writes the unit out for speech.
 */
export function overWarn(id: LimitedSeriesId, value: number | null, spoken = false): string | null {
  if (value == null) return null
  if (id === 'p95') {
    if (!latencyExceedsWarn(value)) return null
    const over = Math.round(value) - LATENCY_WARN_MS
    return `${over >= 1000 ? formatLatency(over) : `${over} ms`} over warn`
  }
  if (!lossExceedsWarn(value)) return null
  const tenths = Math.round(value * 10) - LOSS_WARN_PERCENT * 10
  return tenths > 0
    ? `${(tenths / 10).toFixed(1)}${spoken ? ' percent' : '%'} over warn`
    : 'at warn'
}

const samplesPhrase = (count: number) => `${count} ${count === 1 ? 'sample' : 'samples'}`

/**
 * The loss and failed-probe facts of a series. They hold whether or not any latency was
 * measured: a probe that failed has no p95, and the plot still draws it.
 */
function lossAndFailures(series: NetworkSeries): string[] {
  const parts: string[] = []
  const lossAt = lastValueIndex(series.lossMean)
  if (lossAt >= 0) parts.push(`loss ${spokenPercent(series.lossMean[lossAt] ?? 0)}`)
  const lossOver = lossOverIndexes(series).length
  if (lossOver > 0) parts.push(`${samplesPhrase(lossOver)} at or over ${LOSS_WARN_LABEL}`)
  const failed = series.failedProbes.reduce((sum, count) => sum + count, 0)
  if (failed > 0) parts.push(`${failed} failed ${failed === 1 ? 'probe' : 'probes'}`)
  return parts
}

/**
 * "Network latency, last hour: p95 142 ms now, 2 samples over warn 150 ms (UI default),
 * worst 212 ms at 13:41 UTC, loss 2.1 percent": what the chart shows now, where it is
 * over its limits, and the one worst moment.
 */
export function summarizeLatency(series: NetworkSeries, range: RangeKey, tz: Timezone): string {
  const head = `Network latency, ${RANGE_WORDS[range]}`
  const nowAt = lastValueIndex(series.p95)
  if (nowAt < 0) return `${head}: ${['no p95 measurements', ...lossAndFailures(series)].join(', ')}`

  const peakAt = peakIndex(series.p95)
  const peak = `${formatLatency(series.p95[peakAt])} at ${spokenClock(series.t[peakAt] ?? 0, tz)}`
  const spikes = spikeIndexes(series).length
  const parts = [
    `p95 ${formatLatency(series.p95[nowAt])} now`,
    spikes > 0
      ? `${samplesPhrase(spikes)} over ${LATENCY_WARN_LABEL}, worst ${peak}`
      : `peak ${peak}, none over ${LATENCY_WARN_LABEL}`,
    ...lossAndFailures(series),
  ]
  return `${head}: ${parts.join(', ')}`
}

const failedText = (sample: LatencySample) => `${sample.failed} of ${sample.probes}`

const withFlag = (text: string, flag: string | null) => (flag ? `${text}, ${flag}` : text)

/** The sample as one spoken sentence: the aria-valuetext of the keyboard cursor. */
export function describeSample(series: NetworkSeries, index: number, tz: Timezone): string {
  const s = sampleAt(series, index)
  return [
    spokenClock(s.t, tz),
    withFlag(`p95 ${shown(s.p95, formatLatency)}`, overWarn('p95', s.p95)),
    `p50 ${shown(s.p50, formatLatency)}`,
    withFlag(`loss ${shown(s.loss, spokenPercent)}`, overWarn('loss', s.loss, true)),
    `failed probes ${failedText(s)}`,
  ].join(', ')
}

/** One tooltip row per visible series at the hovered sample; a value over its limit says so. */
export function tooltipContent(
  series: NetworkSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  const s = sampleAt(series, index)
  const values: Record<LatencySeriesId, string> = {
    p95: shown(s.p95, formatLatency),
    p50: shown(s.p50, formatLatency),
    loss: shown(s.loss, (value) => formatPercent(value, 1)),
    failed: failedText(s),
  }
  const flags: Partial<Record<LatencySeriesId, string | null>> = {
    p95: overWarn('p95', s.p95),
    loss: overWarn('loss', s.loss),
  }
  const rows: TooltipRow[] = LATENCY_SERIES.filter(({ id }) => !hidden.has(id)).map((spec) => {
    const flag = flags[spec.id]
    return {
      key: spec.shape,
      color: colors[spec.color],
      value: values[spec.id],
      label: spec.label,
      ...(flag ? { flag } : {}),
    }
  })
  return { title: formatClock(s.t, tz, false), rows }
}

/** What the Flags cell of the table twin says about a sample: every limit it is over, or "none". */
function flagsText(sample: LatencySample): string {
  const flags = [
    ['p95', overWarn('p95', sample.p95)],
    ['loss', overWarn('loss', sample.loss)],
  ].flatMap(([label, flag]) => (flag ? [`${label} ${flag}`] : []))
  return flags.length > 0 ? flags.join(', ') : 'none'
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
          shown(s.p95, formatLatency),
          shown(s.p50, formatLatency),
          shown(s.loss, (value) => formatPercent(value, 1)),
          failedText(s),
          flagsText(s),
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
      { label: 'Flags' },
    ],
    rows,
  }
}

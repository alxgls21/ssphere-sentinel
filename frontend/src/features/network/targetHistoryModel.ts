import type { RangeKey, TargetProtocol, TargetSeries } from '@/api/types'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { ChartColorName, ChartColors } from '@/charts/theme'
import type { TooltipContent } from '@/charts/tooltip'
import {
  EMPTY,
  formatLatency,
  formatPercent,
  formatTime,
  timezoneLabel,
  type Timezone,
} from '@/lib/format'
import { RANGE_WORDS } from '@/lib/range'
import { LOSS_LABEL } from '@/lib/targets'

/**
 * Everything the target history chart says in words and numbers, from one place: tooltip, spoken
 * cursor value, figure summary and table twin read the same buckets, so they cannot disagree.
 *
 * A gap is a bucket with nothing to average: no measurement, or none that succeeded. Failed
 * measurements are counted in their own series, never drawn as a latency or as 100% loss, and a
 * bucket with no measurement at all has no count either (not 0 failed).
 */

export type TargetHistoryId = 'latency' | 'latencyMax' | 'loss' | 'failed'

export interface TargetHistorySpec {
  id: TargetHistoryId
  label: string
  /** Token slot, bound to the metric and never to its rank among the visible series. */
  color: ChartColorName
  /** Which of the three stacked grids draws it. */
  grid: 0 | 1 | 2
}

/** The series of a target. The loss series is named for what the protocol measures. */
export const historySpecs = (protocol: TargetProtocol): readonly TargetHistorySpec[] => [
  { id: 'latency', label: 'Latency (mean)', color: 'primary', grid: 0 },
  { id: 'latencyMax', label: 'Latency (highest)', color: 'series2', grid: 0 },
  { id: 'loss', label: LOSS_LABEL[protocol], color: 'series3', grid: 1 },
  { id: 'failed', label: 'Failed measurements', color: 'critical', grid: 2 },
]

export const HISTORY_IDS: readonly TargetHistoryId[] = ['latency', 'latencyMax', 'loss', 'failed']

/** No measurement in the bucket is not "0 failed". */
const failedIn = (series: TargetSeries, index: number): number | null =>
  (series.measurements[index] ?? 0) > 0 ? (series.failed[index] ?? null) : null

/** The values of a series, `null` where a bucket has none. */
export function valuesOf(series: TargetSeries, id: TargetHistoryId): (number | null)[] {
  switch (id) {
    case 'latency':
      return series.latencyMs
    case 'latencyMax':
      return series.latencyMaxMs
    case 'loss':
      return series.lossPercent
    case 'failed':
      return series.failed.map((_, index) => failedIn(series, index))
  }
}

export const hasHistory = (series: TargetSeries): boolean =>
  series.measurements.some((count) => count > 0)

/** Index of the newest bucket that has a measurement, or -1. */
export function lastBucketIndex(series: TargetSeries): number {
  for (let i = series.measurements.length - 1; i >= 0; i -= 1) {
    if ((series.measurements[i] ?? 0) > 0) return i
  }
  return -1
}

const clock = (ms: number, tz: Timezone) => formatTime(ms, tz, false)

const latencySpoken = (value: number | null | undefined) =>
  value == null ? 'no successful measurement' : `${value.toFixed(1)} milliseconds`

const percentSpoken = (value: number | null | undefined) =>
  value == null ? 'no value' : `${value.toFixed(1)} percent`

export function summarizeHistory(
  name: string,
  protocol: TargetProtocol,
  series: TargetSeries,
  range: RangeKey,
): string {
  const head = `Latency and ${LOSS_LABEL[protocol].toLowerCase()} history of ${name}, ${RANGE_WORDS[range]}`
  if (!hasHistory(series)) return `${head}: no measurements`
  const total = series.measurements.reduce((sum, count) => sum + count, 0)
  const failed = series.failed.reduce((sum, count) => sum + count, 0)
  return `${head}: ${total} measurements, ${failed} failed. A gap is a bucket with no successful measurement; failed measurements are counted apart`
}

export function describeSample(
  protocol: TargetProtocol,
  series: TargetSeries,
  index: number,
  tz: Timezone,
): string {
  const measured = series.measurements[index] ?? 0
  const parts =
    measured === 0
      ? ['no measurements']
      : [
          `latency mean ${latencySpoken(series.latencyMs[index])}`,
          `highest ${latencySpoken(series.latencyMaxMs[index])}`,
          `${LOSS_LABEL[protocol].toLowerCase()} ${percentSpoken(series.lossPercent[index])}`,
          `${series.failed[index] ?? 0} of ${measured} measurements failed`,
        ]
  return [`${clock(series.t[index] ?? 0, tz)} ${timezoneLabel(tz)}`, ...parts].join(', ')
}

function valueText(series: TargetSeries, id: TargetHistoryId, index: number): string {
  const value = id === 'failed' ? failedIn(series, index) : valuesOf(series, id)[index]
  if (value == null) return id === 'failed' ? 'no measurements' : EMPTY
  if (id === 'failed') return `${value} of ${series.measurements[index] ?? 0}`
  return id === 'loss' ? formatPercent(value, 1) : formatLatency(value)
}

export function tooltipContent(
  protocol: TargetProtocol,
  series: TargetSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  return {
    title: clock(series.t[index] ?? 0, tz),
    rows: historySpecs(protocol)
      .filter(({ id }) => !hidden.has(id))
      .map((spec) => ({
        key: spec.id === 'failed' ? ('rect' as const) : ('line' as const),
        color: colors[spec.color],
        value: valueText(series, spec.id, index),
        label: spec.label,
      })),
  }
}

/** The table twin, newest first. */
export function historyTable(
  name: string,
  protocol: TargetProtocol,
  series: TargetSeries,
  range: RangeKey,
  tz: Timezone,
): ChartTableModel {
  const specs = historySpecs(protocol)
  return {
    caption: `History of ${name}, ${RANGE_WORDS[range]}, newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      ...specs.map(({ label }) => ({ label, numeric: true })),
      { label: 'Measurements', numeric: true },
    ],
    rows: series.t
      .map((time, index) => ({
        key: String(time),
        header: clock(time, tz),
        cells: [
          ...specs.map(({ id }) => valueText(series, id, index)),
          String(series.measurements[index] ?? 0),
        ],
      }))
      .reverse(),
  }
}

import type { RangeKey, ServerSeries } from '@/api/types'
import type { ChartTableModel } from '@/charts/ChartTable'
import type { ChartColorName, ChartColors } from '@/charts/theme'
import type { TooltipContent } from '@/charts/tooltip'
import { EMPTY, formatPercent, formatTime, timezoneLabel, type Timezone } from '@/lib/format'

/**
 * Everything the resource-history chart says in words and numbers, from one
 * place: tooltip, spoken cursor value, figure summary and table twin read the
 * same samples, so they cannot disagree.
 */

export type HistoryMetric = 'cpu' | 'memory' | 'disk'

interface HistorySpec {
  id: HistoryMetric
  label: string
  /** Token slot, bound to the metric and never to its rank among the visible series. */
  color: ChartColorName
}

export const HISTORY_SERIES: readonly HistorySpec[] = [
  { id: 'cpu', label: 'CPU', color: 'primary' },
  { id: 'memory', label: 'RAM', color: 'series2' },
  { id: 'disk', label: 'Disk', color: 'series3' },
]

export const HISTORY_IDS: readonly HistoryMetric[] = HISTORY_SERIES.map(({ id }) => id)

const RANGE_WORDS: Record<RangeKey, string> = {
  '15m': 'last 15 minutes',
  '1h': 'last hour',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
}

export const valuesOf = (series: ServerSeries, id: HistoryMetric) => series[id]

/** Index of the newest sample that has a value, or -1. */
export function lastSampleIndex(series: ServerSeries): number {
  for (let i = series.t.length - 1; i >= 0; i -= 1) {
    if (HISTORY_IDS.some((id) => valuesOf(series, id)[i] != null)) return i
  }
  return -1
}

export const hasHistory = (series: ServerSeries): boolean => lastSampleIndex(series) >= 0

const clock = (ms: number, tz: Timezone) => formatTime(ms, tz, false)
const spoken = (value: number | null | undefined) =>
  value == null ? 'no data' : `${value.toFixed(1)} percent`

export function summarizeHistory(
  name: string,
  series: ServerSeries,
  range: RangeKey,
  tz: Timezone,
): string {
  const head = `Resource history of ${name}, ${RANGE_WORDS[range]}`
  const last = lastSampleIndex(series)
  if (last < 0) return `${head}: no samples`
  const stale = last < series.t.length - 1
  const parts = HISTORY_SERIES.map(
    ({ id, label }) => `${label} ${spoken(valuesOf(series, id)[last])}`,
  )
  return `${head}: ${parts.join(', ')}${stale ? ` at ${clock(series.t[last] ?? 0, tz)} ${timezoneLabel(tz)}, the last sample before it stopped reporting` : ' now'}`
}

export function describeSample(series: ServerSeries, index: number, tz: Timezone): string {
  return [
    `${clock(series.t[index] ?? 0, tz)} ${timezoneLabel(tz)}`,
    ...HISTORY_SERIES.map(({ id, label }) => `${label} ${spoken(valuesOf(series, id)[index])}`),
  ].join(', ')
}

export function tooltipContent(
  series: ServerSeries,
  index: number,
  tz: Timezone,
  hidden: ReadonlySet<string>,
  colors: ChartColors,
): TooltipContent {
  return {
    title: clock(series.t[index] ?? 0, tz),
    rows: HISTORY_SERIES.filter(({ id }) => !hidden.has(id)).map((spec) => ({
      key: 'line',
      color: colors[spec.color],
      value: formatPercent(valuesOf(series, spec.id)[index], 1),
      label: spec.label,
    })),
  }
}

/** The table twin, newest first. */
export function historyTable(
  name: string,
  series: ServerSeries,
  range: RangeKey,
  tz: Timezone,
): ChartTableModel {
  return {
    caption: `Resource history of ${name}, ${RANGE_WORDS[range]}, newest first`,
    columns: [
      { label: `Time (${timezoneLabel(tz)})` },
      ...HISTORY_SERIES.map(({ label }) => ({ label, numeric: true })),
    ],
    rows: series.t
      .map((time, index) => ({
        key: String(time),
        header: clock(time, tz),
        cells: HISTORY_SERIES.map(({ id }) => {
          const value = valuesOf(series, id)[index]
          return value == null ? EMPTY : formatPercent(value, 1)
        }),
      }))
      .reverse(),
  }
}

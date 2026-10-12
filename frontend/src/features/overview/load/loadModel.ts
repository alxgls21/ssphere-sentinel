import type { FleetLoadRow, LoadMetric } from '@/api/types'
import { BLOCK_CELLS } from '@/lib/blocks'
import { formatPercent, formatTime, type Timezone } from '@/lib/format'
import { RESOURCE_CRIT_PERCENT, RESOURCE_WARN_PERCENT } from '@/lib/thresholds'

/** Servers listed: the busiest few, because the point is where to look first. */
export const LOAD_ROWS = 8

interface MetricInfo {
  /** The tab. */
  label: string
  /** How the metric reads inside a sentence ("CPU of api-02"). */
  noun: string
  /** Supplementary tooltip of the tab: the label already makes sense alone. */
  title: string
}

const METRICS: Record<LoadMetric, MetricInfo> = {
  cpu: { label: 'CPU', noun: 'CPU', title: 'CPU utilisation' },
  memory: { label: 'RAM', noun: 'RAM', title: 'Memory in use' },
  disk: { label: 'DISK', noun: 'Disk', title: 'Disk space in use' },
}

/** The tabs, left to right. */
export const LOAD_TABS: readonly { value: LoadMetric; label: string; title: string }[] = (
  ['cpu', 'memory', 'disk'] as const
).map((value) => ({ value, label: METRICS[value].label, title: METRICS[value].title }))

export const metricNoun = (metric: LoadMetric): string => METRICS[metric].noun

/** The thresholds are presentational defaults, not backend rules: the footer says so. */
export const THRESHOLD_NOTE = `cell = ${100 / BLOCK_CELLS}% · warn at ${RESOURCE_WARN_PERCENT} · crit at ${RESOURCE_CRIT_PERCENT} · UI defaults`

const NAMED_EXCLUDED = 3

/**
 * Servers with no usable sample are left out of the ranking, never drawn as an
 * empty meter, so the footer names them. The API does not say why a server has
 * no sample (offline, never reported), so neither does this.
 */
export function excludedNote(names: readonly string[]): string | null {
  if (names.length === 0) return null
  const listed = names.slice(0, NAMED_EXCLUDED).join(', ')
  const more = names.length > NAMED_EXCLUDED ? `, +${names.length - NAMED_EXCLUDED} more` : ''
  return `${listed}${more}: no sample, excluded`
}

const clock = (ms: number, tz: Timezone) => `${formatTime(ms, tz)}${tz === 'utc' ? 'Z' : ''}`

/** Same precision rule as the printed value in the meter: whole numbers from 10%, one decimal below. */
export const percentText = (percent: number) => formatPercent(percent, percent < 10 ? 1 : 0)

/** Server, metric, value and when the sample was taken: the part of a row that does not fit in it. */
export function rowTooltip(row: FleetLoadRow, noun: string, tz: Timezone): string {
  return `${row.name} · ${noun} ${percentText(row.percent)} · sampled ${clock(Date.parse(row.collectedAt), tz)}`
}

import type { IncidentItem } from '@/api/types'
import { formatTime, type Timezone } from '@/lib/format'
import type { LineSeriesOption } from './echarts'
import type { ChartColors } from './theme'

/**
 * Incidents drawn on a time-series chart: each is a shaded span from when its condition began to when
 * it recovered or was closed (an open one runs to now), in its severity's color, with a line at the
 * start. Only the incidents of the object the chart is about, and only the part inside the range.
 * Pure: incidents in, spans and an option fragment out.
 */

export interface IncidentSpan {
  id: string
  severity: IncidentItem['severity']
  /** Epoch ms, clipped to the plotted range. */
  start: number
  end: number
  /** Still open at the end of the range. */
  open: boolean
  rule: string
}

const time = (iso: string | null): number | null => {
  if (iso === null) return null
  const value = Date.parse(iso)
  return Number.isNaN(value) ? null : value
}

/** The spans of `items` for the object `ref` that overlap `[min, max]`, oldest first. */
export function incidentSpans(
  items: readonly IncidentItem[],
  ref: string,
  min: number,
  max: number,
  nowMs: number,
): IncidentSpan[] {
  const spans: IncidentSpan[] = []
  for (const item of items) {
    if (item.entity.ref !== ref) continue
    const began = time(item.startedAt)
    if (began === null) continue
    const ended = time(item.recoveredAt) ?? time(item.closedAt)
    const open = ended === null
    const end = ended ?? nowMs
    if (end < min || began > max) continue
    spans.push({
      id: item.id,
      severity: item.severity,
      start: Math.max(began, min),
      end: Math.min(Math.max(end, began), max),
      open,
      rule: item.rule.name,
    })
  }
  return spans.sort((a, b) => a.start - b.start)
}

interface AreaInput {
  spans: readonly IncidentSpan[]
  colors: ChartColors
  fontFamily: string
  /** px at the current root font size. */
  px: (value: number) => number
  /** Only one grid of a stack names the incidents; the others only shade. */
  labelled: boolean
}

/**
 * A series with no points whose only job is to carry the spans, so they stay when a line is hidden
 * from the legend. Silent: no tooltip of its own, the table and the summary say the same in words.
 */
export function incidentSeries(id: string, grid: number, input: AreaInput): LineSeriesOption {
  const { spans, colors, fontFamily, px, labelled } = input
  return {
    id,
    name: id,
    type: 'line',
    xAxisIndex: grid,
    yAxisIndex: grid,
    silent: true,
    data: [],
    markArea: {
      silent: true,
      animation: false,
      data: spans.map((span) => {
        const color = span.severity === 'critical' ? colors.critical : colors.warning
        return [
          {
            xAxis: span.start,
            name: labelled ? `INC ${span.severity === 'critical' ? 'CRIT' : 'WARN'}` : '',
            itemStyle: { color, opacity: 0.14, borderColor: color, borderWidth: 1 },
            label: {
              show: labelled,
              position: 'insideTopLeft',
              color,
              fontFamily,
              fontSize: px(10),
            },
          },
          { xAxis: span.end },
        ]
      }),
    },
  }
}

/** One sentence for the chart's summary and a screen reader. Empty when there is none. */
export function incidentSentence(spans: readonly IncidentSpan[], tz: Timezone): string {
  if (spans.length === 0) return ''
  const label = tz === 'utc' ? 'UTC' : 'local'
  const each = spans.map(
    (span) =>
      `${span.severity} “${span.rule}” from ${formatTime(span.start, tz, false)} ${label}${span.open ? ', still open' : ''}`,
  )
  return `${spans.length === 1 ? '1 incident' : `${spans.length} incidents`} marked: ${each.join('; ')}`
}

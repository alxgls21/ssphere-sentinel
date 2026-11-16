import { useCallback, useMemo } from 'react'
import type { IncidentItem, RangeKey, TargetProtocol, TargetSeries } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import type { LegendEntry } from '@/charts/ChartLegend'
import { incidentSentence, incidentSpans } from '@/charts/incidentSpans'
import { cssColor } from '@/charts/theme'
import type { ChartEnv } from '@/charts/useECharts'
import { useSeriesVisibility } from '@/charts/useSeriesVisibility'
import type { TargetLimits } from '@/lib/targets'
import {
  HISTORY_IDS,
  describeSample,
  historySpecs,
  historyTable,
  summarizeHistory,
} from './targetHistoryModel'
import { TARGET_CHART_HEIGHT_PX, buildTargetOption, targetCursorPoint } from './targetHistoryOption'

interface TargetHistoryChartProps {
  name: string
  protocol: TargetProtocol
  series: TargetSeries
  range: RangeKey
  limits: TargetLimits
  /** The target's id and its incidents: shown on the chart where they overlap the range. */
  targetId: string
  incidents: readonly IncidentItem[]
  incidentsAtMs: number
}

/**
 * Chart internals of the target history panel. The React.lazy chunk: the only path that pulls the
 * chart runtime, so the shell and the rest of the page paint first. All behavior (legend,
 * crosshair, keyboard cursor, table twin) comes from ChartFrame.
 */
export default function TargetHistoryChart({
  name,
  protocol,
  series,
  range,
  limits,
  targetId,
  incidents,
  incidentsAtMs,
}: TargetHistoryChartProps) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(HISTORY_IDS)
  const { hidden } = visibility
  const spans = useMemo(() => {
    const first = series.t[0]
    const last = series.t[series.t.length - 1]
    if (first === undefined || last === undefined) return []
    return incidentSpans(
      incidents,
      targetId,
      first - series.bucketMs / 2,
      last + series.bucketMs / 2,
      incidentsAtMs || last,
    )
  }, [incidents, targetId, series, incidentsAtMs])

  const legend = useMemo<readonly LegendEntry[]>(
    () =>
      historySpecs(protocol).map(({ id, label, color }) => ({
        id,
        label,
        shape: id === 'failed' ? 'rect' : 'line',
        color: cssColor(color),
      })),
    [protocol],
  )
  const build = useCallback(
    ({ tokens, height }: ChartEnv) =>
      buildTargetOption({
        protocol,
        series,
        tz,
        hidden,
        tokens,
        height,
        limits,
        incidents: spans,
      }),
    [protocol, series, tz, hidden, limits, spans],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: series.t.length,
      pointAt: (chart, index) => targetCursorPoint(chart, series.t[index] ?? 0),
      describe: (index) => describeSample(protocol, series, index, tz),
    }),
    [protocol, series, tz],
  )
  const table = useMemo(
    () => historyTable(name, protocol, series, range, tz),
    [name, protocol, series, range, tz],
  )

  return (
    <ChartFrame
      summary={summarizeHistory(name, protocol, series, range, incidentSentence(spans, tz))}
      cursorLabel="Target history cursor"
      build={build}
      legend={legend}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={TARGET_CHART_HEIGHT_PX}
    />
  )
}

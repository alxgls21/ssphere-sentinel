import { useCallback, useMemo } from 'react'
import type { RangeKey, ServerSeries } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import type { LegendEntry } from '@/charts/ChartLegend'
import { cssColor } from '@/charts/theme'
import type { ChartEnv } from '@/charts/useECharts'
import { useSeriesVisibility } from '@/charts/useSeriesVisibility'
import { useResourceLimits } from '@/ui/meters'
import {
  HISTORY_IDS,
  HISTORY_SERIES,
  describeSample,
  historyTable,
  summarizeHistory,
} from './historyModel'
import { HISTORY_CHART_HEIGHT_PX, buildHistoryOption, historyCursorPoint } from './historyOption'

const LEGEND: readonly LegendEntry[] = HISTORY_SERIES.map(({ id, label, color }) => ({
  id,
  label,
  shape: 'line',
  color: cssColor(color),
}))

interface ServerHistoryChartProps {
  name: string
  series: ServerSeries
  range: RangeKey
}

/**
 * Chart internals of the resource-history panel. The React.lazy chunk: the only
 * path that pulls the chart runtime, so the shell and the rest of the page paint first.
 * All behavior (legend, crosshair, keyboard cursor, table twin) comes from ChartFrame.
 */
export default function ServerHistoryChart({ name, series, range }: ServerHistoryChartProps) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(HISTORY_IDS)
  const { hidden } = visibility
  const { warn, origin } = useResourceLimits()

  const build = useCallback(
    ({ tokens, height }: ChartEnv) =>
      buildHistoryOption({ series, tz, hidden, tokens, height, limit: { warn, origin } }),
    [series, tz, hidden, warn, origin],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: series.t.length,
      pointAt: (chart, index) => historyCursorPoint(chart, series.t[index] ?? 0),
      describe: (index) => describeSample(series, index, tz),
    }),
    [series, tz],
  )
  const table = useMemo(() => historyTable(name, series, range, tz), [name, series, range, tz])

  return (
    <ChartFrame
      summary={summarizeHistory(name, series, range, tz)}
      cursorLabel="Resource history cursor"
      build={build}
      legend={LEGEND}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={HISTORY_CHART_HEIGHT_PX}
    />
  )
}

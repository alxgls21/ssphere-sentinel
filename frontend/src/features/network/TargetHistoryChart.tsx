import { useCallback, useMemo } from 'react'
import type { RangeKey, TargetProtocol, TargetSeries } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import type { LegendEntry } from '@/charts/ChartLegend'
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
}: TargetHistoryChartProps) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(HISTORY_IDS)
  const { hidden } = visibility

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
      buildTargetOption({ protocol, series, tz, hidden, tokens, height, limits }),
    [protocol, series, tz, hidden, limits],
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
      summary={summarizeHistory(name, protocol, series, range)}
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

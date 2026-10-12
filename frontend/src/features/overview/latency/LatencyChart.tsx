import { useCallback, useMemo } from 'react'
import type { NetworkSeries, RangeKey } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import type { LegendEntry } from '@/charts/ChartLegend'
import { cssColor } from '@/charts/theme'
import type { ChartEnv } from '@/charts/useECharts'
import { useSeriesVisibility } from '@/charts/useSeriesVisibility'
import {
  LATENCY_SERIES,
  LATENCY_SERIES_IDS,
  describeSample,
  latencyTable,
  summarizeLatency,
} from './latencyModel'
import { LATENCY_CHART_HEIGHT_PX } from './latencyGeometry'
import { buildLatencyOption, latencyCursorPoint } from './latencyOption'

/** Series keys follow the metric, never its rank, so toggling one never repaints another. */
const LEGEND: readonly LegendEntry[] = [
  ...LATENCY_SERIES.map(({ id, label, shape, color }) => ({
    id,
    label,
    shape,
    color: cssColor(color),
  })),
]

interface LatencyChartProps {
  series: NetworkSeries
  range: RangeKey
}

/**
 * Chart internals of the Network latency panel. This module is the React.lazy
 * chunk: it is the only path that pulls the chart runtime, so the shell and
 * the other panels paint before any chart code loads.
 */
export default function LatencyChart({ series, range }: LatencyChartProps) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(LATENCY_SERIES_IDS)
  const { hidden } = visibility

  const build = useCallback(
    ({ tokens, compact, height }: ChartEnv) =>
      buildLatencyOption({ series, tz, hidden, tokens, compact, height }),
    [series, tz, hidden],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: series.t.length,
      pointAt: (chart, index) => latencyCursorPoint(chart, series.t[index] ?? 0),
      describe: (index) => describeSample(series, index, tz),
    }),
    [series, tz],
  )
  const table = useMemo(() => latencyTable(series, range, tz), [series, range, tz])

  return (
    <ChartFrame
      summary={summarizeLatency(series, range, tz)}
      cursorLabel="Latency and loss cursor"
      build={build}
      legend={LEGEND}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={LATENCY_CHART_HEIGHT_PX}
    />
  )
}

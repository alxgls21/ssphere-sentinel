import { useCallback, useMemo } from 'react'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import { timeCursorX } from '@/charts/timeSeries'
import type { ChartEnv } from '@/charts/useECharts'
import { useSeriesVisibility } from '@/charts/useSeriesVisibility'
import {
  BANDWIDTH_CHART_HEIGHT_PX,
  BANDWIDTH_LEGEND,
  BANDWIDTH_SERIES_IDS,
  SAMPLE_BANDWIDTH,
  bandwidthTable,
  buildBandwidthOption,
  describeBandwidth,
  summarizeBandwidth,
} from './bandwidth'

const SERIES = SAMPLE_BANDWIDTH

/**
 * The gallery's second chart: the same ChartFrame as the latency chart, a
 * different option. Also a React.lazy chunk, like every chart.
 */
export default function BandwidthChart() {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(BANDWIDTH_SERIES_IDS)
  const { hidden } = visibility

  const build = useCallback(
    ({ tokens, height }: ChartEnv) =>
      buildBandwidthOption({ series: SERIES, tz, hidden, tokens, height }),
    [tz, hidden],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: SERIES.t.length,
      // The crosshair sits at the vertical middle of the plot; the tooltip is axis-triggered.
      pointAt: (chart, index) => {
        const x = timeCursorX(chart, SERIES.t[index] ?? 0)
        return x === null ? null : [x, chart.getHeight() / 2]
      },
      describe: (index) => describeBandwidth(SERIES, index, tz),
    }),
    [tz],
  )
  const table = useMemo(() => bandwidthTable(SERIES, tz), [tz])

  return (
    <ChartFrame
      summary={summarizeBandwidth(SERIES)}
      cursorLabel="Bandwidth cursor"
      build={build}
      legend={BANDWIDTH_LEGEND}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={BANDWIDTH_CHART_HEIGHT_PX}
    />
  )
}

import { useCallback, useMemo } from 'react'
import type { DeviceSeries, InterfaceSeries, RangeKey } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ChartFrame, type ChartNavigation } from '@/charts/ChartFrame'
import type { LegendEntry } from '@/charts/ChartLegend'
import { cssColor } from '@/charts/theme'
import type { ChartEnv } from '@/charts/useECharts'
import { useSeriesVisibility } from '@/charts/useSeriesVisibility'
import {
  DEVICE_HISTORY_IDS,
  DEVICE_SPECS,
  INTERFACE_HISTORY_IDS,
  INTERFACE_SPECS,
  describeDeviceBucket,
  describeInterfaceBucket,
  deviceTable,
  interfaceTable,
  summarizeDevice,
  summarizeInterface,
  type HistorySpec,
} from './historyModel'
import {
  SNMP_CHART_HEIGHT_PX,
  buildDeviceOption,
  buildInterfaceOption,
  snmpCursorPoint,
} from './historyOption'

const legendOf = (specs: readonly HistorySpec<string>[]): readonly LegendEntry[] =>
  specs.map(({ id, label, color, bar }) => ({
    id,
    label,
    shape: bar ? 'rect' : 'line',
    color: cssColor(color),
  }))

const DEVICE_LEGEND = legendOf(DEVICE_SPECS)
const INTERFACE_LEGEND = legendOf(INTERFACE_SPECS)

/**
 * Chart internals of the SNMP history panels. The React.lazy chunk: the only path that pulls the
 * chart runtime, so the shell and the rest of the page paint first. All behavior (legend, crosshair,
 * keyboard cursor, table twin) comes from ChartFrame.
 */
export function DeviceHistoryChart({
  name,
  series,
  range,
}: {
  name: string
  series: DeviceSeries
  range: RangeKey
}) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(DEVICE_HISTORY_IDS)
  const { hidden } = visibility
  const build = useCallback(
    ({ tokens, height }: ChartEnv) => buildDeviceOption({ series, tz, hidden, tokens, height }),
    [series, tz, hidden],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: series.t.length,
      pointAt: (chart, index) => snmpCursorPoint(chart, series.t[index] ?? 0),
      describe: (index) => describeDeviceBucket(series, index, tz),
    }),
    [series, tz],
  )
  const table = useMemo(() => deviceTable(name, series, range, tz), [name, series, range, tz])
  return (
    <ChartFrame
      summary={summarizeDevice(name, series, range)}
      cursorLabel="Device history cursor"
      build={build}
      legend={DEVICE_LEGEND}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={SNMP_CHART_HEIGHT_PX}
    />
  )
}

export function InterfaceHistoryChart({
  name,
  series,
  range,
}: {
  name: string
  series: InterfaceSeries
  range: RangeKey
}) {
  const { tz } = usePrefs()
  const visibility = useSeriesVisibility(INTERFACE_HISTORY_IDS)
  const { hidden } = visibility
  const build = useCallback(
    ({ tokens, height }: ChartEnv) => buildInterfaceOption({ series, tz, hidden, tokens, height }),
    [series, tz, hidden],
  )
  const navigation = useMemo<ChartNavigation>(
    () => ({
      count: series.t.length,
      pointAt: (chart, index) => snmpCursorPoint(chart, series.t[index] ?? 0),
      describe: (index) => describeInterfaceBucket(series, index, tz),
    }),
    [series, tz],
  )
  const table = useMemo(() => interfaceTable(name, series, range, tz), [name, series, range, tz])
  return (
    <ChartFrame
      summary={summarizeInterface(name, series, range)}
      cursorLabel="Interface history cursor"
      build={build}
      legend={INTERFACE_LEGEND}
      visibility={visibility}
      table={table}
      navigation={navigation}
      heightPx={SNMP_CHART_HEIGHT_PX}
    />
  )
}

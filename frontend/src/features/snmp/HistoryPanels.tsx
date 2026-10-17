import { lazy, Suspense } from 'react'
import { useApi } from '@/api/context'
import type { DeviceInterface, DeviceSeries } from '@/api/types'
import { useLive } from '@/app/live'
import { useRange } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { Resource } from '@/hooks/useResource'
import { interfaceTitle } from '@/lib/devices'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { hasDeviceHistory, hasInterfaceHistory, hasInterfaceValues } from './historyModel'

// The chart runtime is its own chunk: the page paints before any chart code arrives.
const DeviceHistoryChart = lazy(() =>
  import('./HistoryCharts').then((module) => ({ default: module.DeviceHistoryChart })),
)
const InterfaceHistoryChart = lazy(() =>
  import('./HistoryCharts').then((module) => ({ default: module.InterfaceHistoryChart })),
)

/** Legend row plus the minimum plot: what the body keeps while the chart loads. */
const BODY_MIN = 'min-h-[15.5rem]'

interface DeviceHistoryPanelProps {
  /** The series over the range in the top bar. */
  resource: Resource<DeviceSeries>
  name: string
  className?: string
}

/**
 * [2] Response time, reachable polls and failed polls of one device over the range in the top bar,
 * one of the ranges the console API serves. A bucket with nothing to average is a gap; failed polls
 * are counted apart and nothing is filled in.
 */
export function DeviceHistoryPanel({ resource, name, className }: DeviceHistoryPanelProps) {
  const { pollMs } = useLive()
  const [range] = useRange()
  const series = resource.data
  return (
    <Panel
      index={2}
      title="Poll history"
      features="snmp"
      scope={range}
      className={className}
      refreshMs={pollMs}
      status={resource.status}
      refreshing={resource.isRefreshing && series !== undefined}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      isEmpty={series !== undefined && !hasDeviceHistory(series)}
      empty={
        <EmptyState title="No history" hint="This device has not been polled in this range." />
      }
      skeleton={<Skeleton className={`${BODY_MIN} w-full`} />}
      footer={
        <span className="truncate @max-sm:py-1 @max-sm:whitespace-normal">
          Response time of the polls that reached the device · failed polls counted apart · gaps are
          not filled in
        </span>
      }
      bodyClassName="flex flex-col px-3 py-2"
    >
      {series ? (
        <Suspense fallback={<Skeleton className={`${BODY_MIN} w-full flex-1`} />}>
          <DeviceHistoryChart name={name} series={series} range={range} />
        </Suspense>
      ) : null}
    </Panel>
  )
}

interface InterfaceHistoryPanelProps {
  deviceId: string
  iface: DeviceInterface
  className?: string
}

/**
 * [5] Traffic, errors and discards of one interface over the range in the top bar. The rates are
 * the console API's means over the usable samples of each bucket: a sample that gave no rate is
 * counted apart and never drawn, and never as zero traffic. Mounted only for an interface the
 * device lists, keyed by it, so a series kept on screen while a range loads is never another's.
 */
export function InterfaceHistoryPanel({ deviceId, iface, className }: InterfaceHistoryPanelProps) {
  const api = useApi()
  const { pollMs } = useLive()
  const [range] = useRange()
  const resource = useLiveResource(
    `interface-history:${deviceId}:${iface.ifIndex}`,
    `interface-series:${deviceId}:${iface.ifIndex}:${range}`,
    (signal) => api.getInterfaceSeries({ deviceId, ifIndex: iface.ifIndex, range, signal }),
    // Changing the range keeps the chart on screen, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const series = resource.data
  const unusable = series ? series.invalidSamples.reduce((sum, count) => sum + count, 0) : 0
  const nothingUsable =
    series !== undefined && hasInterfaceHistory(series) && !hasInterfaceValues(series)
  return (
    <Panel
      index={5}
      title="Interface history"
      features="snmp"
      scope={range}
      className={className}
      refreshMs={pollMs}
      status={resource.status}
      refreshing={resource.isRefreshing && series !== undefined}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      isEmpty={series !== undefined && !hasInterfaceHistory(series)}
      empty={
        <EmptyState
          title="No history"
          hint={`${interfaceTitle(iface)} has not been sampled in this range.`}
        />
      }
      skeleton={<Skeleton className={`${BODY_MIN} w-full`} />}
      footer={
        <span className="truncate @max-sm:py-1 @max-sm:whitespace-normal">
          {interfaceTitle(iface)} · means and highest of the usable samples ·{' '}
          {unusable > 0
            ? `${unusable} samples without a rate are not drawn, and never as zero traffic`
            : 'a sample without a rate would be counted apart, never drawn as zero'}
        </span>
      }
      bodyClassName="flex flex-col px-3 py-2"
    >
      {series ? (
        <>
          {nothingUsable ? (
            <p className="type-body mb-2 text-fg-muted">
              No sample in this range gave a rate, so no line is drawn: the counters could not be
              compared, or the rate was not believed.
            </p>
          ) : null}
          <Suspense fallback={<Skeleton className={`${BODY_MIN} w-full flex-1`} />}>
            <InterfaceHistoryChart name={interfaceTitle(iface)} series={series} range={range} />
          </Suspense>
        </>
      ) : null}
    </Panel>
  )
}

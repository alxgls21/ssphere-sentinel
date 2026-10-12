import { lazy, Suspense } from 'react'
import { Link } from 'react-router'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { scopeKey, useRange, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { formatInteger } from '@/lib/format'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { ChartSkeleton } from './ChartSkeleton'
import { hasMeasurements } from './latencyModel'
import { useViewTo } from '@/app/viewSearch'

// The chart runtime loads in its own chunk, after the shell and the other panels have painted.
const LatencyChart = lazy(() => import('./LatencyChart'))

const targetsPhrase = (count: number) =>
  `${formatInteger(count)} ${count === 1 ? 'target' : 'targets'}`

interface NetworkLatencyPanelProps {
  /** Layout classes from the Overview grid (placement and row span). */
  className?: string
}

/**
 * [2] Network latency and loss: p95 and p50 latency over packet-loss columns
 * on one time axis. Follows the topbar range and scope. Mock data until the
 * backend has a read API (percentiles are aggregated client-side).
 */
export function NetworkLatencyPanel({ className }: NetworkLatencyPanelProps) {
  const viewTo = useViewTo()
  const api = useApi()
  const { pollMs } = useLive()
  const [range] = useRange()
  const [scope] = useScope()

  const { status, data, error, isRefreshing, updatedAt, refetch } = useLiveResource(
    'network',
    `network-series:${scopeKey(scope)}:${range}`,
    // The range travels with the data: while a new range loads, the kept render must still say which range it shows.
    async (signal) => ({ range, series: await api.getNetworkSeries({ range, scope, signal }) }),
    // A range or scope change keeps the previous render, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )

  const series = data?.series
  const measured = series ? hasMeasurements(series) : true

  return (
    <Panel
      index={2}
      title="Network latency"
      features="network"
      scope={range}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={updatedAt}
      onRetry={refetch}
      isEmpty={!measured}
      skeleton={<ChartSkeleton />}
      empty={
        <div className="relative">
          <ChartSkeleton line={false} />
          <div className="absolute inset-0">
            <EmptyState
              title="No measurements in this range"
              hint={
                <>
                  {targetsPhrase(series?.targetCount ?? 0)} enabled.{' '}
                  <Link
                    to={viewTo('/network')}
                    className="text-primary underline underline-offset-2 hover:text-primary-hover"
                  >
                    Open Network
                  </Link>
                </>
              }
            />
          </div>
        </div>
      }
      footer={
        <span className="truncate">
          p95 and p50 across {series ? targetsPhrase(series.targetCount) : 'targets'}, loss = mean
        </span>
      }
      flush
      bodyClassName="flex flex-col px-3 py-2"
      className={className}
    >
      {data && series ? (
        <Suspense fallback={<ChartSkeleton />}>
          <LatencyChart series={series} range={data.range} />
        </Suspense>
      ) : null}
    </Panel>
  )
}

export default NetworkLatencyPanel

import { lazy, Suspense } from 'react'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { useRange } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { hasHistory } from './historyModel'

// The chart runtime is its own chunk: the page paints before any chart code arrives.
const ServerHistoryChart = lazy(() => import('./ServerHistoryChart'))

/** Legend row plus the minimum plot: what the body keeps while the chart loads. */
const BODY_MIN = 'min-h-[15.5rem]'

interface HistoryPanelProps {
  index: number
  serverId: string
  name: string
  className?: string
}

/**
 * CPU, RAM and disk history of one server, over the range in the top bar.
 * The backend keeps one telemetry row per server, so this is sample data: the
 * footer says so, the SOURCE tag says mock, and nothing else depends on it.
 */
export function HistoryPanel({ index, serverId, name, className }: HistoryPanelProps) {
  const api = useApi()
  const { pollMs } = useLive()
  const [range] = useRange()
  const resource = useLiveResource(
    `server-history:${serverId}`,
    `server-series:${serverId}:${range}`,
    (signal) => api.getServerSeries({ serverId, range, signal }),
    // A new range keeps the previous chart, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )
  const series = resource.data

  return (
    <Panel
      index={index}
      title="Resource history"
      features="servers"
      scope={range}
      className={className}
      refreshMs={pollMs}
      status={resource.status}
      refreshing={resource.isRefreshing && series !== undefined}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      isEmpty={series !== undefined && !hasHistory(series)}
      empty={
        <EmptyState
          title="No history"
          hint="This server has not reported any telemetry in this range."
        />
      }
      skeleton={<Skeleton className={`${BODY_MIN} w-full`} />}
      footer={
        <span className="truncate @max-sm:py-1 @max-sm:whitespace-normal">
          History is sample data: the backend keeps only the latest reading.
        </span>
      }
      bodyClassName="flex flex-col px-3 py-2"
    >
      {series ? (
        <Suspense fallback={<Skeleton className={`${BODY_MIN} w-full flex-1`} />}>
          <ServerHistoryChart name={name} series={series} range={range} />
        </Suspense>
      ) : null}
    </Panel>
  )
}

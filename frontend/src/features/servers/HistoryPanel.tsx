import { lazy, Suspense } from 'react'
import type { ServerSeries } from '@/api/types'
import { useLive } from '@/app/live'
import { useRange } from '@/app/viewState'
import { useProvenance } from '@/hooks/useProvenance'
import type { Resource } from '@/hooks/useResource'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { hasHistory } from './historyModel'

// The chart runtime is its own chunk: the page paints before any chart code arrives.
const ServerHistoryChart = lazy(() => import('./ServerHistoryChart'))

/** Legend row plus the minimum plot: what the body keeps while the chart loads. */
const BODY_MIN = 'min-h-[15.5rem]'

interface HistoryPanelProps {
  index: number
  /** The series over the range in the top bar: the page requests it once for this panel and the Summary. */
  resource: Resource<ServerSeries>
  name: string
  className?: string
}

/**
 * CPU, RAM and disk history of one server, over the range in the top bar.
 * The console API serves this history. While the screen is not connected to
 * it, this is demo data: the footer says so and the SOURCE tag says mock.
 */
export function HistoryPanel({ index, resource, name, className }: HistoryPanelProps) {
  const { pollMs } = useLive()
  const [range] = useRange()
  const series = resource.data
  const { provenance } = useProvenance('servers')

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
        provenance === 'mock' ? (
          <span className="truncate @max-sm:py-1 @max-sm:whitespace-normal">
            Demo data: the console API serves this history, but this screen is not connected to it
            yet.
          </span>
        ) : undefined
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

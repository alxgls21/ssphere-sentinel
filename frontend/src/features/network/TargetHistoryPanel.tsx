import { lazy, Suspense } from 'react'
import type { TargetProtocol, TargetSeries } from '@/api/types'
import { useLive } from '@/app/live'
import { useRange } from '@/app/viewState'
import type { Resource } from '@/hooks/useResource'
import { LOSS_LABEL, type TargetLimits } from '@/lib/targets'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { hasHistory } from './targetHistoryModel'

// The chart runtime is its own chunk: the page paints before any chart code arrives.
const TargetHistoryChart = lazy(() => import('./TargetHistoryChart'))

/** Legend row plus the minimum plot: what the body keeps while the chart loads. */
const BODY_MIN = 'min-h-[15.5rem]'

interface TargetHistoryPanelProps {
  index: number
  /** The series over the range in the top bar. */
  resource: Resource<TargetSeries>
  name: string
  protocol: TargetProtocol
  limits: TargetLimits
  className?: string
}

/**
 * Latency, loss and failed measurements of one target over the range in the top bar, one of the
 * ranges the console API serves. A bucket with nothing to average is a gap in the line; failed
 * measurements are counted apart, and none of it is filled in.
 */
export function TargetHistoryPanel({
  index,
  resource,
  name,
  protocol,
  limits,
  className,
}: TargetHistoryPanelProps) {
  const { pollMs } = useLive()
  const [range] = useRange()
  const series = resource.data

  return (
    <Panel
      index={index}
      title="History"
      features="network"
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
        <EmptyState title="No history" hint="This target has not been measured in this range." />
      }
      skeleton={<Skeleton className={`${BODY_MIN} w-full`} />}
      footer={
        <span className="truncate @max-sm:py-1 @max-sm:whitespace-normal">
          Latency from the measurements that answered · {LOSS_LABEL[protocol].toLowerCase()} ·
          failed measurements counted apart · gaps are not filled in
        </span>
      }
      bodyClassName="flex flex-col px-3 py-2"
    >
      {series ? (
        <Suspense fallback={<Skeleton className={`${BODY_MIN} w-full flex-1`} />}>
          <TargetHistoryChart
            name={name}
            protocol={protocol}
            series={series}
            range={range}
            limits={limits}
          />
        </Suspense>
      ) : null}
    </Panel>
  )
}

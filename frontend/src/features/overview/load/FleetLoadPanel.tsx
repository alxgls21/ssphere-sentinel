import { useState } from 'react'
import { useApi } from '@/api/context'
import type { LoadMetric } from '@/api/types'
import { useLive } from '@/app/live'
import { scopeKey, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { ResourceStatus } from '@/hooks/useResource'
import { Panel } from '@/ui/Panel'
import { SegmentedControl } from '@/ui/controls'
import { EmptyState, Skeleton } from '@/ui/states'
import { LoadRow } from './LoadRow'
import { LOAD_ROWS, LOAD_TABS, THRESHOLD_NOTE, excludedNote, metricNoun } from './loadModel'

/** Placeholder rows at the real row height, so loading never shifts the footer. */
function LoadSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: LOAD_ROWS }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center px-3">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

function LoadFooter({ excluded }: { excluded: readonly string[] }) {
  const note = excludedNote(excluded)
  return (
    <div className="flex min-w-0 flex-col py-0.5">
      {note ? (
        <span className="truncate" title={excluded.join(', ')}>
          {note}
        </span>
      ) : null}
      <span className="truncate">{THRESHOLD_NOTE}</span>
    </div>
  )
}

/**
 * [3] Fleet load: the busiest servers by CPU, RAM or disk, as a NOW snapshot
 * (a trend per server is drawn on its own page). Demo data until the screen is
 * connected to the console API.
 */
export function FleetLoadPanel({ className }: { className?: string }) {
  const api = useApi()
  const { pollMs } = useLive()
  const [scope] = useScope()
  const [metric, setMetric] = useState<LoadMetric>('cpu')

  const resource = useLiveResource(
    'load',
    `fleet-load:${scopeKey(scope)}:${metric}`,
    async (signal) => ({
      metric,
      load: await api.getFleetLoad({ scope, metric, limit: LOAD_ROWS, signal }),
    }),
    // A scope change keeps the previous rows, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )

  // keepPreviousData also holds the answer for the OLD metric while the new one loads. Rows of
  // another metric must never sit under the tab that was just chosen, so they count as no data.
  const load = resource.data?.metric === metric ? resource.data.load : undefined
  const status: ResourceStatus = load ? resource.status : resource.error ? 'error' : 'loading'

  return (
    <Panel
      index={3}
      title="Fleet load"
      features="servers"
      scope="NOW"
      className={className}
      refreshMs={pollMs}
      actions={
        <SegmentedControl
          variant="tabs"
          size="sm"
          aria-label="Load metric"
          value={metric}
          onChange={setMetric}
          options={LOAD_TABS}
        />
      }
      status={status}
      refreshing={resource.isRefreshing && load !== undefined}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      isEmpty={load?.rows.length === 0}
      empty={
        <EmptyState
          title="No load samples"
          hint="No server in this scope has reported telemetry yet."
        />
      }
      skeleton={<LoadSkeleton />}
      footer={<LoadFooter excluded={load?.excluded ?? []} />}
      flush
    >
      {load ? (
        <div role="tabpanel" aria-label={`${metricNoun(metric)} load`}>
          <ul>
            {load.rows.map((row) => (
              <LoadRow key={row.serverId} row={row} metric={metric} />
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  )
}

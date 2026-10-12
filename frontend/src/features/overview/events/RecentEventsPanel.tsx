import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { scopeKey, useRange, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { Panel } from '@/ui/Panel'
import { EmptyState, Skeleton } from '@/ui/states'
import { EventLog } from './EventLog'

/** Lines requested: the tail scrolls, so this is a window onto the range, not a page. */
const EVENT_LIMIT = 50
const VISIBLE_LINES = 5

/** Placeholder lines at the real line height. */
function EventsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: VISIBLE_LINES }, (_, index) => (
        <div key={index} className="flex h-6 items-center px-3">
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * [6] Recent events: PLANNED. The backend keeps only the latest state, so there
 * is no event history; these are sample events derived from the same entities
 * as every other panel. Follows the topbar range and scope.
 */
export function RecentEventsPanel({ className }: { className?: string }) {
  const api = useApi()
  const { pollMs } = useLive()
  const [range] = useRange()
  const [scope] = useScope()

  const view = `${scopeKey(scope)}:${range}`
  const { status, data, error, isRefreshing, updatedAt, refetch } = useLiveResource(
    'events',
    `events:${view}`,
    // The answer carries its own view: keepPreviousData keeps showing the old one until it lands.
    async (signal) => ({
      view,
      events: await api.listEvents({ scope, range, limit: EVENT_LIMIT, signal }),
    }),
    // A range or scope change keeps the previous lines, dimmed, instead of flashing a skeleton.
    { keepPreviousData: true },
  )

  return (
    <Panel
      index={6}
      title="Recent events"
      features="events"
      plannedNote="Event log not implemented."
      scope={range}
      className={className}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={updatedAt}
      onRetry={refetch}
      isEmpty={data?.events.length === 0}
      empty={
        <EmptyState title="No events in range" hint={`Nothing was logged in the last ${range}.`} />
      }
      skeleton={<EventsSkeleton />}
      flush
    >
      {data ? <EventLog view={data.view} events={data.events} /> : null}
    </Panel>
  )
}

import { useState } from 'react'
import { useApi } from '@/api/context'
import { useLive } from '@/app/live'
import { scopeKey, useRange, useScope } from '@/app/viewState'
import { useLiveResource } from '@/hooks/useLiveResource'
import { Panel } from '@/ui/Panel'
import { SegmentedControl, type SegmentedOption } from '@/ui/controls'
import { EmptyState, Skeleton } from '@/ui/states'
import { EventLog } from './EventLog'
import { IncidentTimeline } from './IncidentTimeline'

/**
 * Events requested: the newest of the range, so an answer this long may not reach back to the
 * start of it. The tail scrolls, so this is a window onto the range, not a page.
 */
const EVENT_LIMIT = 50
const VISIBLE_LINES = 5

type EventsView = 'log' | 'timeline'

const VIEWS: readonly SegmentedOption<EventsView>[] = [
  { value: 'log', label: 'Log', title: 'The events, newest first' },
  { value: 'timeline', label: 'Timeline', title: 'The incidents among them, on a time axis' },
]

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
 * as every other panel. Follows the topbar range and scope. One request serves
 * two views of it: the log, and the incidents among the events on a timeline.
 */
export function RecentEventsPanel({ className }: { className?: string }) {
  const api = useApi()
  const { pollMs } = useLive()
  const [range] = useRange()
  const [scope] = useScope()
  const [mode, setMode] = useState<EventsView>('log')

  const view = `${scopeKey(scope)}:${range}`
  const { status, data, error, isRefreshing, updatedAt, refetch } = useLiveResource(
    'events',
    `events:${view}`,
    // The answer carries its own view: keepPreviousData keeps showing the old one until it lands.
    async (signal) => {
      const events = await api.listEvents({ scope, range, limit: EVENT_LIMIT, signal })
      return {
        view,
        range,
        events,
        // Newest first, so a full answer may have left older events of the range behind.
        truncated: events.length >= EVENT_LIMIT,
        // The timeline's axis ends here, and ongoing incidents are measured to it.
        readAt: Date.now(),
      }
    },
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
      actions={
        <SegmentedControl
          variant="tabs"
          size="sm"
          aria-label="Events view"
          value={mode}
          onChange={setMode}
          options={VIEWS}
        />
      }
      className={className}
      refreshMs={pollMs}
      status={status}
      refreshing={isRefreshing}
      error={error}
      updatedAt={updatedAt}
      onRetry={refetch}
      // The timeline has its own words for a range without incidents.
      isEmpty={mode === 'log' && data?.events.length === 0}
      empty={
        <EmptyState title="No events in range" hint={`Nothing was logged in the last ${range}.`} />
      }
      skeleton={<EventsSkeleton />}
      flush
    >
      {data ? (
        <div role="tabpanel" aria-label={mode === 'log' ? 'Log' : 'Timeline'} className="h-full">
          {mode === 'log' ? (
            <EventLog view={data.view} events={data.events} truncated={data.truncated} />
          ) : (
            <IncidentTimeline
              view={data.view}
              events={data.events}
              range={data.range}
              now={data.readAt}
              truncated={data.truncated}
            />
          )}
        </div>
      ) : null}
    </Panel>
  )
}

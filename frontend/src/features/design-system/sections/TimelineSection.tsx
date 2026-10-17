import type { SentinelEvent } from '@/api/types'
import { IncidentTimeline } from '@/features/overview/events/IncidentTimeline'
import { POLL_MS } from '@/lib/thresholds'
import { SAMPLE_TIME } from '../sample/data'
import { SAMPLE_INCIDENT_EVENTS, SAMPLE_INFO_EVENTS } from '../sample/incidents'
import { SamplePanel } from '../sample/SamplePanel'
import { Specimen } from '../Specimen'

/**
 * The height of the Overview's Recent events panel: a 120px body between its header and footer.
 * That is the room of five 24px log lines; here the summary line, the axis and the lanes share it.
 */
const OVERVIEW_HEIGHT = 'h-[11.125rem]'

function Sample({
  title,
  className,
  events,
}: {
  /** Titles differ because each panel is a labelled region, and two with one name cannot be told apart. */
  title: string
  className: string
  events: readonly SentinelEvent[]
}) {
  return (
    <SamplePanel
      title={title}
      note="The event log is not implemented in the backend."
      scope="1h"
      refreshMs={POLL_MS}
      className={className}
      flush
    >
      <IncidentTimeline view="gallery" events={events} range="1h" now={SAMPLE_TIME} />
    </SamplePanel>
  )
}

export function TimelineSection() {
  return (
    <div className="grid gap-x-3 gap-y-4 xl:grid-cols-2">
      <Specimen
        label="At the size of the Overview panel"
        bare
        note="A summary line and the shared time axis sit above the lanes; the lanes scroll beneath them and are one tab stop (arrow keys, Home and End move between them). Hover or focus a lane for its times and both messages: the times are in its accessible name and the messages in the Log view."
      >
        <Sample
          title="Recent events, timeline"
          className={OVERVIEW_HEIGHT}
          events={SAMPLE_INCIDENT_EVENTS}
        />
      </Specimen>

      <Specimen
        label="Every lane"
        bare
        note="Ongoing incidents come first, critical before warning, then the most recent start. A diamond or triangle marks the start. An ongoing bar is solid and stays open at the right edge, and says ONGOING with how long so far. A resolved one is a thin line on a tint that ends in the OK mark, and says RESOLVED with how long it lasted. A chevron cuts a bar that began before the axis; a recovery whose failure is older than the range has no start, severity or duration to give, and says so."
      >
        <Sample
          title="Recent events, all lanes"
          className="h-[18.5rem]"
          events={SAMPLE_INCIDENT_EVENTS}
        />
      </Specimen>

      <Specimen
        label="No incidents"
        bare
        note="Info events do not make incidents: they stay in the Log view, and the timeline says there is nothing to draw."
      >
        <Sample
          title="Recent events, no incidents"
          className={OVERVIEW_HEIGHT}
          events={SAMPLE_INFO_EVENTS}
        />
      </Specimen>
    </div>
  )
}

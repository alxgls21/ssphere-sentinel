import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RangeKey, SentinelEvent } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { cn } from '@/lib/cn'
import { formatClock } from '@/lib/format'
import { countUnseen } from './eventModel'
import { AXIS_BOX, IncidentLane, LANE_COLUMNS } from './IncidentLane'
import { axisOf, buildIncidents, countIncidents, spanOf } from './incidentModel'
import { dayClockOf, emptyText, spansDays, summaryText, timelineDescription } from './incidentText'
import { lineTarget } from './lineKeys'
import { Pill } from './Pill'
import { useReadHold } from './useReadHold'

/**
 * The incidents among the events of a range, one 24px lane each on a shared time axis that ends
 * at `now`. A summary line and the axis sit above the lanes; the lanes scroll under them, and
 * they are one tab stop (arrow keys move between them), like the lines of the log. When the
 * axis runs across midnight, every time carries its weekday.
 *
 * It holds still while it is being read, as the log does: hovering it or focusing a lane freezes
 * the lanes and the moment they are measured against, and what arrives meanwhile waits behind an
 * "N new" pill. Nothing animates.
 */
export function IncidentTimeline({
  events,
  view,
  range,
  now,
  truncated = false,
}: {
  events: readonly SentinelEvent[]
  /** What the events are of (range and scope). A different view is shown at once, held or not. */
  view: string
  range: RangeKey
  /** Epoch ms the axis ends at and ongoing incidents are measured to. */
  now: number
  /** The events are only the newest of the range: older ones, and what opened an incident, may be missing. */
  truncated?: boolean
}) {
  const { tz } = usePrefs()
  const descriptionId = useId()
  const latest = useMemo(() => ({ events, now, range, truncated }), [events, now, range, truncated])
  const { shown, paused, release, handlers } = useReadHold(latest, view)
  const unseen = useMemo(
    () => (paused ? countUnseen(events, shown.events) : 0),
    [paused, events, shown],
  )
  const incidents = useMemo(() => buildIncidents(shown.events, shown.now, shown.truncated), [shown])
  const axis = axisOf(shown.now, shown.range)
  const dated = spansDays(axis, tz)
  const axisClock = (ms: number) => (dated ? dayClockOf(ms, tz) : formatClock(ms, tz, false))

  const [tabStop, setTabStop] = useState(0)
  const [refocus, setRefocus] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const lanes = useRef<(HTMLLIElement | null)[]>([])
  const stop = Math.min(tabStop, incidents.length - 1)

  // The button that triggered this is about to disappear, so focus goes to the first lane
  // instead of being dropped (a vanished focused element would also leave the timeline "focused").
  useEffect(() => {
    if (refocus > 0) lanes.current[0]?.focus()
  }, [refocus])

  const showNewest = () => {
    release()
    setTabStop(0)
    setRefocus((count) => count + 1)
    if (scroller.current) scroller.current.scrollTop = 0
  }

  const moveBetweenLanes = (event: KeyboardEvent<HTMLLIElement>, from: number) => {
    const to = lineTarget(event.key, from, incidents.length - 1)
    if (to === null) return
    event.preventDefault()
    lanes.current[to]?.focus()
  }

  return (
    <div className="relative h-full min-h-30" {...handlers}>
      {incidents.length === 0 ? (
        <p className="type-body flex h-6 items-center px-3">
          {emptyText(shown.range, shown.truncated)}
        </p>
      ) : (
        <div className="absolute inset-0 flex flex-col">
          <p className="type-data flex h-4 shrink-0 items-center px-3 text-fg-muted">
            {summaryText(countIncidents(incidents), shown.truncated)}
          </p>
          <div
            aria-hidden="true"
            className={cn(LANE_COLUMNS, 'type-chart h-4 shrink-0 items-stretch px-3 text-fg-faint')}
          >
            <span className="relative col-start-2">
              {/* The ends are labelled outside the axis, over the columns this row leaves empty. */}
              <span className={cn(AXIS_BOX, 'border-x border-b border-border-strong')}>
                <span className="absolute top-0 right-full mr-1 whitespace-nowrap">
                  {axisClock(axis.start)}
                </span>
                <span className="absolute top-0 left-full ml-1 whitespace-nowrap">
                  {axisClock(axis.end)}
                </span>
              </span>
            </span>
          </div>
          <span id={descriptionId} className="sr-only">
            {timelineDescription(axis, shown.range, tz)}
          </span>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ol aria-label="Incident timeline" aria-describedby={descriptionId}>
              {incidents.map((incident, index) => (
                <IncidentLane
                  key={incident.id}
                  incident={incident}
                  span={spanOf(incident, axis)}
                  range={shown.range}
                  tz={tz}
                  dated={dated}
                  tabIndex={index === stop ? 0 : -1}
                  ref={(element) => {
                    lanes.current[index] = element
                  }}
                  onFocus={() => setTabStop(index)}
                  onKeyDown={(event) => moveBetweenLanes(event, index)}
                />
              ))}
            </ol>
          </div>
        </div>
      )}
      {unseen > 0 ? (
        <Pill tone="fresh" onClick={showNewest} className="top-1 right-3">
          {unseen} new<span className="sr-only"> events, show them</span>
        </Pill>
      ) : null}
    </div>
  )
}

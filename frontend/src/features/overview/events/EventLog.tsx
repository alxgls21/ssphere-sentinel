import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SentinelEvent } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { EventLine } from './EventLine'
import { buildTail, countUnseen } from './eventModel'
import { lineTarget } from './lineKeys'
import { Pill } from './Pill'
import { useReadHold } from './useReadHold'

/**
 * Terminal-style event tail, newest first, five 24px lines in view. Related
 * events nest under their parent.
 *
 * It holds still while it is being read: hovering it or focusing a line freezes the
 * lines on screen, and what arrives meanwhile waits behind an "N new" pill. role=log
 * with aria-live off, because a tail that announced every event would drown a screen reader.
 * Lines are one tab stop (arrow keys move between them), so a long tail does not trap Tab.
 * It is also the text equivalent of the incident timeline, and says so.
 */
export function EventLog({
  events,
  view,
  truncated = false,
}: {
  events: readonly SentinelEvent[]
  /** What the events are of (range and scope). A different view is shown at once, held or not. */
  view: string
  /** The events are only the newest of the range, not all of it. */
  truncated?: boolean
}) {
  const { tz } = usePrefs()
  const descriptionId = useId()
  // Following the data until somebody reads; from then on `shown` keeps the lines they were looking at.
  const { shown, paused, release, handlers } = useReadHold(events, view)
  const unseen = useMemo(() => (paused ? countUnseen(events, shown) : 0), [paused, events, shown])
  const lines = useMemo(() => buildTail(shown), [shown])

  const [tabStop, setTabStop] = useState(0)
  const [scrolled, setScrolled] = useState(false)
  const [refocus, setRefocus] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useRef<(HTMLLIElement | null)[]>([])
  const stop = Math.min(tabStop, lines.length - 1)

  // The button that triggered this is about to disappear, so focus goes to the newest line
  // instead of being dropped (a vanished focused element would also leave the log "focused").
  useEffect(() => {
    if (refocus > 0) rows.current[0]?.focus()
  }, [refocus])

  const showNewest = () => {
    release()
    setTabStop(0)
    setScrolled(false)
    setRefocus((count) => count + 1)
    if (scroller.current) scroller.current.scrollTop = 0
  }

  const moveBetweenLines = (event: KeyboardEvent<HTMLLIElement>, from: number) => {
    const to = lineTarget(event.key, from, lines.length - 1)
    if (to === null) return
    event.preventDefault()
    rows.current[to]?.focus()
  }

  return (
    <div className="relative h-full min-h-30" {...handlers}>
      <span id={descriptionId} className="sr-only">
        The text equivalent of the Timeline view: {truncated ? 'the newest events' : 'every event'}{' '}
        of the range, newest first, with a recovery under the failure it closes.
      </span>
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label="Recent events"
        aria-describedby={descriptionId}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className="absolute inset-0 overflow-y-auto overscroll-contain"
      >
        <ol>
          {lines.map((line, index) => (
            <EventLine
              key={line.event.id}
              line={line}
              tz={tz}
              tabIndex={index === stop ? 0 : -1}
              ref={(element) => {
                rows.current[index] = element
              }}
              onFocus={() => setTabStop(index)}
              onKeyDown={(event) => moveBetweenLines(event, index)}
            />
          ))}
        </ol>
      </div>
      {unseen > 0 ? (
        <Pill tone="fresh" onClick={showNewest} className="top-1 right-3">
          {unseen} new<span className="sr-only"> events, show them</span>
        </Pill>
      ) : null}
      {scrolled ? (
        <Pill onClick={showNewest} className="right-3 bottom-1">
          Jump to newest
        </Pill>
      ) : null}
    </div>
  )
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from 'react'
import type { SentinelEvent } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { cn } from '@/lib/cn'
import { EventLine } from './EventLine'
import { buildTail, countUnseen } from './eventModel'

const PILL_TONE = {
  neutral: 'border-border-control',
  fresh: 'border-primary-line text-primary',
} as const

/** A small button floating over the tail. Opaque, so it never competes with the line text under it. */
function Pill({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'button'> & { tone?: keyof typeof PILL_TONE }) {
  return (
    <button
      type="button"
      className={cn(
        'type-tag absolute z-10 inline-flex h-6 items-center rounded-sm border bg-raised px-2 whitespace-nowrap text-fg',
        'transition-colors duration-(--dur-fast) hover:bg-hover pointer-coarse:h-(--hit)',
        PILL_TONE[tone],
        className,
      )}
      {...props}
    />
  )
}

/**
 * Terminal-style event tail, newest first, five 24px lines in view. Related
 * events nest under their parent.
 *
 * It holds still while it is being read: hovering it or focusing a line freezes the
 * lines on screen, and what arrives meanwhile waits behind an "N new" pill. role=log
 * with aria-live off, because a tail that announced every event would drown a screen reader.
 * Lines are one tab stop (arrow keys move between them), so a long tail does not trap Tab.
 */
export function EventLog({
  events,
  view,
}: {
  events: readonly SentinelEvent[]
  /** What the events are of (range and scope). A different view is shown at once, held or not. */
  view: string
}) {
  const { tz } = usePrefs()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused

  const [shown, setShown] = useState(events)
  const [shownView, setShownView] = useState(view)
  // Following the data until somebody reads; from then on `shown` keeps the lines they were looking at.
  // Changing the range or scope is the operator's own doing, so that is never held back.
  if (view !== shownView) {
    setShownView(view)
    setShown(events)
  } else if (!paused && shown !== events) {
    setShown(events)
  }
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
    setShown(events)
    setTabStop(0)
    setScrolled(false)
    setRefocus((count) => count + 1)
    if (scroller.current) scroller.current.scrollTop = 0
  }

  const moveBetweenLines = (event: KeyboardEvent<HTMLLIElement>, from: number) => {
    const last = lines.length - 1
    let to: number
    switch (event.key) {
      case 'ArrowDown':
        to = Math.min(from + 1, last)
        break
      case 'ArrowUp':
        to = Math.max(from - 1, 0)
        break
      case 'Home':
        to = 0
        break
      case 'End':
        to = last
        break
      default:
        return
    }
    event.preventDefault()
    rows.current[to]?.focus()
  }

  return (
    <div
      className="relative h-full min-h-30"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label="Recent events"
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

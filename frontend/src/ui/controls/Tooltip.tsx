import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { overlayHost, placeTooltip, useFixedPlacement } from './placement'

const OPEN_DELAY_MS = 300
/** Lets the pointer travel the few pixels from the trigger onto the tooltip (WCAG 1.4.13 hoverable). */
const CLOSE_GRACE_MS = 100

/** The props Tooltip injects into its trigger and merges with the trigger's own. */
interface TriggerProps {
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
  'aria-describedby'?: string
}

export interface TooltipProps {
  /**
   * Supplementary text only: a tooltip must never be the only place a piece of
   * information lives (touch has no hover). null, false or '' disables it.
   */
  content: ReactNode
  /**
   * The trigger: ONE focusable element, or a component that spreads its props
   * onto one (button, a, Link, IconButton). Tooltip clones it to add hover,
   * focus and aria-describedby handling, so a trigger that drops those props
   * gets no tooltip. The trigger's own handlers keep working.
   */
  children: ReactElement<TriggerProps>
}

/**
 * Opens on hover after 300 ms and immediately on keyboard focus; closes on
 * blur, pointer leave, press and Escape. Pointer hover never opens it for
 * touch (a tap is the consumer's job). Placed above the trigger, flipped below
 * when there is no room.
 */
export function Tooltip({ content, children }: TooltipProps) {
  const id = useId()
  /** The trigger the open tooltip belongs to; null while closed. */
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const { later, clearTimer } = useTimer()

  const show = (trigger: HTMLElement) => {
    clearTimer()
    setAnchor(trigger)
  }
  const hide = useCallback(() => {
    clearTimer()
    setAnchor(null)
  }, [clearTimer])

  useEffect(() => {
    if (!anchor) return
    // Capture phase and consumed: with a tooltip showing, Escape dismisses the
    // tooltip first and must not also close the dialog or filter beneath it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [anchor, hide])

  const enabled = content != null && content !== false && content !== ''
  // Disabled while open (a rail tooltip once the sidebar expands): it must not reappear stale.
  if (!enabled && anchor) setAnchor(null)

  const own = children.props
  return (
    <>
      {enabled
        ? cloneElement(children, {
            onPointerEnter: (event) => {
              own.onPointerEnter?.(event)
              if (event.pointerType === 'touch') return
              const trigger = event.currentTarget
              clearTimer()
              if (!anchor) later(() => setAnchor(trigger), OPEN_DELAY_MS)
            },
            onPointerLeave: (event) => {
              own.onPointerLeave?.(event)
              if (event.pointerType === 'touch') return
              clearTimer()
              // A tooltip opened by keyboard focus stays until focus leaves.
              if (anchor && !focusIsVisible(event.currentTarget)) {
                later(() => setAnchor(null), CLOSE_GRACE_MS)
              }
            },
            onPointerDown: (event) => {
              own.onPointerDown?.(event)
              hide()
            },
            onFocus: (event) => {
              own.onFocus?.(event)
              // A click also focuses the trigger; only keyboard focus opens at once (hover covers the mouse).
              if (focusIsVisible(event.currentTarget)) show(event.currentTarget)
            },
            onBlur: (event) => {
              own.onBlur?.(event)
              hide()
            },
            'aria-describedby':
              [own['aria-describedby'], anchor ? id : undefined].filter(Boolean).join(' ') ||
              undefined,
          })
        : children}
      {enabled && anchor ? (
        <Bubble
          id={id}
          anchor={anchor}
          onPointerEnter={clearTimer}
          onPointerLeave={() => later(() => setAnchor(null), CLOSE_GRACE_MS)}
        >
          {content}
        </Bubble>
      ) : null}
    </>
  )
}

/** One pending action at a time: scheduling a new one cancels the old, and unmounting cancels both. */
function useTimer() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const clearTimer = useCallback(() => clearTimeout(timer.current), [])
  const later = useCallback(
    (action: () => void, delayMs: number) => {
      clearTimer()
      timer.current = setTimeout(action, delayMs)
    },
    [clearTimer],
  )
  useEffect(() => clearTimer, [clearTimer])
  return { later, clearTimer }
}

function Bubble({
  id,
  anchor,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  id: string
  anchor: HTMLElement
  onPointerEnter: () => void
  onPointerLeave: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFixedPlacement(ref, anchor, placeTooltip)
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="type-data fixed top-0 left-0 z-50 w-max max-w-xs rounded-md border border-border-strong bg-raised px-2 py-1 break-words text-fg shadow-overlay"
    >
      {children}
    </div>,
    overlayHost(anchor),
  )
}

/** Engines without :focus-visible are treated as keyboard so the tooltip is never lost to them. */
function focusIsVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

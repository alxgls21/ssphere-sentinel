import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type PointerEvent,
} from 'react'
import { describeUpdates, type QueuedUpdates, type QueueSnapshot } from './queueModel'

/** A row has keyboard focus: held updates apply after this long without any interaction. */
export const FOCUS_IDLE_MS = 30_000
/**
 * How long the pointer has to rest, or focus has to be gone, before held
 * updates apply on their own. Long enough to Tab from the table to the pill.
 */
export const SETTLE_MS = 5_000

/**
 * A flag that stays true for `idleMs` after the last `hold`. Holding while it
 * is already true only moves the deadline, so it can be called on every
 * pointer move without re-rendering. `cap` shortens a hold that is running.
 */
function useIdleFlag(idleMs: number) {
  const [active, setActive] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const deadline = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const arm = useCallback((ms: number) => {
    clearTimeout(timer.current)
    deadline.current = Date.now() + ms
    timer.current = setTimeout(() => setActive(false), ms)
  }, [])
  const hold = useCallback(() => {
    arm(idleMs)
    setActive(true)
  }, [arm, idleMs])
  const cap = useCallback(
    (ms: number) => {
      if (Date.now() + ms < deadline.current) arm(ms)
    },
    [arm],
  )
  return { active, hold, cap }
}

interface Shown {
  current: QueueSnapshot | undefined
  /** The snapshot this one replaced (same view), to tell which rows are new. */
  previous: QueueSnapshot | undefined
}

/** Handlers that tell the lock where the operator is; spread them on the element that holds the rows. */
export type OrderLockBinding = Pick<
  ComponentProps<'div'>,
  'onFocus' | 'onBlur' | 'onPointerMove' | 'onScroll' | 'onKeyDownCapture'
>

export interface OrderLock {
  /** What the table shows: the latest snapshot, or the frozen one while locked. */
  snapshot: QueueSnapshot | undefined
  previous: QueueSnapshot | undefined
  /** What is waiting behind the lock, or null when nothing worth announcing is. */
  queued: QueuedUpdates | null
  /** Show the waiting snapshot now (key r, the pill). The lock itself stays on. */
  apply: () => void
  bind: OrderLockBinding
}

/**
 * Nothing moves under the operator: while a row has keyboard focus, or the
 * pointer moved over (or the operator scrolled) the table in the last 5 s,
 * a new snapshot is held back
 * whole (rows, order and values stay as they were) and reported as "queued".
 * It applies when
 *   - the operator applies it (`apply`, or asks for a refresh: key r),
 *   - focus has left the table, or the pointer has been still, for 5 s,
 *   - nothing was touched for 30 s (a focused row on an unattended wall).
 * A snapshot of another view (scope, idle toggle) is the answer to something
 * the operator just did, so it is never held.
 */
export function useOrderLock(
  incoming: QueueSnapshot | undefined,
  {
    refreshToken,
    fetching,
  }: {
    refreshToken: number
    /**
     * A request is in flight. Lets a refresh that FAILS end its exemption from the lock: with no new
     * snapshot to apply, `refreshing` would otherwise stay on and the next ordinary poll would
     * reorder rows under a focused operator.
     */
    fetching?: boolean
  },
): OrderLock {
  const focus = useIdleFlag(FOCUS_IDLE_MS)
  const hover = useIdleFlag(SETTLE_MS)
  const focusWithin = useRef(false)
  const locked = focus.active || hover.active

  const [shown, setShown] = useState<Shown>({ current: incoming, previous: undefined })
  const [seenToken, setSeenToken] = useState(refreshToken)
  const [refreshing, setRefreshing] = useState(false)
  // After r: waiting for the refetch to start, then for it to settle.
  const [refreshPhase, setRefreshPhase] = useState<'waiting' | 'fetching'>('waiting')

  const show = (next: QueueSnapshot | undefined) =>
    setShown(({ current }) => ({
      current: next,
      previous: current && next && current.view === next.view ? current : undefined,
    }))

  // Derived from props during render (not an effect), so a held snapshot never flashes on screen.
  if (refreshToken !== seenToken) {
    // The operator asked for fresh data: show what is waiting, and the result of the refetch they started.
    setSeenToken(refreshToken)
    setRefreshing(true)
    setRefreshPhase('waiting')
    if (incoming !== shown.current) show(incoming)
  } else if (incoming !== shown.current) {
    const sameView = incoming?.view === shown.current?.view
    if (!locked || refreshing || !sameView) {
      show(incoming)
      setRefreshing(false)
    }
  }

  // The refetch the operator started has settled: its exemption from the lock is over, whether or not
  // it produced a new snapshot.
  if (refreshing && fetching !== undefined) {
    if (fetching && refreshPhase === 'waiting') setRefreshPhase('fetching')
    else if (!fetching && refreshPhase === 'fetching') setRefreshing(false)
  }

  const queued = useMemo(() => {
    const held = shown.current
    if (!locked || !held || !incoming || incoming === held || incoming.view !== held.view)
      return null
    return describeUpdates(held.items, incoming.items)
  }, [locked, shown, incoming])

  const apply = () => {
    if (incoming !== shown.current) show(incoming)
  }

  const bind: OrderLockBinding = {
    onFocus: () => {
      focusWithin.current = true
      focus.hold()
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      // Moving from one row to the next is not leaving.
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        return
      focusWithin.current = false
      // Not at once: the operator may be on their way to the pill with the Tab key.
      focus.cap(SETTLE_MS)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      // A finger scrolling the table is not a pointer resting on a row.
      if (event.pointerType === 'touch') return
      hover.hold()
      if (focusWithin.current) focus.hold()
    },
    // Scrolling is reading, whether by wheel, scrollbar or finger.
    onScroll: () => hover.hold(),
    // Typing counts as activity, so a long triage session never times out under the operator's fingers.
    onKeyDownCapture: () => {
      if (focusWithin.current) focus.hold()
    },
  }

  return { snapshot: shown.current, previous: shown.previous, queued, apply, bind }
}

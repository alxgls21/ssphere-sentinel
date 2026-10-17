import { act, renderHook } from '@testing-library/react'
import type { FocusEvent, PointerEvent, UIEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rowKey, type QueueItem, type QueueSnapshot } from './queueModel'
import { makeItem, referenceItems, resultOf } from './testing'
import { FOCUS_IDLE_MS, SETTLE_MS, useOrderLock } from './useOrderLock'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const snap = (items: QueueItem[], view = 'all'): QueueSnapshot => ({ ...resultOf(items), view })

/** The reference queue with one more critical row: the typical "something new arrived". */
const withNewCritical = (): QueueSnapshot =>
  snap([makeItem({ id: 'srv-new', name: 'new-host' }), ...referenceItems()])

const initial = snap(referenceItems())

interface Props {
  snapshot: QueueSnapshot | undefined
  token: number
  fetching?: boolean
}

function setup(incoming: QueueSnapshot | undefined) {
  const hook = renderHook(
    ({ snapshot, token, fetching }: Props) =>
      useOrderLock(snapshot, { refreshToken: token, fetching }),
    { initialProps: { snapshot: incoming, token: 0 } as Props },
  )
  return {
    result: hook.result,
    /** A poll lands (or, with a token, the operator asked for a refresh). */
    receive: (next: QueueSnapshot | undefined, token = 0, fetching?: boolean) =>
      hook.rerender({ snapshot: next, token, fetching }),
  }
}

const pointerMove = (pointerType = 'mouse') =>
  ({ pointerType }) as unknown as PointerEvent<HTMLDivElement>

/** A blur from a row: focus either moves to `related` or to nowhere. */
function blur(table: HTMLElement, related: Node | null) {
  return { currentTarget: table, relatedTarget: related } as unknown as FocusEvent<HTMLDivElement>
}

const focusRow = (result: { current: ReturnType<typeof useOrderLock> }) =>
  act(() => result.current.bind.onFocus?.({} as FocusEvent<HTMLDivElement>))

const leaveTable = (result: { current: ReturnType<typeof useOrderLock> }) =>
  act(() => result.current.bind.onBlur?.(blur(document.createElement('div'), null)))

describe('useOrderLock', () => {
  it('follows every snapshot while nothing is happening', () => {
    const { result, receive } = setup(initial)
    expect(result.current.snapshot).toBe(initial)
    const next = withNewCritical()
    receive(next)
    expect(result.current.snapshot).toBe(next)
    expect(result.current.queued).toBeNull()
    expect(result.current.previous).toBe(initial)
  })

  it('holds a snapshot whole while a row has focus, and reports what is waiting', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    receive(withNewCritical())
    expect(result.current.snapshot).toBe(initial)
    expect(result.current.queued).toEqual({ count: 1, arrived: 1, newCritical: 1 })
  })

  it('applies 5 s after focus leaves the table, so the operator can Tab to the pill first', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    const next = withNewCritical()
    receive(next)
    leaveTable(result)
    expect(result.current.snapshot).toBe(initial)
    expect(result.current.queued).not.toBeNull()
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    expect(result.current.snapshot).toBe(initial)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.snapshot).toBe(next)
    expect(result.current.queued).toBeNull()
  })

  it('keeps holding when focus comes back within that time', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    receive(withNewCritical())
    leaveTable(result)
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    focusRow(result)
    act(() => vi.advanceTimersByTime(SETTLE_MS * 2))
    expect(result.current.snapshot).toBe(initial)
  })

  it('does not count focus moving from one row to another as leaving', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    receive(withNewCritical())
    const table = document.createElement('div')
    const nextRow = document.createElement('tr')
    table.append(nextRow)
    act(() => result.current.bind.onBlur?.(blur(table, nextRow)))
    expect(result.current.snapshot).toBe(initial)
    expect(result.current.queued).not.toBeNull()
  })

  it('applies after 30 s without interaction, even with focus still in the table', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    const next = withNewCritical()
    receive(next)
    act(() => vi.advanceTimersByTime(FOCUS_IDLE_MS - 1))
    expect(result.current.snapshot).toBe(initial)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.snapshot).toBe(next)
  })

  it('counts typing as interaction, and locks again on the next key after a timeout', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    receive(withNewCritical())
    act(() => vi.advanceTimersByTime(FOCUS_IDLE_MS - 1000))
    act(() => result.current.bind.onKeyDownCapture?.({} as never))
    act(() => vi.advanceTimersByTime(FOCUS_IDLE_MS - 1000))
    expect(result.current.snapshot).toBe(initial)

    act(() => vi.advanceTimersByTime(1000))
    const applied = result.current.snapshot
    expect(applied).not.toBe(initial)

    // The operator is back: the next snapshot waits again.
    act(() => result.current.bind.onKeyDownCapture?.({} as never))
    const later = snap([...referenceItems(), makeItem({ id: 'x', name: 'x', kind: 'container' })])
    receive(later)
    expect(result.current.snapshot).toBe(applied)
    expect(result.current.queued).not.toBeNull()
  })

  it('holds while the pointer moves over the table and applies 5 s after it stops', () => {
    const { result, receive } = setup(initial)
    act(() => result.current.bind.onPointerMove?.(pointerMove()))
    const next = withNewCritical()
    receive(next)
    expect(result.current.snapshot).toBe(initial)

    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    act(() => result.current.bind.onPointerMove?.(pointerMove()))
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1))
    expect(result.current.snapshot).toBe(initial)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.snapshot).toBe(next)
  })

  it('holds while the table is being scrolled, by wheel, scrollbar or finger', () => {
    const { result, receive } = setup(initial)
    act(() => result.current.bind.onScroll?.({} as UIEvent<HTMLDivElement>))
    const next = withNewCritical()
    receive(next)
    expect(result.current.snapshot).toBe(initial)
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(result.current.snapshot).toBe(next)
  })

  it('ignores a finger dragging across the table', () => {
    const { result, receive } = setup(initial)
    act(() => result.current.bind.onPointerMove?.(pointerMove('touch')))
    const next = withNewCritical()
    receive(next)
    expect(result.current.snapshot).toBe(next)
  })

  it('stays locked while either focus or hover holds it', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    act(() => result.current.bind.onPointerMove?.(pointerMove()))
    receive(withNewCritical())
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(result.current.snapshot).toBe(initial)
  })

  it('applies on demand and stays locked afterwards', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    const next = withNewCritical()
    receive(next)
    act(() => result.current.apply())
    expect(result.current.snapshot).toBe(next)
    expect(result.current.queued).toBeNull()

    receive(snap([...next.items, makeItem({ id: 'y', name: 'y', kind: 'container' })]))
    expect(result.current.snapshot).toBe(next)
    expect(result.current.queued).not.toBeNull()
  })

  it('never holds a snapshot of another view: that is the answer to what the operator just did', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    const idleToo = snap(referenceItems(), 'idle')
    receive(idleToo)
    expect(result.current.snapshot).toBe(idleToo)
    // A different view does not diff against the old one either.
    expect(result.current.previous).toBeUndefined()
  })

  it('stays quiet when only values drift: the snapshot waits, but no pill', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    receive(snap(referenceItems().map((item) => ({ ...item, detail: `${item.detail} .` }))))
    expect(result.current.snapshot).toBe(initial)
    expect(result.current.queued).toBeNull()
  })

  it('keeps the lock after a refresh that failed: the next ordinary poll is held, not applied', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    // r: the operator asks for fresh data; a request starts...
    receive(initial, 1, false)
    receive(initial, 1, true)
    // ...and fails: no new snapshot arrives, the request settles.
    receive(initial, 1, false)
    // The next ordinary poll must now wait behind the lock instead of reordering rows under focus.
    const next = withNewCritical()
    receive(next, 1, false)
    expect(result.current.snapshot).toBe(initial)
    expect(result.current.queued).not.toBeNull()
  })

  it('shows what is waiting, and the refetch it started, when the operator asks for a refresh', () => {
    const { result, receive } = setup(initial)
    focusRow(result)
    const waiting = withNewCritical()
    receive(waiting)
    expect(result.current.snapshot).toBe(initial)

    // r: the token moves, and what was waiting is shown...
    receive(waiting, 1)
    expect(result.current.snapshot).toBe(waiting)

    // ...then the result of the refetch r started, without waiting behind the lock.
    const fresh = snap([...waiting.items, makeItem({ id: 'z', name: 'z', kind: 'container' })])
    receive(fresh, 1)
    expect(result.current.snapshot).toBe(fresh)

    // Only that one: the poll after it waits again.
    receive(snap(fresh.items.slice(1)), 1)
    expect(result.current.snapshot).toBe(fresh)
  })

  it('remembers the snapshot a new one replaced, for the arrival outline', () => {
    const { result, receive } = setup(initial)
    const next = withNewCritical()
    receive(next)
    expect(result.current.previous?.items.map(rowKey)).toEqual(initial.items.map(rowKey))
  })

  it('shows nothing before the first snapshot, then the first one at once', () => {
    const { result, receive } = setup(undefined)
    expect(result.current.snapshot).toBeUndefined()
    focusRow(result)
    receive(initial)
    expect(result.current.snapshot).toBe(initial)
  })
})

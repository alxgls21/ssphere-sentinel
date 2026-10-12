import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { isProblem, rowKey, type QueueItem } from './queueModel'

export interface QueueActions {
  open: (item: QueueItem) => void
  copy: (item: QueueItem) => void
  cycleFilter: () => void
  /** Returns whether there was a filter to clear. */
  clearFilter: () => boolean
  applyQueued: () => void
}

interface Options {
  rows: readonly QueueItem[]
  /** The first snapshot has arrived, so a pending focus restore can find its row. */
  ready: boolean
  /** The row the operator opened before leaving this screen. */
  restoreKey: string | undefined
  /** Single-key shortcuts (j k y f r). Arrows, Home, End, Enter and Esc always work. */
  letterKeys: boolean
  actions: QueueActions
}

/** The selected row by entity id, with the index it had: if the row vanishes, its neighbour inherits it. */
interface Selection {
  key: string | null
  index: number
}

export type RowProps = {
  tabIndex: 0 | -1
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: (event: FocusEvent<HTMLElement>) => void
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/** True while text inside the table is selected: that click was a drag to copy, not a request to open. */
const hasTextSelected = () => (window.getSelection()?.toString() ?? '') !== ''

/**
 * The keyboard model of the queue: one tab stop (roving tabindex on rows),
 * j/k and arrows, Home/End, Enter, y, f, r and Esc. The selection is kept by
 * entity id, so a refresh never moves it, and it keeps DOM focus with it when
 * the focused row disappears (applied update, filter).
 */
export function useQueueNavigation({ rows, ready, restoreKey, letterKeys, actions }: Options) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** The row element that has DOM focus, to notice when it is removed from under the operator. */
  const heldRow = useRef<HTMLElement | null>(null)
  const restoring = useRef(restoreKey !== undefined)
  const wantsFocus = useRef(false)
  const [selection, setSelection] = useState<Selection>({ key: restoreKey ?? null, index: 0 })

  const foundIndex =
    selection.key === null ? -1 : rows.findIndex((row) => rowKey(row) === selection.key)
  const activeIndex =
    rows.length === 0
      ? -1
      : foundIndex >= 0
        ? foundIndex
        : Math.min(selection.index, rows.length - 1)
  const activeRow = rows[activeIndex]
  const activeKey = activeRow ? rowKey(activeRow) : null
  // Derived during render: when the selected row moved or went away, the selection follows.
  if (activeKey !== null && (selection.key !== activeKey || selection.index !== activeIndex)) {
    setSelection({ key: activeKey, index: activeIndex })
  }

  /** Focuses the row at `index`. False when it cannot take focus (a card hidden behind "View all"). */
  const focusRow = (index: number): boolean => {
    const row = scrollerRef.current?.querySelectorAll<HTMLElement>('tbody > tr')[index]
    row?.focus()
    return row !== undefined && document.activeElement === row
  }

  /** Focuses the first row that can take it, walking from `index` in `step` direction. */
  const focusFrom = (index: number, step: 1 | -1): boolean => {
    for (let i = index; i >= 0 && i < rows.length; i += step) if (focusRow(i)) return true
    return false
  }

  useLayoutEffect(() => {
    if (wantsFocus.current && activeIndex >= 0) {
      wantsFocus.current = false
      focusRow(activeIndex)
      return
    }
    if (restoring.current && ready) {
      restoring.current = false
      if (activeIndex >= 0) focusRow(activeIndex)
      return
    }
    const held = heldRow.current
    if (!held || held.isConnected) return
    heldRow.current = null
    // The focused row was removed: hand focus to the row that took its place, unless the operator already went elsewhere.
    if (activeIndex >= 0 && (document.activeElement === document.body || !document.activeElement)) {
      focusRow(activeIndex)
    }
  })

  /** Next problem row after the selection (wrapping), for the n / Shift+N shortcut. */
  const focusProblem = (direction: 1 | -1) => {
    const count = rows.length
    for (let step = 1; step <= count; step += 1) {
      const index = (((activeIndex + direction * step) % count) + count) % count
      const row = rows[index]
      if (row && isProblem(row) && focusRow(index)) return
    }
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const row = rows[index]
    if (!row) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusFrom(index + 1, 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        focusFrom(index - 1, -1)
        return
      case 'Home':
        event.preventDefault()
        focusFrom(0, 1)
        return
      case 'End':
        event.preventDefault()
        focusFrom(rows.length - 1, -1)
        return
      case 'Enter':
        // Only the row itself: Enter on anything inside it keeps its own meaning.
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        actions.open(row)
        return
      case 'Escape':
        if (actions.clearFilter()) {
          // Esc closes things from the top down: the filter is this panel's, so nothing beneath may react.
          event.preventDefault()
          event.stopPropagation()
        }
        return
    }
    if (!letterKeys || event.shiftKey) return
    // By physical key, so Greek and Cyrillic layouts keep working.
    switch (event.code) {
      case 'KeyJ':
        event.preventDefault()
        focusFrom(index + 1, 1)
        return
      case 'KeyK':
        event.preventDefault()
        focusFrom(index - 1, -1)
        return
      case 'KeyY':
        event.preventDefault()
        actions.copy(row)
        return
      case 'KeyF':
        event.preventDefault()
        actions.cycleFilter()
        return
      case 'KeyR':
        // Not consumed: the global "refresh now" listens for this key too.
        actions.applyQueued()
        return
    }
  }

  const rowProps = (index: number): RowProps => ({
    tabIndex: index === activeIndex ? 0 : -1,
    onFocus: (event) => {
      if (event.target !== event.currentTarget) return
      const row = rows[index]
      heldRow.current = event.currentTarget
      if (row) setSelection({ key: rowKey(row), index })
    },
    onBlur: (event) => {
      const element = event.currentTarget
      // A row that is removed while focused may or may not report a blur; only a row still in the page was left on purpose.
      queueMicrotask(() => {
        if (element.isConnected && heldRow.current === element) heldRow.current = null
      })
    },
    onClick: () => {
      const row = rows[index]
      if (row && !hasTextSelected()) actions.open(row)
    },
    onKeyDown: (event) => onRowKeyDown(event, index),
  })

  return {
    scrollerRef,
    activeIndex,
    rowProps,
    /** Puts focus on the selected row (the panel itself was focused, by the digit key). */
    focusActive: () => {
      if (activeIndex >= 0) focusFrom(activeIndex, 1)
    },
    /** Once the next render has its rows: for a control that vanishes when pressed, so keyboard focus is not lost with it. */
    focusSoon: () => {
      wantsFocus.current = true
    },
    focusProblem,
  }
}

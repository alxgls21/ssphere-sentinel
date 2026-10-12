import { Check } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { buttonStyle } from './buttonStyle'
import { Kbd } from './Kbd'
import { overlayHost, placeMenu, useFixedPlacement } from './placement'

export type MenuItem =
  | { type: 'action'; label: string; onSelect: () => void; hint?: string }
  | { type: 'checkbox'; label: string; checked: boolean; onChange: (checked: boolean) => void }
  | {
      type: 'radio-group'
      label: string
      value: string
      options: readonly { value: string; label: string }[]
      onChange: (value: string) => void
    }
  | { type: 'separator' }

export interface MenuProps {
  /** Names the trigger and the popup. For a text trigger it must contain the visible text. */
  label: string
  /** Shown inside the trigger button: an icon, text, or both. */
  trigger: ReactNode
  items: readonly MenuItem[]
  variant?: 'secondary' | 'ghost'
  /** Styles the trigger button. */
  className?: string
}

/** Typed characters count as one search until the user pauses this long. */
const TYPEAHEAD_MS = 500

/** One focusable row of the popup, whatever kind of item it came from. */
interface Entry {
  index: number
  role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'
  label: string
  hint?: string
  checked?: boolean
  /** Actions close the menu; toggles and choices keep it open so several can be changed in a row. */
  closes: boolean
  run: () => void
}

type Row =
  | { type: 'separator' }
  | { type: 'entry'; entry: Entry }
  | { type: 'group'; label: string; entries: Entry[] }

/** Flattens items into rows to draw and entries to navigate, numbered in reading order. */
function toRows(items: readonly MenuItem[]): { rows: Row[]; entries: Entry[] } {
  const entries: Entry[] = []
  const add = (entry: Omit<Entry, 'index'>): Entry => {
    const numbered = { ...entry, index: entries.length }
    entries.push(numbered)
    return numbered
  }
  const rows = items.map((item): Row => {
    switch (item.type) {
      case 'separator':
        return { type: 'separator' }
      case 'action':
        return {
          type: 'entry',
          entry: add({
            role: 'menuitem',
            label: item.label,
            hint: item.hint,
            closes: true,
            run: item.onSelect,
          }),
        }
      case 'checkbox':
        return {
          type: 'entry',
          entry: add({
            role: 'menuitemcheckbox',
            label: item.label,
            checked: item.checked,
            closes: false,
            run: () => item.onChange(!item.checked),
          }),
        }
      case 'radio-group':
        return {
          type: 'group',
          label: item.label,
          entries: item.options.map((option) =>
            add({
              role: 'menuitemradio',
              label: option.label,
              checked: option.value === item.value,
              closes: false,
              run: () => item.onChange(option.value),
            }),
          ),
        }
    }
  })
  return { rows, entries }
}

/**
 * A small popover menu (the shell's Display menu). Focus moves to the first
 * item on open and then roves with Up/Down/Home/End and typeahead; Escape closes
 * and returns focus to the trigger. Choosing an action closes the menu, toggling
 * a checkbox or radio keeps it open.
 */
export function Menu({ label, trigger, items, variant = 'secondary', className }: MenuProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  /** The trigger and which end to focus, while open. */
  const [opened, setOpened] = useState<{ anchor: HTMLElement; start: 'first' | 'last' } | null>(
    null,
  )

  const close = useCallback(() => setOpened(null), [])
  const dismiss = useCallback(() => {
    triggerRef.current?.focus()
    setOpened(null)
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={opened !== null}
        aria-controls={opened ? menuId : undefined}
        className={cn(buttonStyle(variant), className)}
        onClick={(event) =>
          setOpened(opened ? null : { anchor: event.currentTarget, start: 'first' })
        }
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          setOpened({
            anchor: event.currentTarget,
            start: event.key === 'ArrowDown' ? 'first' : 'last',
          })
        }}
      >
        {trigger}
      </button>
      {opened ? (
        <MenuPopover
          id={menuId}
          label={label}
          anchor={opened.anchor}
          items={items}
          start={opened.start}
          close={close}
          dismiss={dismiss}
        />
      ) : null}
    </>
  )
}

function MenuPopover({
  id,
  label,
  anchor,
  items,
  start,
  close,
  dismiss,
}: {
  id: string
  label: string
  anchor: HTMLElement
  items: readonly MenuItem[]
  start: 'first' | 'last'
  /** Close, leaving focus wherever the user put it (an outside click). */
  close: () => void
  /** Close and return focus to the trigger (Escape, Tab, choosing an action). */
  dismiss: () => void
}) {
  const { rows, entries } = toRows(items)
  const count = entries.length
  const ref = useRef<HTMLDivElement>(null)
  const elements = useRef<(HTMLButtonElement | null)[]>([])
  const typed = useRef<{ text: string; timer?: ReturnType<typeof setTimeout> }>({ text: '' })
  /** The roving stop: the one entry that is tabbable and holds focus. Focus follows this state. */
  const [active, setActive] = useState(start === 'last' ? count - 1 : 0)
  // Reserve the check column in every row once any row can be checked, so labels stay aligned.
  const marked = entries.some((entry) => entry.role !== 'menuitem')

  useFixedPlacement(ref, anchor, placeMenu)

  useEffect(() => {
    // An empty menu has no item to hold focus, but Escape must still reach it.
    const focusTarget = elements.current[active] ?? ref.current
    focusTarget?.focus()
  }, [active])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!ref.current?.contains(target) && !anchor.contains(target)) close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [anchor, close])

  useEffect(() => {
    const state = typed.current
    return () => clearTimeout(state.timer)
  }, [])

  const choose = (entry: Entry) => {
    // Focus goes back first: an action that opens a dialog then takes it, instead of losing it to us.
    if (entry.closes) dismiss()
    entry.run()
  }

  const typeahead = (key: string) => {
    const state = typed.current
    clearTimeout(state.timer)
    state.text += key.toLowerCase()
    state.timer = setTimeout(() => {
      state.text = ''
    }, TYPEAHEAD_MS)
    // The same letter again and again cycles through the items starting with it;
    // a longer prefix narrows the current match instead.
    const cycling = [...state.text].every((char) => char === state.text.slice(0, 1))
    const query = cycling ? state.text.slice(0, 1) : state.text
    const from = cycling ? active + 1 : active
    for (let step = 0; step < count; step++) {
      const index = (from + step) % count
      if (entries[index]?.label.toLowerCase().startsWith(query)) {
        setActive(index)
        return
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    switch (event.key) {
      case 'Escape':
        // Consumed so a dialog or filter beneath the menu is not dismissed too.
        event.preventDefault()
        event.stopPropagation()
        dismiss()
        return
      case 'Tab':
        // Not prevented: focus is already back on the trigger, so Tab continues from there.
        dismiss()
        return
    }
    if (count === 0) return

    // A space with nothing typed yet stays the key that activates the focused item.
    const typing =
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.key !== ' ' || typed.current.text !== '')
    if (typing) {
      typeahead(event.key)
      event.preventDefault()
      return
    }

    // Moving by arrow ends the current search.
    typed.current.text = ''
    switch (event.key) {
      case 'ArrowDown':
        setActive((active + 1) % count)
        break
      case 'ArrowUp':
        setActive((active - 1 + count) % count)
        break
      case 'Home':
        setActive(0)
        break
      case 'End':
        setActive(count - 1)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const renderEntry = (entry: Entry, key: string | number) => (
    <button
      key={key}
      ref={(element) => {
        elements.current[entry.index] = element
      }}
      type="button"
      role={entry.role}
      aria-checked={entry.role === 'menuitem' ? undefined : Boolean(entry.checked)}
      tabIndex={entry.index === active ? 0 : -1}
      onFocus={() => setActive(entry.index)}
      onClick={() => choose(entry)}
      className="type-data flex h-(--row-h) w-full items-center gap-2 px-2 text-left text-fg hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2"
    >
      {marked ? (
        <span className="size-4 shrink-0">
          {entry.checked ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
        </span>
      ) : null}
      <span className="truncate">{entry.label}</span>
      {entry.hint ? (
        <>
          {/* Flex layout ignores this space; the accessible name reads "Refresh now r". */}{' '}
          <Kbd className="ml-auto">{entry.hint}</Kbd>
        </>
      ) : null}
    </button>
  )

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed top-0 left-0 z-50 w-max max-w-xs min-w-48 animate-overlay-in overflow-y-auto rounded-md border border-border-strong bg-raised py-1 shadow-overlay"
    >
      {rows.map((row, index) => {
        switch (row.type) {
          case 'separator':
            return <hr key={index} className="my-1 border-border-strong" />
          case 'entry':
            return renderEntry(row.entry, `row-${index}`)
          case 'group':
            return (
              <fieldset key={index} className="min-w-0">
                <legend className="type-label px-2 pt-2 pb-1 text-fg-faint">{row.label}</legend>
                {row.entries.map((entry) => renderEntry(entry, entry.index))}
              </fieldset>
            )
        }
      })}
    </div>,
    overlayHost(anchor),
  )
}

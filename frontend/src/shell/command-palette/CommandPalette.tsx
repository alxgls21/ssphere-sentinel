import { ArrowDown, ArrowUp } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useApi } from '@/api/context'
import type { EntityIndex } from '@/api/types'
import { useShell } from '@/app/shell'
import { scopeKey, useScope } from '@/app/viewState'
import { useResource, type Resource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { Chip, Kbd } from '@/ui/controls'
import { ErrorState } from '@/ui/states/ErrorState'
import { buildGroups, type PaletteItem } from './model'
import { EntitySkeleton, PaletteResults } from './PaletteResults'
import {
  SCOPE_CHIPS,
  chipOf,
  parseQuery,
  stepChip,
  stripPrefix,
  type Scope,
  type ScopeChip,
} from './query'
import { usePaletteSource } from './usePaletteSource'

/**
 * The Ctrl/Cmd+K launcher: navigation, entity jump and actions on a native
 * modal <dialog> with the ARIA combobox/listbox pattern. Open state lives in
 * the shell (useShell), so the hotkey layer and the topbar trigger share it.
 */
export function CommandPalette() {
  const { paletteOpen } = useShell()
  // The entity index is fetched the first time the palette opens, not at app start.
  const [activated, setActivated] = useState(paletteOpen)
  if (paletteOpen && !activated) setActivated(true)
  return activated ? <PaletteDialog open={paletteOpen} /> : null
}

function PaletteDialog({ open }: { open: boolean }) {
  const api = useApi()
  const [scope] = useScope()
  const { closePalette } = useShell()
  /** Whether the current click began on the backdrop: a text drag that ends there is not a click-away. */
  const pressedBackdrop = useRef(false)

  const index = useResource(`entity-index:${scopeKey(scope)}`, (signal) =>
    api.getEntityIndex({ scope, signal }),
  )

  // The first open already fetched; later opens refresh in the background, keeping the old
  // index on screen meanwhile, so the states of things that changed are not stale.
  const { refetch } = index
  const opened = useRef(false)
  useEffect(() => {
    if (!open) return
    if (opened.current) refetch()
    opened.current = true
  }, [open, refetch])

  return (
    // The backdrop click is a pointer convenience on the dialog itself; Esc is the keyboard path.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <dialog
      aria-label="Command palette"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault()
        closePalette()
      }}
      onClose={(event) => {
        if (!event.currentTarget.open) closePalette()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Consumed here so the hotkey layer does not also treat it as "clear the filter".
        event.preventDefault()
        event.stopPropagation()
        closePalette()
      }}
      // The backdrop is the dialog element itself: a click on it is a click outside the panel.
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget
        // A press anywhere but the field must not move focus off it, or typing and the arrows stop working.
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) closePalette()
      }}
      className={cn(
        // A flex display has to wait for [open]: it would otherwise show the closed dialog.
        'flex-col overflow-hidden text-fg open:flex',
        'fixed top-[12vh] bottom-auto left-1/2 max-h-[76vh] w-160 max-w-[92vw] -translate-x-1/2',
        'animate-overlay-in rounded-md border border-border-strong bg-raised shadow-overlay',
        // Below 768px it is a full-screen sheet.
        'max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:rounded-none max-md:border-0',
      )}
    >
      {open ? <PaletteSession index={index} /> : null}
    </dialog>
  )
}

const entityScopes: readonly Scope[] = ['all', 'entities', 'sites']

function PaletteSession({ index }: { index: Resource<EntityIndex> }) {
  const { closePalette, flashStatus } = useShell()
  const [raw, setRaw] = useState('')
  const [chip, setChip] = useState<ScopeChip>('all')
  const [activeId, setActiveId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Opening and closing follow the session: it mounts when the palette opens and unmounts when
  // it closes. A layout effect, so the dialog never shows empty for a frame while closing. The
  // dialog is found from the input because a parent's ref is not attached yet on the first open.
  useLayoutEffect(() => {
    const dialog = inputRef.current?.closest('dialog')
    if (!dialog) return
    const invoker = document.activeElement
    if (!dialog.open) dialog.showModal()
    inputRef.current?.focus()
    return () => {
      dialog.close()
      // Native close restores focus too; this also covers engines and tests that do not.
      if (invoker instanceof HTMLElement && invoker !== document.body && invoker.isConnected)
        invoker.focus()
    }
  }, [])

  const choosePrefix = useCallback((prefix: string) => {
    setRaw(prefix)
    setActiveId(null)
  }, [])
  const retry = index.status === 'error' ? index.refetch : null
  const source = usePaletteSource({ index: index.data, choosePrefix, retry })

  const { scope, text } = parseQuery(raw, chip)
  const groups = useMemo(() => buildGroups(source, { scope, text }), [source, scope, text])
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const count = flat.length

  // The active row is tracked by id, so it survives the list changing under it (the entity
  // index arriving while the operator is already on a row).
  const found = flat.findIndex((item) => item.id === activeId)
  const activeIndex = found === -1 ? 0 : found
  const active = flat[activeIndex]
  const optionId = (position: number) => `${listId}-option-${position}`

  const run = (item: PaletteItem) => {
    if (item.run === null) {
      closePalette()
      flashStatus(`${item.title}: not available in the console yet`)
      return
    }
    // Run first: copying the link needs the user's gesture, which closing does not preserve.
    item.run()
    if (!item.keepOpen) closePalette()
  }

  const selectChip = (next: ScopeChip) => {
    setChip(next)
    setRaw(stripPrefix(raw))
    setActiveId(null)
    inputRef.current?.focus()
  }

  const move = (step: 1 | -1) => {
    if (count > 0) setActiveId(flat[(activeIndex + step + count) % count]?.id ?? null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME uses these keys to compose; they are not ours then.
    if (event.nativeEvent.isComposing) return

    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      // Ctrl+J / Ctrl+K move like Down / Up. Matched by code so non-Latin layouts work, and
      // stopped here so Ctrl+K does not reach the hotkey layer that opens the palette.
      const step = event.code === 'KeyJ' ? 1 : event.code === 'KeyK' ? -1 : 0
      if (step !== 0) {
        event.preventDefault()
        event.stopPropagation()
        move(step)
        return
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Enter':
        event.preventDefault()
        if (active) run(active)
        break
      case 'Tab':
        // Tab cycles the scope chips instead of leaving the field.
        event.preventDefault()
        selectChip(stepChip(chipOf(scope), event.shiftKey ? -1 : 1))
        break
    }
  }

  const wantsEntities = entityScopes.includes(scope)
  const loading = wantsEntities && index.status === 'loading'
  const failed = wantsEntities && index.status === 'error'
  const activeChip = chipOf(scope)
  const summary = [
    count === 0 ? 'No results' : count === 1 ? '1 result' : `${count} results`,
    activeChip && activeChip !== 'all'
      ? `in ${SCOPE_CHIPS.find((candidate) => candidate.id === activeChip)?.label}`
      : null,
    loading ? 'loading entities' : null,
    failed ? 'entities unavailable' : null,
  ]
    .filter(Boolean)
    .join(', ')
  const announced = useDebounced(summary, 250)

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 border-b border-border-strong px-3 max-md:pb-2">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <span aria-hidden="true" className="type-prompt text-primary">
            &gt;
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search or run a command"
            aria-autocomplete="list"
            aria-expanded={count > 0}
            aria-controls={count > 0 ? listId : undefined}
            aria-activedescendant={active ? optionId(activeIndex) : undefined}
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value)
              setActiveId(null)
            }}
            onKeyDown={onKeyDown}
            placeholder="search or run..."
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            className="type-prompt h-11 min-w-0 flex-1 bg-transparent text-fg placeholder:text-fg-faint focus-visible:-outline-offset-2 max-md:h-12"
          />
        </div>
        <fieldset className="flex min-w-0 gap-1">
          <legend className="sr-only">Search scope</legend>
          {SCOPE_CHIPS.map(({ id, label }) => (
            <Chip
              key={id}
              pressed={activeChip === id}
              onPressedChange={(pressed) => selectChip(pressed ? id : 'all')}
              // Tab cycles scopes from the field, and a press must not take focus from it.
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
            >
              {label}
            </Chip>
          ))}
        </fieldset>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
        {loading ? <EntitySkeleton label={skeletonLabel(scope, text)} /> : null}
        {failed ? (
          <ErrorState banner title="Entity search unavailable" onRetry={index.refetch} />
        ) : null}
        {count > 0 ? (
          <PaletteResults
            groups={groups}
            activeId={active?.id}
            listId={listId}
            optionId={optionId}
            onActivate={(item) => setActiveId(item.id)}
            onRun={run}
          />
        ) : loading || failed ? null : (
          <p className="type-data px-3 py-4 text-fg-muted">{emptyMessage(scope)}</p>
        )}
      </div>

      <footer className="type-tag flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-strong px-3 py-1.5 text-fg-faint max-md:hidden">
        <span className="flex items-center gap-1">
          <Kbd aria-hidden="true">
            <ArrowUp size={12} strokeWidth={1.5} />
          </Kbd>
          <Kbd aria-hidden="true">
            <ArrowDown size={12} strokeWidth={1.5} />
          </Kbd>
          Move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> Run
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Tab</Kbd> Scope
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> Close
        </span>
        <span className="flex items-center gap-1">
          <Kbd>?</Kbd> Help
        </span>
      </footer>

      <output className="sr-only">{announced}</output>
    </>
  )
}

function skeletonLabel(scope: Scope, text: string): string {
  if (scope === 'sites') return 'Sites and customers'
  return scope === 'all' && text === '' ? 'Problems' : 'Entities'
}

function emptyMessage(scope: Scope): string {
  return entityScopes.includes(scope) && scope !== 'all'
    ? 'No match. Try a hostname, address, site or customer'
    : 'No match. Try @ for entities'
}

/** Lags `value` until it has been stable for `delayMs`: a screen reader hears the final count, not each keystroke's. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

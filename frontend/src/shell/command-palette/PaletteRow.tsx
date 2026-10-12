import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { Kbd } from '@/ui/controls'
import { PlannedChip } from '@/ui/provenance/Chips'
import { StatusTag } from '@/ui/status'
import type { PaletteItem } from './model'

interface PaletteRowProps {
  item: PaletteItem
  /** DOM id the combobox points at with aria-activedescendant. */
  id: string
  active: boolean
  onActivate: () => void
  onRun: () => void
}

/**
 * One option: chevron (the single selection marker), icon, title, subtitle,
 * then a right slot (state tag, shortcut keycaps or a PLAN / PLANNED / CURRENT
 * tag). Focus stays in the input, so the row is never focused; the pointer
 * only moves the active row.
 */
export function PaletteRow({ item, id, active, onActivate, onRun }: PaletteRowProps) {
  const Icon = item.icon
  const inert = item.run === null
  const ref = useRef<HTMLButtonElement>(null)
  // Arrow keys can move the active row out of view; the pointer cannot, so this never fights it.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <button
      ref={ref}
      type="button"
      // A native <option> cannot hold a state tag and keycaps.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="option"
      id={id}
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={inert || undefined}
      // A press must not pull focus out of the input.
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={onActivate}
      onClick={onRun}
      className={cn(
        'group flex h-(--row-h) w-full items-center gap-2 px-3 text-left aria-selected:bg-primary-tint',
        inert ? 'text-fg-muted' : 'text-fg',
      )}
    >
      <ChevronRight
        size={16}
        strokeWidth={1.5}
        aria-hidden="true"
        className="shrink-0 text-primary opacity-0 group-aria-selected:opacity-100"
      />
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-fg-muted" />
      <span className={cn('max-w-[55%] shrink-0 truncate', item.prose ? 'type-body' : 'type-data')}>
        {item.title}
      </span>
      {item.subtitle ? (
        <>
          {/* Flex layout ignores this space; the accessible name reads "title subtitle". */}{' '}
          <span className="type-data min-w-0 flex-1 truncate text-fg-faint">{item.subtitle}</span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <RightSlot item={item} />
    </button>
  )
}

function RightSlot({ item }: { item: PaletteItem }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
      {item.status ? <StatusTag status={item.status} /> : null}
      {item.badge === 'plan' ? (
        <span className="type-tag rounded-sm border border-dashed border-border-strong px-1.5 py-0.5 text-fg-muted">
          Plan
        </span>
      ) : null}
      {item.badge === 'planned' ? (
        <PlannedChip title="Not implemented in the backend yet." />
      ) : null}
      {item.badge === 'current' ? (
        <span className="type-tag inline-flex items-center gap-1 text-primary">
          <Check size={12} strokeWidth={1.5} aria-hidden="true" />
          Current
        </span>
      ) : null}
      {item.hint ? (
        <>
          <span className="sr-only">Shortcut {item.hint.join(' then ')}</span>
          <span aria-hidden="true" className="flex gap-1">
            {item.hint.map((key, position) => (
              <Kbd key={position}>{key}</Kbd>
            ))}
          </span>
        </>
      ) : null}
    </span>
  )
}

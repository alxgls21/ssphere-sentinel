import { Skeleton } from '@/ui/states/Skeleton'
import type { PaletteGroup, PaletteItem } from './model'
import { PaletteRow } from './PaletteRow'

interface PaletteResultsProps {
  groups: readonly PaletteGroup[]
  activeId: string | undefined
  /** The listbox element: the combobox points at it with aria-controls. */
  listId: string
  /** DOM id of the option at this position in the flattened list. */
  optionId: (position: number) => string
  onActivate: (item: PaletteItem) => void
  onRun: (item: PaletteItem) => void
}

/** The listbox: labelled groups of options, numbered across groups in reading order. */
export function PaletteResults({
  groups,
  activeId,
  listId,
  optionId,
  onActivate,
  onRun,
}: PaletteResultsProps) {
  let position = 0
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <select> cannot hold rich rows
    <div id={listId} role="listbox" aria-label="Results">
      {groups.map((group) => (
        <fieldset key={group.id} className="min-w-0">
          <legend className="type-label px-3 pt-2 pb-1 text-fg-faint">{group.label}</legend>
          {group.items.map((item) => (
            <PaletteRow
              key={item.id}
              item={item}
              id={optionId(position++)}
              active={item.id === activeId}
              onActivate={() => onActivate(item)}
              onRun={() => onRun(item)}
            />
          ))}
        </fieldset>
      ))}
    </div>
  )
}

/** Stands where the entity groups will appear, so loading never reorders what is already usable. */
export function EntitySkeleton({ label }: { label: string }) {
  return (
    <div aria-hidden="true">
      <div className="type-label px-3 pt-2 pb-1 text-fg-faint">{label}</div>
      <div className="flex flex-col gap-1 px-3 py-1">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-5" />
        ))}
      </div>
    </div>
  )
}

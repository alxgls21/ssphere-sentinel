import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SiteEntity } from '@/api/types'
import { useProvenance } from '@/hooks/useProvenance'
import { cn } from '@/lib/cn'
import { STATUS_WORD } from '@/ui/status'
import { EntityGlyph } from './EntityGlyph'
import { entityKey } from './entities'
import { KIND_LABEL, buildGridLayout, moveTo } from './grid'

interface EntityGridProps {
  entities: readonly SiteEntity[]
  /** Accessible name of the grid, e.g. "Acme / Athens-DC entities". */
  label: string
  /** Cells per row; the grid wraps a kind's entities into rows of this width. */
  columns?: number
  selectedId?: string | null
  onSelect?: (entity: SiteEntity) => void
  className?: string
}

const cellLabel = (entity: SiteEntity, source: 'mock' | 'http') =>
  [
    entity.name,
    entity.kind,
    STATUS_WORD[entity.status],
    ...(source === 'mock' ? ['mock data'] : []),
  ].join(', ')

/**
 * The interactive cousin of the strip: 20px cells on a 24px pitch, grouped by
 * kind, worst first. A native table with the grid role, one tab stop (roving
 * tabindex): arrows move cell to cell, Home/End go to the row's ends, PageUp
 * and PageDown between groups. The 24px pitch is what meets WCAG 2.5.8 here,
 * so cells do not grow for coarse pointers.
 */
export function EntityGrid({
  entities,
  label,
  columns = 20,
  selectedId = null,
  onSelect,
  className,
}: EntityGridProps) {
  // Only the data source matters here: which features back the grid does not.
  const { source } = useProvenance([])
  const root = useRef<HTMLTableElement>(null)
  const layout = useMemo(() => buildGridLayout(entities, columns), [entities, columns])
  const [active, setActive] = useState<string | null>(null)

  // Tab stop: the last focused cell while it exists, else the selected cell, else the first.
  const selected = entities.find((entity) => entity.id === selectedId)
  const first = layout.rows[0]?.[0]
  const fallback = selected ?? first
  const tabStop =
    active && layout.position.has(active) ? active : fallback ? entityKey(fallback) : null

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.metaKey || event.shiftKey) return
    const from = layout.position.get(event.currentTarget.dataset.key ?? '')
    const next = from && moveTo(layout, from, event.key, event.ctrlKey)
    if (!next) return
    event.preventDefault()
    // The DOM mirrors the layout row for row, so a position is also a DOM address.
    root.current
      ?.querySelectorAll('tr')
      .item(next.row)
      ?.querySelectorAll<HTMLButtonElement>('button')
      .item(next.col)
      ?.focus()
  }

  if (layout.rows.length === 0) return null

  return (
    <table
      ref={root}
      // The APG data-grid pattern: a native table promoted to a grid keeps real rows and cells.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
      role="grid"
      aria-label={label}
      className={className}
    >
      {layout.groups.map((group, groupIndex) => {
        const { short, name } = KIND_LABEL[group.kind]
        const count = group.rows.reduce((sum, row) => sum + row.length, 0)
        return (
          <tbody key={group.kind} aria-label={`${name}, ${count}`}>
            {group.rows.map((row, rowIndex) => {
              // A 12px break before each group after the first, on top of the 4px between rows.
              const gap = groupIndex > 0 && rowIndex === 0
              return (
                <tr key={group.firstRow + rowIndex}>
                  {rowIndex === 0 ? (
                    <th
                      scope="rowgroup"
                      rowSpan={group.rows.length}
                      aria-label={name}
                      className={cn(
                        'type-label w-8 pr-2 text-left align-top text-fg-faint',
                        gap ? 'pt-4' : 'pt-1',
                      )}
                    >
                      {short}
                    </th>
                  ) : null}
                  {row.map((entity) => {
                    const key = entityKey(entity)
                    const description = cellLabel(entity, source)
                    const isSelected = entity.id === selectedId
                    return (
                      <td
                        key={key}
                        aria-selected={isSelected}
                        className={cn('px-0.5 pb-0.5', gap ? 'pt-3.5' : 'pt-0.5')}
                      >
                        <button
                          type="button"
                          data-key={key}
                          tabIndex={key === tabStop ? 0 : -1}
                          aria-label={description}
                          title={description}
                          onFocus={() => setActive(key)}
                          onClick={() => onSelect?.(entity)}
                          onKeyDown={onKeyDown}
                          className={cn(
                            'flex size-5 items-center justify-center rounded-sm border border-border',
                            isSelected
                              ? 'bg-primary-tint outline-2 outline-primary'
                              : 'hover:bg-hover',
                          )}
                        >
                          <EntityGlyph status={entity.status} />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        )
      })}
    </table>
  )
}

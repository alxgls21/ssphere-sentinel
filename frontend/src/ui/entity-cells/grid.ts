import type { EntityKind, SiteEntity } from '@/api/types'
import { entityKey, worstFirst } from './entities'

/** Groups appear in this order whatever order the entities arrive in. */
const KIND_ORDER: readonly EntityKind[] = ['server', 'container', 'target', 'device']

export const KIND_LABEL: Record<EntityKind, { short: string; name: string }> = {
  server: { short: 'SRV', name: 'Servers' },
  container: { short: 'CTR', name: 'Containers' },
  target: { short: 'NET', name: 'Network targets' },
  device: { short: 'DEV', name: 'Devices' },
}

export interface GridPos {
  /** Index into the layout's flat list of rows (rows of every group, top to bottom). */
  row: number
  col: number
}

export interface GridGroup {
  kind: EntityKind
  /** Index of the group's first row in the flat list. */
  firstRow: number
  rows: SiteEntity[][]
}

export interface GridLayout {
  groups: GridGroup[]
  /** Every row of every group, in reading order. The DOM mirrors this exactly. */
  rows: SiteEntity[][]
  position: Map<string, GridPos>
}

/**
 * Groups entities by kind, worst first inside each group, and wraps every
 * group into rows of `columns` cells. Keyboard movement is computed on this
 * model (not on pixels), so it behaves the same at any width.
 */
export function buildGridLayout(entities: readonly SiteEntity[], columns: number): GridLayout {
  const width = Math.max(1, Math.floor(columns))
  const groups: GridGroup[] = []
  const rows: SiteEntity[][] = []
  const position = new Map<string, GridPos>()

  for (const kind of KIND_ORDER) {
    const members = worstFirst(entities.filter((entity) => entity.kind === kind))
    if (members.length === 0) continue
    const group: GridGroup = { kind, firstRow: rows.length, rows: [] }
    for (let start = 0; start < members.length; start += width) {
      const row = members.slice(start, start + width)
      row.forEach((entity, col) => position.set(entityKey(entity), { row: rows.length, col }))
      group.rows.push(row)
      rows.push(row)
    }
    groups.push(group)
  }
  return { groups, rows, position }
}

/**
 * Where a navigation key leads from `from`: arrows move one cell (Up and Down
 * keep the column, clamped to the shorter row, and stop at the grid's top and
 * bottom), Home and End go to the row's ends (with Ctrl, the grid's first and
 * last cell), PageUp and PageDown to the first cell of the previous and next
 * group. Returns `from` when the move runs out of grid and null for keys this
 * grid does not handle.
 */
export function moveTo(
  layout: GridLayout,
  from: GridPos,
  key: string,
  ctrl = false,
): GridPos | null {
  const current = layout.rows[from.row]
  if (!current) return null
  if (ctrl && key !== 'Home' && key !== 'End') return null

  const at = (row: number, col: number): GridPos => {
    const target = layout.rows[row]
    return target ? { row, col: Math.max(0, Math.min(col, target.length - 1)) } : from
  }
  const group = layout.groups.findLastIndex((candidate) => candidate.firstRow <= from.row)

  switch (key) {
    case 'ArrowRight':
      return at(from.row, from.col + 1)
    case 'ArrowLeft':
      return at(from.row, from.col - 1)
    case 'ArrowDown':
      return at(from.row + 1, from.col)
    case 'ArrowUp':
      return at(from.row - 1, from.col)
    case 'Home':
      return ctrl ? at(0, 0) : at(from.row, 0)
    case 'End':
      return ctrl ? at(layout.rows.length - 1, Infinity) : at(from.row, Infinity)
    case 'PageDown': {
      const next = layout.groups[group + 1]
      return next ? at(next.firstRow, 0) : from
    }
    case 'PageUp': {
      const previous = layout.groups[group - 1]
      return previous ? at(previous.firstRow, 0) : from
    }
    default:
      return null
  }
}

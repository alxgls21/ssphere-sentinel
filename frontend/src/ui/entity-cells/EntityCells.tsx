import type { SiteEntity } from '@/api/types'
import { EntityGrid } from './EntityGrid'
import { EntityStrip } from './EntityStrip'

interface EntityCellsBase {
  entities: readonly SiteEntity[]
  className?: string
}

export interface EntityStripProps extends EntityCellsBase {
  variant: 'strip'
  /** Most glyphs the row can hold (default 20); past it the strip becomes a bar plus counts. */
  capacity?: number
  /** Accessible-name prefix of the collapsed bar. */
  label?: string
}

export interface EntityGridProps extends EntityCellsBase {
  variant: 'grid'
  /** Accessible name of the grid. */
  label: string
  /** Cells per row (default 20). */
  columns?: number
  selectedId?: string | null
  onSelect?: (entity: SiteEntity) => void
}

export type EntityCellsProps = EntityStripProps | EntityGridProps

/**
 * One glyph cell per entity: the Customer / Site health grammar.
 *
 *   strip  decorative, inside an interactive row (name that row with describeEntities)
 *   grid   interactive ARIA grid for screens with room (Servers, Docker, Customers & Sites)
 */
export function EntityCells(props: EntityCellsProps) {
  if (props.variant === 'strip') {
    return (
      <EntityStrip
        entities={props.entities}
        capacity={props.capacity}
        label={props.label}
        className={props.className}
      />
    )
  }
  return (
    <EntityGrid
      entities={props.entities}
      label={props.label}
      columns={props.columns}
      selectedId={props.selectedId}
      onSelect={props.onSelect}
      className={props.className}
    />
  )
}

import { describe, expect, it } from 'vitest'
import type { EntityKind, HealthStatus, SiteEntity } from '@/api/types'
import { entityKey } from './entities'
import { buildGridLayout, moveTo, type GridPos } from './grid'

const entity = (id: string, kind: EntityKind, status: HealthStatus = 'healthy'): SiteEntity => ({
  id,
  kind,
  name: id,
  status,
})

// Arrives scrambled on purpose: kinds interleaved, statuses unsorted.
const entities: SiteEntity[] = [
  entity('t1', 'target'),
  entity('s1', 'server'),
  entity('s2', 'server', 'critical'),
  entity('c1', 'container'),
  entity('s3', 'server', 'warning'),
  entity('s4', 'server'),
  entity('t2', 'target', 'critical'),
  entity('s5', 'server'),
  entity('c2', 'container', 'idle'),
  entity('t3', 'target'),
  entity('t4', 'target'),
]

const ids = (rows: SiteEntity[][]) => rows.map((row) => row.map((e) => e.id))

describe('buildGridLayout', () => {
  const layout = buildGridLayout(entities, 3)

  it('groups by kind in a fixed order and skips kinds with no members', () => {
    expect(layout.groups.map((group) => group.kind)).toEqual(['server', 'container', 'target'])
  })

  it('sorts each group worst first and wraps it into rows of the column count', () => {
    expect(ids(layout.rows)).toEqual([
      ['s2', 's3', 's1'],
      ['s4', 's5'],
      ['c2', 'c1'],
      ['t2', 't1', 't3'],
      ['t4'],
    ])
  })

  it('records where each group starts and where every entity sits', () => {
    expect(layout.groups.map((group) => group.firstRow)).toEqual([0, 2, 3])
    expect(layout.position.get(entityKey(entity('s3', 'server')))).toEqual({ row: 0, col: 1 })
    expect(layout.position.get(entityKey(entity('t4', 'target')))).toEqual({ row: 4, col: 0 })
  })

  it('keys by kind and id, so equal ids in different kinds stay apart', () => {
    const twin = buildGridLayout([entity('1', 'server'), entity('1', 'target')], 4)
    expect(twin.position.size).toBe(2)
  })

  it('never makes a zero-width row', () => {
    expect(buildGridLayout([entity('a', 'server'), entity('b', 'server')], 0).rows).toHaveLength(2)
  })

  it('is empty for no entities', () => {
    expect(buildGridLayout([], 5).rows).toEqual([])
  })
})

describe('moveTo', () => {
  // rows: [s2 s3 s1] [s4 s5] [c1 c2] [t2 t1 t3] [t4]
  const layout = buildGridLayout(entities, 3)
  const at = (row: number, col: number): GridPos => ({ row, col })

  it('moves one cell with Left and Right and stops at the ends of the row', () => {
    expect(moveTo(layout, at(0, 0), 'ArrowRight')).toEqual(at(0, 1))
    expect(moveTo(layout, at(0, 2), 'ArrowRight')).toEqual(at(0, 2))
    expect(moveTo(layout, at(0, 1), 'ArrowLeft')).toEqual(at(0, 0))
    expect(moveTo(layout, at(0, 0), 'ArrowLeft')).toEqual(at(0, 0))
    expect(moveTo(layout, at(1, 1), 'ArrowRight')).toEqual(at(1, 1))
  })

  it('moves a row with Up and Down, keeping the column but never past a shorter row', () => {
    expect(moveTo(layout, at(0, 1), 'ArrowDown')).toEqual(at(1, 1))
    expect(moveTo(layout, at(0, 2), 'ArrowDown')).toEqual(at(1, 1))
    expect(moveTo(layout, at(1, 1), 'ArrowUp')).toEqual(at(0, 1))
  })

  it('crosses from one group into the next, and stops at the top and bottom of the grid', () => {
    expect(moveTo(layout, at(1, 0), 'ArrowDown')).toEqual(at(2, 0))
    expect(moveTo(layout, at(2, 0), 'ArrowUp')).toEqual(at(1, 0))
    expect(moveTo(layout, at(0, 0), 'ArrowUp')).toEqual(at(0, 0))
    expect(moveTo(layout, at(4, 0), 'ArrowDown')).toEqual(at(4, 0))
  })

  it('goes to the ends of the row with Home and End', () => {
    expect(moveTo(layout, at(0, 1), 'Home')).toEqual(at(0, 0))
    expect(moveTo(layout, at(0, 1), 'End')).toEqual(at(0, 2))
    expect(moveTo(layout, at(1, 0), 'End')).toEqual(at(1, 1))
  })

  it('goes to the first and last cell of the grid with Ctrl+Home and Ctrl+End', () => {
    expect(moveTo(layout, at(3, 2), 'Home', true)).toEqual(at(0, 0))
    expect(moveTo(layout, at(0, 0), 'End', true)).toEqual(at(4, 0))
  })

  it('jumps between groups with PageDown and PageUp, landing on the first cell', () => {
    expect(moveTo(layout, at(1, 1), 'PageDown')).toEqual(at(2, 0))
    expect(moveTo(layout, at(2, 1), 'PageDown')).toEqual(at(3, 0))
    expect(moveTo(layout, at(3, 2), 'PageUp')).toEqual(at(2, 0))
    expect(moveTo(layout, at(2, 1), 'PageUp')).toEqual(at(0, 0))
  })

  it('stays put when there is no group to jump to', () => {
    expect(moveTo(layout, at(4, 0), 'PageDown')).toEqual(at(4, 0))
    expect(moveTo(layout, at(1, 1), 'PageUp')).toEqual(at(1, 1))
  })

  it('leaves keys it does not own alone, including Ctrl+arrows', () => {
    expect(moveTo(layout, at(0, 0), 'a')).toBeNull()
    expect(moveTo(layout, at(0, 0), 'Enter')).toBeNull()
    expect(moveTo(layout, at(0, 0), 'ArrowRight', true)).toBeNull()
  })

  it('ignores a position that is not in the layout', () => {
    expect(moveTo(layout, at(99, 0), 'ArrowRight')).toBeNull()
  })
})

describe('buildGridLayout with an offline server', () => {
  const offline: SiteEntity = { ...entity('s-off', 'server', 'critical'), offline: true }

  it('puts an offline server after the critical ones and before the warnings', () => {
    const layout = buildGridLayout(
      [
        entity('s1', 'server'),
        entity('s2', 'server', 'warning'),
        offline,
        entity('s3', 'server', 'critical'),
      ],
      4,
    )
    expect(ids(layout.rows)).toEqual([['s3', 's-off', 's2', 's1']])
  })

  it('keeps the entities of equal state in the order they came in', () => {
    const second: SiteEntity = { ...offline, id: 's-off-2' }
    const layout = buildGridLayout([second, offline, entity('c', 'server', 'critical')], 4)
    expect(ids(layout.rows)).toEqual([['c', 's-off-2', 's-off']])
  })
})

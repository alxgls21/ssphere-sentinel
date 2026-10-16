import type { StatusCounts } from '@/api/types'
import { formatInteger } from './format'
import { DISPLAY_ORDER, displayCounts, type DisplayStatus } from './status'

/**
 * Text twins of the visual marks (SegmentedBar, CellMeter), built from block
 * characters so a row can be pasted into a ticket and still read. The
 * characters live only in strings: font subsets carry no block elements, so
 * the marks themselves are SVG/DOM.
 */

/** Same 20 x 5% grid as CellMeter. */
export const BLOCK_CELLS = 20

/**
 * One distinct character per status: denser means worse, healthy is the quiet low bar.
 * Offline is the diagonal pair, the slash of its glyph, and follows critical.
 */
const BAR_CHAR: Record<DisplayStatus, string> = {
  critical: '█',
  offline: '▞',
  warning: '▓',
  unknown: '▒',
  idle: '░',
  healthy: '▁',
}

const METER_FILLED = '█'
const METER_EMPTY = '░'
/** A bar with nothing to show (zero total): neither a status nor an empty meter cell. */
const BAR_NONE = '·'

/** Spoken names, shared with ui/status (a test keeps the two in step). */
const SPOKEN: Record<DisplayStatus, string> = {
  critical: 'critical',
  offline: 'offline',
  warning: 'warning',
  unknown: 'unknown',
  idle: 'idle',
  healthy: 'ok',
}

export function spokenStatus(status: DisplayStatus): string {
  return SPOKEN[status]
}

export interface StatusCount {
  status: DisplayStatus
  count: number
}

/**
 * Statuses with at least one member, worst first: the order every bar and count
 * list uses. Offline members are listed apart from the critical they are part of.
 */
export function nonZeroCounts(counts: StatusCounts): StatusCount[] {
  const shown = displayCounts(counts)
  return DISPLAY_ORDER.filter((status) => shown[status] > 0).map((status) => ({
    status,
    count: shown[status],
  }))
}

/** "1 critical, 1 offline, 2 warning, 13 ok", worst first; "none" when there is nothing to count. */
export function describeCounts(counts: StatusCounts): string {
  const parts = nonZeroCounts(counts).map(
    ({ status, count }) => `${formatInteger(count)} ${SPOKEN[status]}`,
  )
  return parts.length > 0 ? parts.join(', ') : 'none'
}

interface Share {
  status: DisplayStatus
  /** Exact share of the cells before rounding. */
  ideal: number
  cells: number
}

/**
 * A SegmentedBar as exactly `cells` characters, worst first. Mirrors the
 * visual rules: every non-zero status keeps at least one cell (the 3px
 * minimum), the rest is shared proportionally by largest remainder.
 */
export function blockBar(counts: StatusCounts, cells = BLOCK_CELLS): string {
  const size = Math.max(0, Math.floor(cells))
  const present = nonZeroCounts(counts).slice(0, size)
  if (present.length === 0) return BAR_NONE.repeat(size)

  const total = present.reduce((sum, { count }) => sum + count, 0)
  const shares: Share[] = present.map(({ status, count }) => {
    const ideal = (count / total) * size
    return { status, ideal, cells: Math.max(1, Math.floor(ideal)) }
  })

  const surplus = (share: Share) => share.cells - share.ideal
  let diff = size - shares.reduce((sum, share) => sum + share.cells, 0)
  while (diff !== 0) {
    // Grow the entry furthest below its share (worse status wins a tie); shrink the one
    // furthest above it (healthier status wins a tie), never below one cell.
    const pick =
      diff > 0
        ? [...shares].sort((a, b) => surplus(a) - surplus(b))[0]
        : [...shares]
            .reverse()
            .filter((share) => share.cells > 1)
            .sort((a, b) => surplus(b) - surplus(a))[0]
    if (!pick) break
    pick.cells += Math.sign(diff)
    diff -= Math.sign(diff)
  }

  return shares.map(({ status, cells: n }) => BAR_CHAR[status].repeat(n)).join('')
}

/**
 * How many cells of a `cells`-cell meter are lit: a cell is filled once the
 * percentage reaches its upper bound minus half a cell, so 82% lights 16 of 20
 * (up to 80%) and 97.5% lights all of them.
 */
export function filledCells(percent: number | null, cells = BLOCK_CELLS): number {
  if (percent === null || !Number.isFinite(percent) || cells <= 0) return 0
  const step = 100 / cells
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.min(cells, Math.floor((clamped + step / 2) / step))
}

/** A CellMeter as exactly `cells` characters: filled blocks, then empty ones (all empty if null). */
export function blockMeter(percent: number | null, cells = BLOCK_CELLS): string {
  const size = Math.max(0, Math.floor(cells))
  const filled = filledCells(percent, size)
  return METER_FILLED.repeat(filled) + METER_EMPTY.repeat(size - filled)
}

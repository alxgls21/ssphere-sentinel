import { BLOCK_CELLS, filledCells } from '@/lib/blocks'
import { cn } from '@/lib/cn'
import { formatPercent } from '@/lib/format'
import { resourceLevel, type ResourceLevel } from '@/lib/thresholds'
import { StatusGlyph, STATUS_NAME } from '@/ui/status'

/**
 * Fill is cyan (never "OK green") below the warning threshold, then the
 * warning and critical hues. The unfilled track is the 12% tint of the same
 * hue, so the whole bar changes color together when a threshold is crossed.
 */
const FILL: Record<ResourceLevel, string> = {
  ok: 'bg-primary',
  warn: 'bg-warning',
  crit: 'bg-critical',
}

const TRACK: Record<ResourceLevel, string> = {
  ok: 'bg-primary-tint',
  warn: 'bg-warning-tint',
  crit: 'bg-critical-tint',
}

interface CellMeterProps {
  /** 0-100. null = no sample: empty cells and "no data". */
  percent: number | null
  /** Accessible name, e.g. "CPU of api-02". */
  label: string
  cells?: number
  className?: string
}

/**
 * Utilisation as quantised cells (20 x 5% by default), read like a terminal
 * progress bar. Past a threshold a triangle or diamond follows the cells and
 * the value is printed on the right, so color is never the only channel.
 * The glyph slot is always reserved: cells line up from row to row.
 *
 * The drawing is aria-hidden and a visually hidden native <meter> carries the
 * semantics (value, range, "warning"), because cells cannot be a styled <meter>.
 */
export function CellMeter({ percent, label, cells = BLOCK_CELLS, className }: CellMeterProps) {
  const value =
    percent !== null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null
  const level = value === null ? 'ok' : resourceLevel(value)
  const filled = filledCells(value, cells)
  const glyph = level === 'warn' ? 'warning' : level === 'crit' ? 'critical' : null

  // Printed like the rest of the console: whole numbers from 10%, one decimal below.
  const decimals = value !== null && value < 10 ? 1 : 0

  return (
    <span className={cn('relative flex items-center gap-2', className)}>
      {value === null ? (
        <span className="sr-only">{label}: no data</span>
      ) : (
        <meter
          className="sr-only"
          min={0}
          max={100}
          value={value}
          aria-label={label}
          aria-valuetext={`${value.toFixed(decimals)} percent${glyph ? `, ${STATUS_NAME[glyph]}` : ''}`}
        />
      )}
      <span aria-hidden="true" className="flex min-w-0 flex-1 gap-0.5">
        {Array.from({ length: cells }, (_, index) => (
          <span
            key={index}
            data-cell={index < filled ? 'filled' : 'empty'}
            className={cn(
              'h-2 min-w-0.5 flex-1 rounded-sm',
              index < filled ? FILL[level] : TRACK[level],
            )}
          />
        ))}
      </span>
      <span aria-hidden="true" className="size-2.5 shrink-0">
        {glyph ? <StatusGlyph status={glyph} size={10} /> : null}
      </span>
      {value === null ? (
        <span aria-hidden="true" className="type-data shrink-0 text-fg-faint">
          no data
        </span>
      ) : (
        <span aria-hidden="true" className="type-data-strong tnum min-w-[4ch] shrink-0 text-right">
          {formatPercent(value, decimals)}
        </span>
      )}
    </span>
  )
}

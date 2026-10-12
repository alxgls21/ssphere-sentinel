import { cn } from '@/lib/cn'
import type { SeriesVisibility } from './useSeriesVisibility'

export type SeriesKeyShape = 'line' | 'rect' | 'diamond'

export interface LegendEntry {
  id: string
  label: string
  /** The legend mirrors the mark: a stroke for lines, a block for columns, a diamond for failed probes. */
  shape: SeriesKeyShape
  /** CSS color of the key: a token reference such as var(--color-primary). */
  color: string
  /** False for a static reference (a threshold line): a key and a label, not a button. */
  toggle?: boolean
}

interface SeriesKeyProps {
  shape: SeriesKeyShape
  color: string
  dimmed?: boolean
}

/**
 * The colored mark beside a legend label. It is SVG so the shape survives
 * forced-colors and print; the label next to it stays in text tokens, because
 * a series hue is illegible as text and identity comes from the mark.
 */
export function SeriesKey({ shape, color, dimmed = false }: SeriesKeyProps) {
  const fill = { fill: color }
  return (
    <svg
      viewBox="0 0 12 10"
      aria-hidden="true"
      focusable="false"
      className={cn('h-2.5 w-3 shrink-0', dimmed && 'opacity-40')}
    >
      {shape === 'line' ? <rect x="0" y="4" width="12" height="2" rx="1" style={fill} /> : null}
      {shape === 'rect' ? <rect x="3" y="0" width="6" height="10" rx="1" style={fill} /> : null}
      {shape === 'diamond' ? <path d="M6 0.5 L11 5 L6 9.5 L1 5 Z" style={fill} /> : null}
    </svg>
  )
}

interface ChartLegendProps {
  entries: readonly LegendEntry[]
  visibility: SeriesVisibility
  className?: string
}

const ENTRY =
  'type-data inline-flex h-6 items-center gap-1.5 rounded-sm px-1 pointer-coarse:h-(--hit)'

/**
 * HTML legend, present for two or more series. Each entry is a toggle button
 * (aria-pressed = visible); Shift-click isolates a series. The hidden state is
 * carried by a struck-through, dimmed label as well as aria-pressed.
 */
export function ChartLegend({ entries, visibility, className }: ChartLegendProps) {
  return (
    <ul
      aria-label="Series"
      className={cn('flex min-w-0 flex-wrap items-center gap-x-1', className)}
    >
      {entries.map((entry) => {
        if (entry.toggle === false) {
          return (
            <li key={entry.id} className={cn(ENTRY, 'text-fg-muted')}>
              <SeriesKey shape={entry.shape} color={entry.color} />
              {entry.label}
            </li>
          )
        }
        const visible = !visibility.hidden.has(entry.id)
        return (
          <li key={entry.id}>
            <button
              type="button"
              aria-pressed={visible}
              title="Click to show or hide. Shift-click to show only this series."
              onClick={(event) =>
                event.shiftKey ? visibility.isolate(entry.id) : visibility.toggle(entry.id)
              }
              className={cn(
                ENTRY,
                'transition-colors duration-(--dur-fast) -outline-offset-2 hover:bg-hover',
                visible ? 'text-fg-muted hover:text-fg' : 'text-fg-faint line-through',
              )}
            >
              <SeriesKey shape={entry.shape} color={entry.color} dimmed={!visible} />
              {entry.label}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

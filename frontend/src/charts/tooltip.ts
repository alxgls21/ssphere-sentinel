/**
 * The DOM tooltip body for every chart: one timestamp, then one row per
 * series at the hovered x. Returned to ECharts as an HTMLElement from the
 * tooltip formatter.
 *
 * Series and target names are untrusted API data, so every string goes in
 * through textContent. There is no innerHTML anywhere in this file.
 */

export type TooltipKey = 'line' | 'rect' | 'diamond'

export interface TooltipRow {
  /** The mark the series is drawn with, so the key mirrors the legend. */
  key: TooltipKey
  /** CSS color of the series (a resolved token). */
  color: string
  value: string
  label: string
  /** A limit the value has passed, in words ("62 ms over warn"): shown under the row beside a warning triangle. */
  flag?: string
}

export interface TooltipContent {
  title: string
  rows: readonly TooltipRow[]
}

function element(tag: 'div' | 'span', className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const KEY_CLASS: Record<TooltipKey, string> = {
  line: 'h-0.5 w-3 rounded-full',
  rect: 'h-2.5 w-1.5 rounded-sm',
  diamond: 'size-2 rotate-45',
}

/** The warning triangle the plot draws over a sample that has passed its limit. */
const FLAG_MARK_CLASS =
  'size-2 justify-self-center bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]'

/**
 * Values lead and labels follow: the value is the strong, right-aligned
 * element in its own column, the series name is secondary beside it. A row
 * whose value has passed a limit says so in words on a line of its own, led by
 * a warning triangle, so the state never rests on color.
 */
export function buildTooltipElement({ title, rows }: TooltipContent): HTMLElement {
  const root = element('div', 'flex min-w-44 flex-col gap-1')
  root.append(element('div', 'type-data text-fg-faint', title))

  const grid = element('div', 'grid grid-cols-[0.75rem_auto_1fr] items-center gap-x-2 gap-y-1')
  for (const row of rows) {
    const key = element('span', `${KEY_CLASS[row.key]} justify-self-center`)
    key.style.backgroundColor = row.color
    grid.append(
      key,
      element('span', 'type-data-strong text-right text-fg', row.value),
      element('span', 'type-data truncate text-fg-muted', row.label),
    )
    if (row.flag) {
      grid.append(
        element('span', FLAG_MARK_CLASS),
        element('span', 'type-data col-span-2 text-fg', row.flag),
      )
    }
  }
  root.append(grid)
  return root
}

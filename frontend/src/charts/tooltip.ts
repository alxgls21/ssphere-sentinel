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

/**
 * Values lead and labels follow: the value is the strong, right-aligned
 * element in its own column, the series name is secondary beside it.
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
  }
  root.append(grid)
  return root
}

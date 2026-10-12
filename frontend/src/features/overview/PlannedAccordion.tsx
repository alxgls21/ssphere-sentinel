import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { StatusGlyph } from '@/ui/status'

interface PlannedAccordionProps {
  /** Number of panels inside, shown in the summary. */
  count: number
  className?: string
  children: ReactNode
}

/**
 * Below the lg breakpoint the PLANNED panels (alerts, events) fold into one
 * collapsed section, so unfinished features never sit above operational data
 * on a small screen. Each panel keeps its own dashed frame and PLANNED chip.
 */
export function PlannedAccordion({ count, className, children }: PlannedAccordionProps) {
  return (
    <details className={cn('group', className)}>
      <summary className="type-label flex h-(--row-h) cursor-pointer list-none items-center gap-2 rounded-sm border border-dashed border-border-strong px-3 text-fg-muted marker:hidden hover:bg-hover [&::-webkit-details-marker]:hidden">
        <StatusGlyph status="planned" size={10} />
        <span>Planned · backend not implemented ({count})</span>
        <span aria-hidden="true" className="ml-auto text-fg-faint group-open:hidden">
          Show
        </span>
        <span aria-hidden="true" className="ml-auto hidden text-fg-faint group-open:inline">
          Hide
        </span>
      </summary>
      <div className="mt-3 grid gap-3">{children}</div>
    </details>
  )
}

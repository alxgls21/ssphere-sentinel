import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface SpecimenProps {
  label: string
  /** How to read it, or the rule it shows. Always visible text: a note never hides in a tooltip. */
  note?: ReactNode
  /** Draw no stage: the specimen brings its own frame (a Panel, a tile). */
  bare?: boolean
  className?: string
  children: ReactNode
}

/** One labelled specimen. The stage is a panel surface, which every component is designed to sit on. */
export function Specimen({ label, note, bare = false, className, children }: SpecimenProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="type-label text-fg-muted">{label}</h3>
      <div className={cn(!bare && 'rounded-sm border border-border bg-panel p-3', className)}>
        {children}
      </div>
      {note ? <p className="type-body max-w-prose text-fg-muted">{note}</p> : null}
    </div>
  )
}

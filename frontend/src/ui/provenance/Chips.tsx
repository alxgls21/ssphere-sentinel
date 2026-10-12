import { cn } from '@/lib/cn'
import { StatusGlyph } from '@/ui/status'

/**
 * Provenance is data, not decoration. MOCK = neutral hatched fill; PLANNED =
 * dashed outline + dotted ring. Neither introduces a hue, and both survive a
 * screenshot.
 */

interface ChipProps {
  className?: string
  title?: string
}

interface MockChipProps extends ChipProps {
  /** "MOCK" instead of "Mock data", for the phone app bar. */
  compact?: boolean
}

/** Global "this is mock data" marker (topbar). */
export function MockChip({
  className,
  compact = false,
  title = 'Demo data: the backend has no read API yet.',
}: MockChipProps) {
  return (
    <span
      title={title}
      className={cn(
        'type-tag bg-hatch inline-flex h-5 items-center rounded-sm border border-border-strong px-1.5 text-fg',
        className,
      )}
    >
      {compact ? 'Mock' : 'Mock data'}
    </span>
  )
}

/** Marks a feature the backend has not implemented. */
export function PlannedChip({
  className,
  title = 'Not implemented in the backend yet. Sample data.',
}: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        'type-tag inline-flex h-5 items-center gap-1 rounded-sm border border-dashed border-border-strong px-1.5 text-fg-muted',
        className,
      )}
    >
      <StatusGlyph status="planned" size={10} />
      Planned
    </span>
  )
}

/** Quiet "mock · 15s" tag for panel headers: data source plus refresh interval. */
export function SourceTag({
  source,
  refreshMs,
  className,
}: {
  source: 'mock' | 'http'
  refreshMs?: number
  className?: string
}) {
  const interval = refreshMs ? ` · ${Math.round(refreshMs / 1000)}s` : ''
  return (
    <span className={cn('type-tag whitespace-nowrap text-fg-faint', className)}>
      {source === 'mock' ? 'mock' : 'live'}
      {interval}
    </span>
  )
}

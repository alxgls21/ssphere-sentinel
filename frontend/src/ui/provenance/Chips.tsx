import {
  AVAILABILITY_WORD,
  AVAILABILITY_WORD_SHORT,
  type Availability,
  type Provenance,
} from '@/config/features'
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
  /** "Demo" instead of "Demo data", for the phone app bar. */
  compact?: boolean
}

/** Global "this is demo data" marker (topbar). */
export function MockChip({
  className,
  compact = false,
  title = 'Demo data: sample servers and metrics, not read from the backend.',
}: MockChipProps) {
  return (
    <span
      title={title}
      className={cn(
        'type-tag bg-hatch inline-flex h-5 items-center rounded-sm border border-border-strong px-1.5 text-fg',
        className,
      )}
    >
      {compact ? 'Demo' : 'Demo data'}
    </span>
  )
}

/** Marks a feature the backend has not implemented. */
export function PlannedChip({
  className,
  title = 'Not implemented in the backend yet. Sample data.',
}: ChipProps) {
  return <FeatureChip availability="planned" className={className} title={title} />
}

/**
 * Where a feature stands when its figures are not real: PLANNED (the backend
 * does not implement it), NOT CONNECTED (the backend may have it, but the console
 * does not read it yet), NEEDS SETUP (connected, but its setup is confirmed
 * missing), UNKNOWN. Same dashed outline and ring for all: the figures beside it
 * are samples or absent.
 */
export function FeatureChip({
  availability,
  className,
  title,
  compact = false,
}: ChipProps & {
  availability: Exclude<Availability, 'live'>
  /** The short word ("Demo", "Setup"), for a header with little room (a tile). The title carries the rest. */
  compact?: boolean
}) {
  return (
    <span
      title={title}
      className={cn(
        'type-tag inline-flex h-5 items-center gap-1 rounded-sm border border-dashed border-border-strong px-1.5 whitespace-nowrap text-fg-muted',
        className,
      )}
    >
      <StatusGlyph status="planned" size={10} />
      {(compact ? AVAILABILITY_WORD_SHORT : AVAILABILITY_WORD)[availability]}
    </span>
  )
}

const SOURCE_WORD: Record<Provenance, string> = {
  live: 'live',
  mock: 'mock',
  unknown: 'unverified',
}

/** Quiet "mock · 15s" tag for panel headers: what the figures are (live, mock, unverified) plus the refresh interval. */
export function SourceTag({
  source,
  refreshMs,
  className,
}: {
  source: Provenance
  refreshMs?: number
  className?: string
}) {
  const interval = refreshMs ? ` · ${Math.round(refreshMs / 1000)}s` : ''
  return (
    <span className={cn('type-tag whitespace-nowrap text-fg-faint', className)}>
      {SOURCE_WORD[source]}
      {interval}
    </span>
  )
}

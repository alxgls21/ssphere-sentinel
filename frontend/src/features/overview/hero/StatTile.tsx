import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { FeatureId } from '@/config/features'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { PROVENANCE_SPOKEN } from '@/config/features'
import { useProvenance } from '@/hooks/useProvenance'
import type { ResourceStatus } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { formatInteger } from '@/lib/format'
import { Button } from '@/ui/controls'
import { FeatureChip, PlannedChip, SourceTag } from '@/ui/provenance/Chips'
import { Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { useViewTo } from '@/app/viewSearch'

export interface TileContent {
  /** After "Label: " in the link's accessible name: "15 of 16 online, 1 critical, 2 warning". */
  summary: string
  /** The headline number. */
  value: number
  /** Muted beside the value: "/16 online", "in inventory", "sample". */
  unit: string
  /** The line of glyph-coded counts. */
  detail: ReactNode
  /** The composition bar, or a PlannedBar. */
  bar: ReactNode
  /** Right of the value (network targets: the success-rate sparkline). Decorative. */
  trend?: ReactNode
}

export interface StatTileProps {
  /** Shown uppercase in the label row and used as the start of the accessible name. */
  label: string
  /**
   * The backend features behind the numbers. Required on purpose, like Panel:
   * it picks the one provenance marker (a quiet 'mock' tag, or PLANNED with a
   * dashed frame and no link when every feature is unimplemented).
   */
  features: FeatureId | readonly FeatureId[]
  /** Where the whole tile links. Unused while the tile is planned. */
  to: string
  status: ResourceStatus
  /** Undefined until there is data. */
  content?: TileContent
  /** The numbers are old or failed to refresh: dim them, say so in the name. */
  stale?: boolean
  onRetry?: () => void
  /** Grid placement from the strip. */
  className?: string
}

/**
 * Counts how many times a value has changed, to restart a CSS flash. The first
 * value after loading is not a change, and an unchanged value never flashes.
 */
function useFlashes(value: number | null): number {
  const [seen, setSeen] = useState({ value, flashes: 0 })
  if (seen.value !== value) {
    setSeen({ value, flashes: seen.value === null ? seen.flashes : seen.flashes + 1 })
  }
  return seen.flashes
}

/** The dashed stand-in for a bar the backend cannot fill yet. Decorative: the text says why. */
export function PlannedBar() {
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 rounded-sm border border-dashed border-border-strong"
    />
  )
}

/**
 * One domain headline: label and provenance marker, value with its unit,
 * glyph-coded counts, a 6px bar. Health lives in the glyphs and the bar; the
 * value stays in text color.
 *
 * Implemented domains are ONE link to their screen, named in full
 * ("Servers: 15 of 16 online, 1 critical, 2 warning, mock data"). Planned
 * ones get a dashed frame, muted values and no link: nothing to open yet.
 */
export function StatTile({
  label,
  features,
  to,
  status,
  content,
  stale = false,
  onRetry,
  className,
}: StatTileProps) {
  const viewTo = useViewTo()
  const { provenance, planned, availability, note } = useProvenance(features)
  const loading = status === 'loading'
  const showSkeleton = useDelayedFlag(loading)
  const flashes = useFlashes(content?.value ?? null)

  const frame = cn(
    'flex h-full min-w-0 flex-col gap-1.5 rounded-sm border bg-panel p-3',
    planned ? 'border-dashed border-border-strong' : 'border-border',
    className,
  )

  const head = (
    <div className="flex h-5 items-center justify-between gap-2">
      <span className="type-label truncate text-fg-muted">{label}</span>
      {planned ? (
        <>
          <span className="sr-only">
            {availability === 'planned'
              ? 'Planned, not implemented'
              : availability === 'needs-configuration'
                ? 'Connected, but its setup is missing'
                : 'Not connected to the console yet'}
          </span>
          <span aria-hidden="true">
            {availability === 'planned' ? (
              <PlannedChip />
            ) : (
              <FeatureChip availability={availability ?? 'unknown'} title={note} compact />
            )}
          </span>
        </>
      ) : (
        <SourceTag source={provenance} />
      )}
    </div>
  )

  if (status === 'error') {
    return (
      <div className={frame} data-planned={planned || undefined}>
        {head}
        <p role="alert" className="type-data text-fg-muted">
          Could not load {label}
        </p>
        {onRetry ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRetry}
            aria-label={`Retry loading ${label}`}
            className="self-start"
          >
            Retry
          </Button>
        ) : null}
      </div>
    )
  }

  const body = (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-1.5', planned && 'text-fg-muted')}>
      {content ? (
        <>
          <div className="flex h-8 min-w-0 items-center gap-1">
            <span
              // A new key restarts the flash for each change, never for an unchanged value.
              key={flashes}
              className={cn(
                'type-kpi tnum rounded-sm',
                planned ? 'text-fg-muted' : 'text-fg',
                flashes > 0 && 'animate-flash',
              )}
            >
              {formatInteger(content.value)}
            </span>
            <span className="type-data min-w-0 truncate text-fg-muted">{content.unit}</span>
            {content.trend ? (
              // The sparkline's end dot leaves 5px of its own margin, so 4px of it may hang into the padding.
              <span
                aria-hidden="true"
                className={cn('-mr-1 ml-auto shrink-0', stale && 'opacity-60')}
              >
                {content.trend}
              </span>
            ) : null}
          </div>
          <div className="flex h-4 items-center gap-2">
            {content.detail}
            {stale ? <StatusTag status="warning" word="STALE" className="ml-auto" /> : null}
          </div>
          {/* Only marks dim when stale: text keeps its contrast, and the STALE tag carries the state. */}
          <div className={cn('mt-auto', stale && 'opacity-60')}>{content.bar}</div>
        </>
      ) : showSkeleton ? (
        <>
          <Skeleton className="my-1 h-6 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-auto h-1.5 w-full" />
        </>
      ) : null}
    </div>
  )

  if (planned) {
    return (
      <div className={frame} data-planned="true" aria-busy={loading || undefined}>
        {head}
        {body}
      </div>
    )
  }

  const spoken = [
    `${label}: ${content ? content.summary : 'loading'}`,
    PROVENANCE_SPOKEN[provenance],
    stale ? 'stale' : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Link
      to={viewTo(to)}
      aria-label={spoken}
      aria-busy={loading || undefined}
      className={cn(
        frame,
        'transition-colors duration-(--dur-fast) hover:border-border-strong focus-visible:-outline-offset-2',
      )}
    >
      {head}
      {body}
    </Link>
  )
}

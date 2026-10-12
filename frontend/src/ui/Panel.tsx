import { useId, type ReactNode, type Ref } from 'react'
import { usePrefs } from '@/app/prefs'
import type { FeatureId } from '@/config/features'
import { useDelayedFlag } from '@/hooks/useDelayedFlag'
import { useProvenance } from '@/hooks/useProvenance'
import { useStale } from '@/hooks/useStale'
import type { ResourceStatus } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { formatTime } from '@/lib/format'
import { PlannedChip, SourceTag } from '@/ui/provenance/Chips'
import { ErrorState } from '@/ui/states/ErrorState'
import { StatusTag } from '@/ui/status'
import { SkeletonRows } from '@/ui/states/Skeleton'

export interface PanelProps {
  title: string
  /**
   * Which backend features this panel's data comes from. Required on purpose:
   * it drives the mock / PLANNED markers, so an unlabelled panel cannot compile.
   */
  features: FeatureId | readonly FeatureId[]
  /** Panel number [n]: shown as a keycap and reached with the digit key. */
  index?: number
  count?: ReactNode
  /** Scope chip: NOW for state panels, the range (1h) for range panels. */
  scope?: string
  /** Filter chips or tabs, right side of the header. */
  actions?: ReactNode
  /** Shown in the quiet "mock · 15s" tag. */
  refreshMs?: number

  /* Data state (pass a useResource / useLiveResource result). */
  status?: ResourceStatus
  /** A reload is in flight while earlier content stays visible. */
  refreshing?: boolean
  /** The data on screen is older than the stale threshold. */
  stale?: boolean
  error?: Error | null
  updatedAt?: number | null
  onRetry?: () => void
  /** Success, but nothing to show: renders `empty` instead of children. */
  isEmpty?: boolean
  empty?: ReactNode
  /** Loading placeholder; defaults to skeleton rows. Appears only after 150 ms. */
  skeleton?: ReactNode

  footer?: ReactNode
  /** The footer sentence of a planned panel ("Alert engine not implemented."), after "Sample data." */
  plannedNote?: string
  /** No body padding (tables, lists that run full-bleed). */
  flush?: boolean
  id?: string
  className?: string
  bodyClassName?: string
  ref?: Ref<HTMLElement>
  children?: ReactNode
}

/**
 * The universal container: 1px frame, 2px radius, 32px header, body, optional
 * footer. Header and frame never move: loading, empty, error and stale states
 * replace the body only.
 *
 * Provenance chrome is derived (not hand-placed): a quiet "mock · 15s" tag
 * always, plus a dashed frame, PLANNED chip and footer sentence when every
 * backing feature is unimplemented in the backend.
 */
export function Panel({
  title,
  features,
  index,
  count,
  scope,
  actions,
  refreshMs,
  status = 'success',
  refreshing = false,
  stale: staleProp = false,
  error = null,
  updatedAt = null,
  onRetry,
  isEmpty = false,
  empty,
  skeleton,
  footer,
  plannedNote,
  flush = false,
  id,
  className,
  bodyClassName,
  ref,
  children,
}: PanelProps) {
  const titleId = useId()
  const descId = useId()
  const { source, planned, note } = useProvenance(features)
  const { tz } = usePrefs()
  // A panel also judges its own data: pass `stale` to force it, otherwise it follows `updatedAt`.
  const ownStale = useStale(updatedAt)
  const stale = staleProp || ownStale
  const loading = status === 'loading'
  const showSkeleton = useDelayedFlag(loading)
  // Only a transient reload dims the body. Persistent staleness is the STALE tag (shape + word):
  // 60% opacity would take small text and status text below AA exactly when it must be read.
  const dimmed = refreshing

  const lastGood = updatedAt
    ? `Showing data from ${formatTime(updatedAt, tz)}${tz === 'utc' ? 'Z' : ''}`
    : undefined

  let body: ReactNode
  if (status === 'error') {
    body = (
      <ErrorState
        title={`Could not load ${title.toLowerCase()}`}
        message={error?.message}
        onRetry={onRetry}
      />
    )
  } else if (loading) {
    body = (
      <>
        <span className="sr-only">Loading {title}</span>
        {showSkeleton ? (skeleton ?? <SkeletonRows />) : null}
      </>
    )
  } else if (isEmpty) {
    body = empty
  } else {
    body = children
  }

  const footerSentence = planned
    ? `Sample data. ${plannedNote ?? 'Not implemented in the backend yet.'}`
    : null
  const hasFooter = footer != null || footerSentence != null

  return (
    <section
      ref={ref}
      id={id}
      aria-labelledby={titleId}
      aria-busy={loading || undefined}
      aria-keyshortcuts={index ? String(index) : undefined}
      aria-describedby={planned ? descId : undefined}
      tabIndex={-1}
      data-panel={index ?? ''}
      data-planned={planned || undefined}
      className={cn(
        '@container flex min-h-0 min-w-0 flex-col rounded-sm border bg-panel transition-colors duration-(--dur-fast)',
        planned ? 'border-dashed border-border-strong' : 'border-border hover:border-border-strong',
        'focus-within:border-primary-line focus-visible:outline-2 focus-visible:-outline-offset-2',
        className,
      )}
    >
      {planned ? (
        <span id={descId} className="sr-only">
          Sample data. {note}
        </span>
      ) : null}
      <header className="flex min-h-(--panel-head) shrink-0 items-center gap-x-2 gap-y-1 border-b border-border px-3 @max-sm:flex-wrap @max-sm:py-1">
        {index ? (
          <kbd aria-hidden="true" className="type-kbd text-fg-faint">
            [{index}]
          </kbd>
        ) : null}
        <h2 id={titleId} className="type-label truncate text-fg-muted">
          {title}
        </h2>
        {count != null ? (
          <span className="type-tag rounded-sm bg-hover px-1.5 py-0.5 text-fg-muted">{count}</span>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-2 @max-sm:w-full @max-sm:justify-end">
          {/* Redundant with the title on a narrow panel, so it gives way before the title truncates. */}
          {scope ? <span className="type-tag hidden text-fg-faint @sm:inline">{scope}</span> : null}
          {actions}
          {stale ? <StatusTag status="warning" word="STALE" variant="tag" /> : null}
          {planned ? <PlannedChip /> : <SourceTag source={source} refreshMs={refreshMs} />}
        </div>
      </header>

      {status === 'success' && error ? (
        <ErrorState banner title="Refresh failed" lastGood={lastGood} onRetry={onRetry} />
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1 transition-opacity duration-(--dur-base)',
          !flush && 'p-3',
          planned && 'text-fg-muted',
          dimmed && 'opacity-60',
          bodyClassName,
        )}
      >
        {body}
      </div>

      {hasFooter ? (
        <footer
          className={cn(
            'type-data flex shrink-0 items-center gap-3 border-t border-border px-3 text-fg-faint',
            planned ? 'min-h-6' : 'min-h-7',
          )}
        >
          {footer}
          {footerSentence ? (
            <span className={cn('truncate', footer != null && 'ml-auto')}>{footerSentence}</span>
          ) : null}
        </footer>
      ) : null}
    </section>
  )
}

import type { EngineStatus } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import type { Resource } from '@/hooks/useResource'
import { cn } from '@/lib/cn'
import { EMPTY, formatAge, formatClock } from '@/lib/format'
import {
  ENGINE_HEALTH,
  ENGINE_WORD,
  engineCaveat,
  engineNeedsAttention,
  engineSentence,
} from '@/lib/incidents'
import { Button } from '@/ui/controls'
import { STATUS_FRAME, STATUS_TINT, StatusTag } from '@/ui/status'

/** "last success 5s ago · last attempt 5s ago · cycle 120 ms": what the engine itself recorded. */
function facts(status: EngineStatus, nowMs: number): string[] {
  const ago = (iso: string | null) => (iso ? `${formatAge(iso, nowMs)} ago` : 'never')
  return [
    `last success ${ago(status.lastSuccessAt)}`,
    `last attempt ${ago(status.lastAttemptAt)}`,
    status.lastCycleMs === null ? null : `cycle ${status.lastCycleMs} ms`,
    status.intervalSeconds === null ? null : `every ${status.intervalSeconds} s`,
  ].filter((part): part is string => part !== null)
}

/**
 * The alert engine's state, as it reported itself: running, failed, stale or never started. A state
 * that is not running is framed in its color and says what that means for the incidents on screen;
 * an engine that never started is never drawn as healthy, and a state that could not be read is an
 * error, not a blank. Nothing is inferred from the incidents.
 */
export function EngineStatusBanner({
  resource,
  className,
}: {
  resource: Resource<EngineStatus>
  className?: string
}) {
  const { tz } = usePrefs()
  const { data, error, status } = resource

  if (!data) {
    return status === 'loading' ? (
      <p
        aria-busy="true"
        className={cn(
          'type-body rounded-sm border border-border px-3 py-2 text-fg-muted',
          className,
        )}
      >
        Reading the alert engine’s state…
      </p>
    ) : (
      <section
        aria-label="Alert engine"
        role="alert"
        className={cn(
          'type-body flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-3 py-2',
          STATUS_FRAME.unknown,
          className,
        )}
      >
        <StatusTag status="unknown" word="ENGINE UNKNOWN" />
        <span className="min-w-0 flex-1">
          The alert engine’s state could not be read ({error?.message ?? 'no answer'}), so it is not
          known whether incidents are being evaluated.
        </span>
        <Button size="sm" onClick={resource.refetch}>
          Retry
        </Button>
      </section>
    )
  }

  const nowMs = Date.parse(data.generatedAt)
  const attention = engineNeedsAttention(data)
  const caveat = engineCaveat(data)
  return (
    <section
      aria-label="Alert engine"
      data-state={data.state}
      className={cn(
        'type-body flex flex-col gap-1 rounded-sm border px-3 py-2',
        attention
          ? cn(STATUS_FRAME[ENGINE_HEALTH[data.state]], STATUS_TINT[ENGINE_HEALTH[data.state]])
          : 'border-border bg-panel',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="type-label text-fg-muted">ALERT ENGINE</span>
        <StatusTag status={ENGINE_HEALTH[data.state]} word={ENGINE_WORD[data.state]} />
        <span className="min-w-0 flex-1">{engineSentence(data, nowMs)}</span>
      </div>
      {data.state !== 'never_started' ? (
        <p className="type-data text-fg-muted">
          {facts(data, nowMs).join(' · ')}
          {data.monitoringSince ? (
            <>
              {' · '}monitoring since{' '}
              <time dateTime={data.monitoringSince}>
                {formatClock(Date.parse(data.monitoringSince), tz)}
              </time>
            </>
          ) : null}
        </p>
      ) : null}
      {caveat ? <p className="text-fg-muted">{caveat}</p> : null}
      {error ? (
        <p className="text-fg-muted">
          The latest read of its state failed ({error.message}): this is the last answer, read at{' '}
          {resource.updatedAt ? formatClock(resource.updatedAt, tz) : EMPTY}.
        </p>
      ) : null}
    </section>
  )
}

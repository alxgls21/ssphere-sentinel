import type { StatusCounts } from '@/api/types'
import { useRequiredAlerts } from '@/app/alerts'
import { formatInteger } from '@/lib/format'
import { ENGINE_HEALTH, ENGINE_WORD, engineNeedsAttention } from '@/lib/incidents'
import { emptyCounts } from '@/lib/status'
import { SegmentedBar } from '@/ui/meters'
import { StatusGlyph } from '@/ui/status'
import { CountList } from './CountList'
import { StatTile, type TileContent } from './StatTile'
import { navPath, PROBLEM_STATUSES } from './tileText'

/**
 * The open incidents, as the API counts them over the whole scope: how many are open (an
 * acknowledged incident is still open), how many of those are critical, and the rest warnings. An
 * alert engine that is not running is said on the tile itself: zero open incidents from an engine
 * that never ran is not good news. The tile links to the Alerts screen.
 */
export function AlertsTile({ className }: { className?: string }) {
  const { overview, engine } = useRequiredAlerts()
  const { data } = overview

  let content: TileContent | undefined
  if (data) {
    const counts: StatusCounts = {
      ...emptyCounts(),
      critical: data.critical,
      warning: Math.max(0, data.open - data.critical),
    }
    const engineData = engine.data
    const engineNote = engineData
      ? engineNeedsAttention(engineData)
        ? `alert engine ${ENGINE_WORD[engineData.state].toLowerCase()}`
        : null
      : engine.error
        ? 'alert engine state unavailable'
        : null
    content = {
      summary: [
        `${formatInteger(data.open)} open`,
        `${formatInteger(data.critical)} critical`,
        `${formatInteger(data.active)} not acknowledged`,
        engineNote,
      ]
        .filter(Boolean)
        .join(', '),
      value: data.open,
      unit: ' open',
      detail: (
        <span className="flex min-w-0 flex-col gap-0.5">
          <CountList counts={counts} show={PROBLEM_STATUSES} empty="none open" />
          {engineNote ? (
            <span className="type-data inline-flex min-w-0 items-center gap-1 text-fg-muted">
              <StatusGlyph
                status={engineData ? ENGINE_HEALTH[engineData.state] : 'unknown'}
                size={10}
              />
              {/* Shorter than the spoken name, which says "alert engine ...", to fit the tile. */}
              <span className="truncate">{engineNote.replace(/^alert engine /, 'engine ')}</span>
            </span>
          ) : null}
        </span>
      ),
      bar: <SegmentedBar counts={counts} height={6} label="Open incidents" className="w-full" />,
    }
  }

  return (
    <StatTile
      label="Alerts"
      features="alerts"
      to={navPath('alerts')}
      status={overview.status}
      content={content}
      stale={overview.error !== null && data !== undefined}
      onRetry={overview.refetch}
      className={className}
    />
  )
}

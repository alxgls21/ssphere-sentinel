import { Link } from 'react-router'
import type { IncidentOverview } from '@/api/types'
import { useRequiredAlerts } from '@/app/alerts'
import { useLive } from '@/app/live'
import { useViewTo } from '@/app/viewSearch'
import { formatAge, formatInteger } from '@/lib/format'
import { engineNeedsAttention, incidentPath } from '@/lib/incidents'
import { EngineStatusLine, IncidentStatusTag } from '@/ui/incidents'
import { Panel } from '@/ui/Panel'
import { StatusGlyph } from '@/ui/status'

/**
 * Rows the panel lists: the few that matter most. The Alerts screen holds the rest. The panel is
 * 166px tall, so a line about the engine takes the room of a row.
 */
export const LISTED = 3
export const LISTED_WITH_ENGINE_LINE = 2

function Rows({ data, nowMs, limit }: { data: IncidentOverview; nowMs: number; limit: number }) {
  const viewTo = useViewTo()
  return (
    <ul aria-label="Recent important incidents" className="flex flex-col">
      {data.recent.slice(0, limit).map((incident) => (
        <li key={incident.id}>
          <Link
            to={viewTo(incidentPath(incident.id))}
            title={`${incident.rule.name}: ${incident.entity.label}`}
            className="flex h-6 min-w-0 items-center gap-2 rounded-sm px-1 -outline-offset-2 hover:bg-hover"
          >
            <StatusGlyph status={incident.severity} size={10} label={incident.severity} />
            <span className="type-data-strong min-w-0 flex-1 truncate">
              {incident.entity.label}
            </span>
            <IncidentStatusTag status={incident.status} />
            <span className="type-data tnum shrink-0 text-fg-faint">
              {formatAge(incident.openedAt, nowMs)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * [5] Active alerts: how many incidents are open in the topbar scope (an acknowledged one is
 * still open), how many are critical and how many nobody has acknowledged yet, as the API counts them
 * over the whole scope, and the first few that matter most, critical first. Each row opens its
 * incident. An engine that is not running is said here too: no incident listed from one that never
 * ran is not good news.
 */
export function ActiveAlertsPanel({ className }: { className?: string }) {
  const { overview, engine } = useRequiredAlerts()
  const { pollMs } = useLive()
  const viewTo = useViewTo()
  const data = overview.data
  const nowMs = data ? Date.parse(data.generatedAt) : 0
  const engineUncertain = engine.data ? engineNeedsAttention(engine.data) : engine.error !== null
  const limit = engineUncertain ? LISTED_WITH_ENGINE_LINE : LISTED
  const listed = data ? Math.min(limit, data.recent.length) : 0
  const more = data ? Math.max(0, data.open - listed) : 0

  return (
    <Panel
      index={5}
      title="Active alerts"
      features="alerts"
      className={className}
      scope="NOW"
      refreshMs={pollMs}
      count={data ? data.open : undefined}
      status={overview.status}
      refreshing={overview.isRefreshing && data !== undefined}
      error={overview.error}
      updatedAt={overview.updatedAt}
      onRetry={overview.refetch}
      footer={
        <>
          {more > 0 ? (
            <span className="truncate">+{formatInteger(more)} more open</span>
          ) : engine.data?.state === 'running' ? (
            <span className="truncate">alert engine running</span>
          ) : null}
          <Link
            to={viewTo('/alerts')}
            className="ml-auto shrink-0 whitespace-nowrap text-primary hover:text-primary-hover"
          >
            All alerts
          </Link>
        </>
      }
    >
      {data ? (
        <div className="flex flex-col gap-1.5">
          <p className="type-data tnum flex flex-wrap items-baseline gap-x-3 text-fg-muted">
            <span>
              <strong className="type-data-strong text-fg">{formatInteger(data.open)}</strong> open
            </span>
            <span>
              <strong className="type-data-strong text-fg">{formatInteger(data.critical)}</strong>{' '}
              critical
            </span>
            <span>
              <strong className="type-data-strong text-fg">{formatInteger(data.active)}</strong> not
              acknowledged
            </span>
          </p>
          <EngineStatusLine resource={engine} />
          {data.recent.length > 0 ? (
            <Rows data={data} nowMs={nowMs} limit={limit} />
          ) : (
            <p className="type-body text-fg-muted">
              {engineUncertain
                ? 'No open incidents recorded. That does not mean everything is healthy: the alert engine is not confirmed to be running.'
                : 'No open incidents.'}
            </p>
          )}
        </div>
      ) : null}
    </Panel>
  )
}

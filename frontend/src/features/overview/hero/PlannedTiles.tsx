import type { TileContent } from './StatTile'
import { useAlerts } from '../alertsResource'
import { formatInteger } from '@/lib/format'
import { countStatuses } from '@/lib/status'
import { StatusGlyph } from '@/ui/status'
import { CountList } from './CountList'
import { useFreshness, useSummaryState } from './fleetStatus'
import { PlannedBar, StatTile } from './StatTile'
import { navPath } from './tileText'
import { describeProblems } from './verdictText'

interface TileProps {
  /** Grid placement from the strip. */
  className?: string
}

const ALERT_STATUSES = ['critical', 'warning'] as const

/**
 * SNMP devices. The inventory count is real once a read API exists, but no
 * collector reports any state, so every device reads "no SNMP data" and the
 * tile never feeds the verdict.
 */
export function DevicesTile({ className }: TileProps) {
  const { summary, stale } = useSummaryState()
  const inventory = summary.data?.devices.inInventory

  let content: TileContent | undefined
  if (inventory !== undefined) {
    const count = formatInteger(inventory)
    content = {
      summary: `${count} in inventory, no SNMP data`,
      value: inventory,
      unit: 'in inventory',
      detail: (
        <span className="type-data tnum inline-flex items-center gap-1 whitespace-nowrap">
          <StatusGlyph status="unknown" size={10} />
          {count} no SNMP data
        </span>
      ),
      bar: <PlannedBar />,
    }
  }

  return (
    <StatTile
      label="Devices"
      features="snmp"
      to={navPath('snmp')}
      status={summary.status}
      content={content}
      stale={stale}
      onRetry={summary.refetch}
      className={className}
    />
  )
}

/**
 * Active alerts, always sample data: the backend has no alert engine. Read from the
 * page's shared alerts resource (not the summary), and never counted in the verdict.
 */
export function AlertsTile({ className }: TileProps) {
  const freshness = useFreshness()
  const alerts = useAlerts()

  let content: TileContent | undefined
  if (alerts.data) {
    const counts = countStatuses(alerts.data.map((alert) => alert.severity))
    const problems = describeProblems(counts)
    content = {
      summary: `${formatInteger(alerts.data.length)} sample${problems ? `, ${problems}` : ''}`,
      value: alerts.data.length,
      unit: 'sample',
      detail: <CountList counts={counts} show={ALERT_STATUSES} empty="no sample alerts" />,
      bar: <PlannedBar />,
    }
  }

  return (
    <StatTile
      label="Alerts"
      features="alerts"
      to={navPath('alerts')}
      status={alerts.status}
      content={content}
      stale={freshness === 'stale' || freshness === 'nodata' || alerts.error !== null}
      onRetry={alerts.refetch}
      className={className}
    />
  )
}

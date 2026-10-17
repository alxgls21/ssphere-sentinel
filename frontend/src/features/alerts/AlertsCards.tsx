import { Link, useLocation } from 'react-router'
import type { IncidentItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { formatAge } from '@/lib/format'
import { KIND_LABEL, conditionText, incidentPath } from '@/lib/incidents'
import { PlaceName } from '@/ui/PlaceName'
import { IncidentStatusTag, SeverityTag } from '@/ui/incidents'
import { STATUS_EDGE } from '@/ui/status'
import { AcknowledgeButton } from './AcknowledgeControls'

interface AlertsCardsProps {
  rows: readonly IncidentItem[]
  nowMs: number
  busy: string | null
  onAcknowledge: (id: string) => void
}

/**
 * The same list for a phone: one card per incident, still a list of links. Severity and status
 * lead, then the object and the rule, the condition and where; the acknowledge button sits outside
 * the link (a button never lives inside one) and only where the API says it may be used.
 */
export function AlertsCards({ rows, nowMs, busy, onAcknowledge }: AlertsCardsProps) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Incidents" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => (
        <li key={item.id} className="relative border-b border-border last:border-b-0">
          <span
            aria-hidden="true"
            className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.severity])}
          />
          <Link
            to={viewTo(incidentPath(item.id))}
            state={{ list: location.search }}
            className="flex flex-col gap-1.5 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
          >
            <span className="flex flex-wrap items-center gap-2">
              <SeverityTag severity={item.severity} />
              <IncidentStatusTag status={item.status} />
              <span className="type-data tnum ml-auto shrink-0 text-fg-faint">
                opened {formatAge(item.openedAt, nowMs)} ago
              </span>
            </span>
            <span className="type-data-strong min-w-0 truncate">{item.entity.label}</span>
            <span className="type-data min-w-0 truncate text-fg-faint">
              {KIND_LABEL[item.entity.kind]} · {item.rule.name}
            </span>
            <span className="type-body text-fg-muted">{conditionText(item)}</span>
            {item.siteName && item.customerName ? (
              <PlaceName
                customer={item.customerName}
                site={item.siteName}
                className="type-body min-w-0"
              />
            ) : null}
          </Link>
          {item.canAcknowledge ? (
            <div className="pr-3 pb-2.5 pl-4">
              <AcknowledgeButton
                label={item.entity.label}
                busy={busy === item.id}
                onAcknowledge={() => onAcknowledge(item.id)}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

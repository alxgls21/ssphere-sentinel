import { Link, useLocation } from 'react-router'
import type { TargetListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import {
  endpointText,
  measuredAgo,
  protocolText,
  reasonSentence,
  reasonWord,
  type TargetLimits,
} from '@/lib/targets'
import { PlaceName } from '@/ui/PlaceName'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { agentText, latencyCell, lossCell, targetPath } from './networkModel'

/**
 * The same list for a phone: one card per target, still a list of links. Name and status lead,
 * then what is probed and where, then the current latency and loss, or the reason there are none.
 */
export function NetworkCards({
  rows,
  nowMs,
  limits,
}: {
  rows: readonly TargetListItem[]
  nowMs: number
  limits: TargetLimits
}) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Network targets" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => {
        const { target } = item
        const latency = latencyCell(item, nowMs, limits)
        const loss = lossCell(item, nowMs, limits)
        return (
          <li key={target.id} className="relative border-b border-border last:border-b-0">
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.health])}
            />
            <Link
              to={viewTo(targetPath(target.id))}
              state={{ list: location.search }}
              className="flex flex-col gap-1.5 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <StatusTag
                  status={item.health}
                  word={reasonWord(item.reason, target.protocol)}
                  variant="tag"
                />
                <span className="type-data-strong min-w-0 flex-1 truncate">{target.name}</span>
                <span className="type-data tnum shrink-0 text-fg-faint">
                  {measuredAgo(item.latest, nowMs)}
                </span>
              </span>
              <span className="type-data flex min-w-0 items-center gap-2 text-fg-faint">
                <span className="min-w-0 flex-1 truncate">
                  {protocolText(item)} · {endpointText(item)}
                </span>
                <span className="shrink-0">agent {agentText(item)}</span>
              </span>
              {item.siteName && item.customerName ? (
                <PlaceName
                  customer={item.customerName}
                  site={item.siteName}
                  className="type-body min-w-0"
                />
              ) : null}
              {latency.note ? (
                <span className="type-body text-fg-muted">
                  {reasonSentence(item, nowMs, limits)}
                </span>
              ) : (
                <span className="type-data tnum flex gap-3">
                  <span>{latency.text}</span>
                  <span>{loss.text}</span>
                </span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

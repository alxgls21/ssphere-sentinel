import { Link, useLocation } from 'react-router'
import type { ServerListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { PlaceName } from '@/ui/PlaceName'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { LoadCell } from './LoadCell'
import {
  heartbeatText,
  noLoadReason,
  reportsLoad,
  serverPath,
  stateWord,
  uptimeText,
} from './serversModel'

const METRICS = [
  ['cpu', 'CPU'],
  ['memory', 'RAM'],
  ['disk', 'DISK'],
] as const

/**
 * The same list for a phone: one card per server, still a list of links. Name
 * and status lead, then where it lives and how long it has been up, then the
 * three meters with their labels.
 */
export function ServerCards({ rows, nowMs }: { rows: readonly ServerListItem[]; nowMs: number }) {
  const viewTo = useViewTo()
  const location = useLocation()
  return (
    <ul aria-label="Servers" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => {
        const { server } = item
        const reason = noLoadReason(item)
        return (
          <li key={server.id} className="relative border-b border-border last:border-b-0">
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.health])}
            />
            <Link
              to={viewTo(serverPath(server.id))}
              state={{ list: location.search }}
              className="flex flex-col gap-1.5 py-2.5 pr-3 pl-4 -outline-offset-2 hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <StatusTag status={item.health} word={stateWord(item)} variant="tag" />
                <span className="type-data-strong min-w-0 flex-1 truncate">{server.name}</span>
                <span className="type-data tnum shrink-0 text-fg-faint">
                  {heartbeatText(item, nowMs)}
                </span>
              </span>
              <span className="type-data flex min-w-0 items-center gap-2 text-fg-faint">
                {item.siteName && item.customerName ? (
                  <PlaceName
                    customer={item.customerName}
                    site={item.siteName}
                    className="type-body min-w-0 flex-1"
                  />
                ) : (
                  <span className="flex-1" />
                )}
                <span className="shrink-0">up {uptimeText(item)}</span>
              </span>
              {reportsLoad(item) ? (
                <span className="flex flex-col gap-1">
                  {METRICS.map(([metric, label]) => (
                    <span key={metric} className="flex items-center gap-2">
                      <span aria-hidden="true" className="type-label w-9 shrink-0 text-fg-faint">
                        {label}
                      </span>
                      <LoadCell item={item} metric={metric} className="min-w-0 flex-1" />
                    </span>
                  ))}
                </span>
              ) : (
                <span className="type-body text-fg-muted">{reason}</span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

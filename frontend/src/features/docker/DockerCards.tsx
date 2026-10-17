import { Link } from 'react-router'
import type { ContainerListItem } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { cn } from '@/lib/cn'
import { containerWord, startedText } from '@/lib/containers'
import { EMPTY } from '@/lib/format'
import { PlaceName } from '@/ui/PlaceName'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { NO_CURRENT_STATE, hasNoState, healthText, hostPath } from './dockerModel'

/**
 * The same list for a phone: one card per container. Name and status lead, then the image, the
 * host it runs on and where that is, then the state and health as the API gives them.
 */
export function DockerCards({
  rows,
  nowMs,
  focus,
}: {
  rows: readonly ContainerListItem[]
  nowMs: number
  focus: string | null
}) {
  const viewTo = useViewTo()
  return (
    <ul aria-label="Containers" className="min-h-0 flex-1 overflow-auto">
      {rows.map((item) => {
        const { container } = item
        const age = startedText(item, nowMs)
        return (
          <li
            key={container.id}
            aria-current={focus === container.id ? 'true' : undefined}
            className={cn(
              'relative flex flex-col gap-1.5 border-b border-border py-2.5 pr-3 pl-4 last:border-b-0',
              focus === container.id && 'bg-hover',
            )}
          >
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[item.status])}
            />
            <span className="flex items-center gap-2">
              <StatusTag status={item.status} word={containerWord(item)} variant="tag" />
              <span className="type-data-strong min-w-0 flex-1 truncate">{container.name}</span>
              <span className="type-data tnum shrink-0 text-fg-faint">
                {age === EMPTY ? EMPTY : `${age} ago`}
              </span>
            </span>
            <span className="type-data truncate text-fg-muted" title={container.image}>
              {container.image}
            </span>
            <span className="type-data flex min-w-0 items-center gap-2 text-fg-faint">
              <Link
                to={viewTo(hostPath(container.serverId))}
                className="min-w-0 shrink-0 truncate rounded-sm text-fg hover:underline"
              >
                {item.serverName}
              </Link>
              {item.siteName && item.customerName ? (
                <PlaceName
                  customer={item.customerName}
                  site={item.siteName}
                  className="type-body min-w-0 flex-1"
                />
              ) : null}
            </span>
            <span className="type-data text-fg-muted">
              state {container.state} · health {healthText(item)}
            </span>
            {hasNoState(item) ? (
              <span className="type-body text-fg-muted">{NO_CURRENT_STATE}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

import type { ServerContainer } from '@/api/types'
import { cn } from '@/lib/cn'
import type { Resource } from '@/hooks/useResource'
import type { ServerDetail } from '@/api/types'
import { Panel } from '@/ui/Panel'
import { EmptyState, SkeletonRows } from '@/ui/states'
import { STATUS_EDGE, StatusTag } from '@/ui/status'
import { containerWord, sortContainers, startedText } from './containerModel'

const HEAD =
  'type-label sticky top-0 z-10 h-6 border-b border-border bg-raised text-left whitespace-nowrap text-fg-faint'
const CELL = 'border-b border-border whitespace-nowrap'

function ContainerTable({ rows, nowMs }: { rows: readonly ServerContainer[]; nowMs: number }) {
  return (
    <div className="h-full overflow-auto">
      <table aria-label="Containers" className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD, 'pl-4')}>
              STATE
            </th>
            <th scope="col" className={cn(HEAD, 'px-3')}>
              NAME
            </th>
            <th scope="col" className={cn(HEAD, 'hidden px-3 @xl:table-cell')}>
              IMAGE
            </th>
            <th scope="col" className={cn(HEAD, 'px-3 text-right')}>
              STARTED
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.container.id} className="relative h-(--row-h) hover:bg-hover">
              <td className={cn(CELL, 'relative pr-2 pl-4')}>
                <span
                  aria-hidden="true"
                  className={cn('absolute inset-y-0 left-0 w-0.5', STATUS_EDGE[row.status])}
                />
                <StatusTag status={row.status} word={containerWord(row)} variant="tag" />
              </td>
              <td className={cn(CELL, 'type-data-strong max-w-0 truncate px-3 @xl:max-w-none')}>
                {row.container.name}
              </td>
              <td
                className={cn(
                  CELL,
                  'type-data hidden max-w-80 truncate px-3 text-fg-muted @xl:table-cell',
                )}
                title={row.container.image}
              >
                {row.container.image}
              </td>
              <td className={cn(CELL, 'type-data tnum px-3 text-right text-fg-faint')}>
                {startedText(row, nowMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface ContainersPanelProps {
  index: number
  resource: Resource<ServerDetail>
  /** The host stopped reporting: its containers cannot be observed. */
  hostOffline: boolean
  className?: string
}

/** The Docker containers of one server, worst first. Demo data until connected to the console API, which serves them. */
export function ContainersPanel({ index, resource, hostOffline, className }: ContainersPanelProps) {
  const rows = resource.data ? sortContainers(resource.data.containers) : []
  const nowMs = resource.data ? Date.parse(resource.data.generatedAt) : 0
  const problems = rows.filter((row) => row.status === 'critical' || row.status === 'warning')
  return (
    <Panel
      index={index}
      title="Containers"
      features="docker"
      scope="NOW"
      className={className}
      count={resource.data ? rows.length : undefined}
      status={resource.status}
      refreshing={resource.isRefreshing && resource.data !== undefined}
      error={resource.error}
      updatedAt={resource.updatedAt}
      onRetry={resource.refetch}
      isEmpty={resource.data !== undefined && rows.length === 0}
      empty={
        <EmptyState
          title="No containers reported"
          hint="Docker is not running on this host, or its agent cannot read the Docker socket."
        />
      }
      skeleton={<SkeletonRows count={4} className="p-3" />}
      footer={
        hostOffline ? (
          <span className="truncate">Host offline: container state cannot be observed.</span>
        ) : problems.length > 0 ? (
          <span className="truncate">{problems.length} need attention</span>
        ) : null
      }
      flush
    >
      <ContainerTable rows={rows} nowMs={nowMs} />
    </Panel>
  )
}

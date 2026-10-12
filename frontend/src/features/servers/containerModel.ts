import type { ServerContainer } from '@/api/types'
import { EMPTY, formatAge } from '@/lib/format'
import { compareSeverity } from '@/lib/status'

/** The domain word for a container's status tag: what it is doing, not only how bad that is. */
export function containerWord({ container }: ServerContainer): string {
  switch (container.state) {
    case 'running':
      return container.health === 'unhealthy'
        ? 'UNHEALTHY'
        : container.health === 'starting'
          ? 'STARTING'
          : 'RUNNING'
    case 'exited':
      return 'STOPPED'
    default:
      return container.state.toUpperCase()
  }
}

/** Worst first, then by name: the broken ones lead, and the order is stable between refreshes. */
export function sortContainers(rows: readonly ServerContainer[]): ServerContainer[] {
  return [...rows].sort(
    (a, b) =>
      compareSeverity(a.status, b.status) ||
      a.container.name.localeCompare(b.container.name, 'en', { numeric: true }),
  )
}

export function startedText(row: ServerContainer, nowMs: number): string {
  const { startedAt, state } = row.container
  if (startedAt === null || state === 'unknown') return EMPTY
  return formatAge(startedAt, nowMs)
}

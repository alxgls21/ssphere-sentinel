import type { ServerContainer } from '@/api/types'
import { EMPTY, formatAge } from '@/lib/format'
import { compareSeverity } from '@/lib/status'

/** The domain word for a container's status tag: what it is doing, not only how bad that is. */
export function containerWord(row: ServerContainer): string {
  const { container } = row
  switch (container.state) {
    case 'running':
      return container.health === 'unhealthy'
        ? 'UNHEALTHY'
        : container.health === 'starting'
          ? 'STARTING'
          : 'RUNNING'
    case 'exited':
      // The server judged how it ended: an error code or a memory kill is a crash, anything else a stop.
      if (container.oomKilled === true) return 'OOM KILLED'
      return row.status === 'critical' ? 'CRASHED' : 'STOPPED'
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

/** How an exited container ended, in words: killed for memory, or its exit code; null while it runs or when unknown. */
export function endedText({ container }: ServerContainer): string | null {
  if (container.state !== 'exited') return null
  if (container.oomKilled === true) return 'killed by the kernel for memory'
  if (container.exitCode === null) return null
  return container.exitCode === 0
    ? 'exited normally (code 0)'
    : `exited with code ${container.exitCode}`
}

import type { EventLevel, SentinelEvent } from '@/api/types'

/** Test fixtures only: a small tail with one incident (failure and nested recovery). */
export const at = (hms: string) => `2026-10-12T${hms}Z`

export const event = (
  id: string,
  time: string,
  level: EventLevel,
  subject: string,
  message: string,
  parentId?: string,
): SentinelEvent => ({
  id,
  at: at(time),
  level,
  subject: { kind: 'server', id: subject, name: subject },
  message,
  ...(parentId ? { parentId } : {}),
})

/** Shown newest first as: offline, latency, unhealthy, heartbeat late, its recovery, agent updated. */
export const TAIL: SentinelEvent[] = [
  event('e-late', '14:01:10', 'warning', 'web-02', 'heartbeat late'),
  event('e-online', '14:01:55', 'healthy', 'web-02', 'online', 'e-late'),
  event('e-offline', '14:05:12', 'critical', 'edge-gw-02', 'offline'),
  event('e-latency', '14:04:40', 'warning', 'cdn-edge:80', 'latency 212 ms, above 150 ms limit'),
  event('e-unhealthy', '14:03:02', 'critical', 'payments-api', 'unhealthy'),
  event('e-agent', '13:50:00', 'info', 'srv-core-git-01', 'agent updated 0.4.1 -> 0.4.2'),
]

/** What arrives while the operator is reading. */
export const FRESH: SentinelEvent[] = [
  event('e-new-2', '14:06:30', 'warning', 'api-02', 'cpu 83%, above 80% limit'),
  event('e-new-1', '14:06:00', 'critical', 'db-prod-01', 'offline'),
]

import type { EventLevel, SentinelEvent, SubjectRef } from '@/api/types'
import { SAMPLE_TIME } from './data'

/**
 * Sample events for the incident timeline, placed relative to SAMPLE_TIME so the
 * gallery looks the same on every visit. Nothing here comes from an API.
 */

const minutesAgo = (minutes: number, seconds = 0) =>
  new Date(SAMPLE_TIME - (minutes * 60 + seconds) * 1000).toISOString()

const sample = (
  id: string,
  at: string,
  level: EventLevel,
  subject: SubjectRef,
  message: string,
  parentId?: string,
): SentinelEvent => ({ id, at, level, subject, message, ...(parentId ? { parentId } : {}) })

const vpn = { kind: 'target', id: 'tgt-pir-vpn', name: 'pir-vpn' } as const
const gateway = { kind: 'server', id: 'srv-edge-gw-02', name: 'edge-gw-02' } as const
const backup = { kind: 'server', id: 'srv-hc-bkp-01', name: 'hc-bkp-01' } as const
const payments = { kind: 'container', id: 'ctr-payments-api', name: 'payments-api' } as const
const web = { kind: 'server', id: 'srv-web-02', name: 'web-02' } as const
const api = { kind: 'server', id: 'srv-api-02', name: 'api-02' } as const
const database = { kind: 'server', id: 'srv-ath-db-01', name: 'ath-db-01' } as const
const acme = { kind: 'target', id: 'tgt-acme-vpn', name: 'acme-vpn:443' } as const
const git = { kind: 'server', id: 'srv-core-git-01', name: 'core-git-01' } as const

/**
 * One of every lane the timeline draws, over the last hour: two failures still open (one started
 * before the axis does), one with an info event under it, resolved ones of different severity and length,
 * a recovery whose failure is older than the range, and an info event that makes no lane.
 */
export const SAMPLE_INCIDENT_EVENTS: SentinelEvent[] = [
  sample('evt-vpn', minutesAgo(22), 'critical', vpn, 'TCP 443 timeout, probes failing'),
  sample('evt-gw', minutesAgo(7), 'critical', gateway, 'marked offline: no heartbeat for 90s'),
  sample('evt-bkp', minutesAgo(47), 'warning', backup, 'memory above 80% limit'),
  sample('evt-bkp-ack', minutesAgo(42), 'info', backup, 'alert acknowledged by ops', 'evt-bkp'),
  sample('evt-db', minutesAgo(64), 'critical', database, 'disk above 95% limit'),
  sample('evt-pay', minutesAgo(35), 'warning', payments, 'latency 212 ms, above 150 ms limit'),
  sample('evt-pay-ok', minutesAgo(7), 'healthy', payments, 'back to baseline (12 ms)', 'evt-pay'),
  sample('evt-web', minutesAgo(55), 'critical', web, 'reported unhealthy'),
  sample('evt-web-ok', minutesAgo(51), 'healthy', web, 'health check passing again', 'evt-web'),
  sample('evt-api', minutesAgo(15), 'warning', api, 'cpu 83%, above 80% limit'),
  sample('evt-api-ok', minutesAgo(14, 20), 'healthy', api, 'cpu back under 70%', 'evt-api'),
  sample(
    'evt-acme-ok',
    minutesAgo(40),
    'healthy',
    acme,
    'probes succeeding again',
    'evt-older-than-the-range',
  ),
  sample('evt-git', minutesAgo(30), 'info', git, 'agent updated 0.4.1 -> 0.4.2'),
]

/** What a range with events but no incident holds: nothing the timeline draws a lane for. */
export const SAMPLE_INFO_EVENTS: SentinelEvent[] = SAMPLE_INCIDENT_EVENTS.filter(
  (event) => event.level === 'info' && event.parentId === undefined,
)

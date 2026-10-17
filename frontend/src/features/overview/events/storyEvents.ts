import type { RangeKey, SentinelEvent } from '@/api/types'

/** Test support for the incident timeline: never imported by the app. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The moment the fixture's outage story is anchored to. */
export const STORY_NOW = Date.parse('2026-10-12T14:05:12Z')

const RANGE_MS: Record<RangeKey, number> = {
  '15m': 15 * MINUTE,
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
}

/**
 * A day of events around one outage, newest first: every kind of incident the timeline has to draw
 * (ongoing, resolved, recovered with no known start, clipped by the axis) beside info events that
 * are no incident.
 */
export const STORY_EVENTS: readonly SentinelEvent[] = [
  {
    id: 'evt-55559399',
    at: '2026-10-12T14:02:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-muc-vpn', name: 'muc-vpn' },
    message: 'TCP 443 connection refused, probes failing',
  },
  {
    id: 'evt-41b0ddee',
    at: '2026-10-12T13:52:50.000Z',
    level: 'critical',
    subject: { kind: 'target', id: 'tgt-pir-vpn', name: 'pir-vpn' },
    message: 'TCP 443 timeout, probes failing',
  },
  {
    id: 'evt-63a966f9',
    at: '2026-10-12T13:52:12.000Z',
    level: 'critical',
    subject: { kind: 'server', id: 'srv-pir-fs-01', name: 'pir-fs-01' },
    message: 'marked offline: no heartbeat for 90s',
  },
  {
    id: 'evt-8583022b',
    at: '2026-10-12T13:52:12.000Z',
    level: 'critical',
    subject: { kind: 'device', id: 'dev-pir-sw1', name: 'pir-sw1' },
    message: 'SNMP unreachable after 3 polls',
  },
  {
    id: 'evt-a80843c3',
    at: '2026-10-12T13:51:29.000Z',
    level: 'critical',
    subject: { kind: 'target', id: 'tgt-pir-gateway', name: 'pir-gateway' },
    message: 'ICMP host unreachable, probes failing',
  },
  {
    id: 'evt-66156fc8',
    at: '2026-10-12T13:50:29.000Z',
    level: 'info',
    subject: { kind: 'site', id: 'site-pir-depot', name: 'Piraeus Depot' },
    message: 'last successful probe before connectivity loss',
  },
  {
    id: 'evt-0d61747a',
    at: '2026-10-12T13:42:12.000Z',
    level: 'warning',
    subject: {
      kind: 'container',
      id: 'ctr-fra-web-02-queue-worker',
      name: 'queue-worker@fra-web-02',
    },
    message: 'entered restart loop',
  },
  {
    id: 'evt-e7c74d31',
    at: '2026-10-12T13:42:12.000Z',
    level: 'warning',
    subject: { kind: 'server', id: 'srv-fra-web-02', name: 'fra-web-02' },
    message: 'cpu above 80% limit',
  },
  {
    id: 'evt-a3a993fd',
    at: '2026-10-12T13:29:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-fra-vpn', name: 'fra-vpn' },
    message: 'latency above 150 ms limit',
  },
  {
    id: 'evt-2bfead64',
    at: '2026-10-12T13:27:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-fra-isp-a', name: 'fra-isp-a' },
    message: 'packet loss 6%',
  },
  {
    id: 'evt-25ca17fe',
    at: '2026-10-12T13:24:12.000Z',
    level: 'critical',
    subject: {
      kind: 'container',
      id: 'ctr-muc-pos-02-receipt-printer',
      name: 'receipt-printer@muc-pos-02',
    },
    message: 'reported dead',
  },
  {
    id: 'evt-7fa0077a',
    at: '2026-10-12T13:23:12.000Z',
    level: 'info',
    subject: { kind: 'server', id: 'srv-hc-bkp-01', name: 'hc-bkp-01' },
    message: 'alert acknowledged by ops',
    parentId: 'evt-7beee395',
  },
  {
    id: 'evt-7beee395',
    at: '2026-10-12T13:18:12.000Z',
    level: 'warning',
    subject: { kind: 'server', id: 'srv-hc-bkp-01', name: 'hc-bkp-01' },
    message: 'memory above 80% limit',
  },
  {
    id: 'evt-c9035853',
    at: '2026-10-12T12:59:12.000Z',
    level: 'critical',
    subject: { kind: 'container', id: 'ctr-ath-app-01-api', name: 'api@ath-app-01' },
    message: 'reported unhealthy',
  },
  {
    id: 'evt-90783781',
    at: '2026-10-12T12:53:12.000Z',
    level: 'critical',
    subject: { kind: 'container', id: 'ctr-ath-db-01-pgbouncer', name: 'pgbouncer@ath-db-01' },
    message: 'reported unhealthy',
  },
  {
    id: 'evt-a454d0cf',
    at: '2026-10-12T12:30:12.000Z',
    level: 'warning',
    subject: { kind: 'interface', id: 'dev-fra-core-sw1-gi1-0-15', name: 'Gi1/0/15@fra-core-sw1' },
    message: 'Gi1/0/15 oper status changed up -> down',
  },
  {
    id: 'evt-ea553266',
    at: '2026-10-12T12:29:12.000Z',
    level: 'healthy',
    subject: { kind: 'server', id: 'srv-fra-cache-01', name: 'fra-cache-01' },
    message: 'cpu back under 30%',
    parentId: 'evt-46f6f060',
  },
  {
    id: 'evt-46f6f060',
    at: '2026-10-12T12:07:12.000Z',
    level: 'warning',
    subject: { kind: 'server', id: 'srv-fra-cache-01', name: 'fra-cache-01' },
    message: 'cpu 83%, above 80% limit',
  },
  {
    id: 'evt-344fc97e',
    at: '2026-10-12T11:57:12.000Z',
    level: 'warning',
    subject: { kind: 'server', id: 'srv-ath-db-01', name: 'ath-db-01' },
    message: 'disk above 80% limit',
  },
  {
    id: 'evt-2e118fb7',
    at: '2026-10-12T11:35:12.000Z',
    level: 'info',
    subject: { kind: 'server', id: 'srv-core-ci-01', name: 'core-ci-01' },
    message: 'enrolled, waiting for first heartbeat',
  },
  {
    id: 'evt-cd0d1472',
    at: '2026-10-12T11:17:12.000Z',
    level: 'healthy',
    subject: { kind: 'target', id: 'tgt-ath-api', name: 'ath-api' },
    message: 'back to baseline (12 ms)',
    parentId: 'evt-15c9f7d7',
  },
  {
    id: 'evt-15c9f7d7',
    at: '2026-10-12T10:55:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-ath-api', name: 'ath-api' },
    message: 'latency 188 ms, above 150 ms limit',
  },
  {
    id: 'evt-9eb1406b',
    at: '2026-10-12T10:40:12.000Z',
    level: 'warning',
    subject: { kind: 'interface', id: 'dev-hc-core-sw1-gi1-0-3', name: 'Gi1/0/3@hc-core-sw1' },
    message: 'Gi1/0/3 oper status changed up -> down',
  },
  {
    id: 'evt-ae03927b',
    at: '2026-10-12T09:43:12.000Z',
    level: 'info',
    subject: { kind: 'server', id: 'srv-fra-db-01', name: 'fra-db-01' },
    message: 'pgbackrest container exited',
  },
  {
    id: 'evt-518ee964',
    at: '2026-10-12T08:35:12.000Z',
    level: 'warning',
    subject: { kind: 'interface', id: 'dev-ath-core-sw1-gi1-0-15', name: 'Gi1/0/15@ath-core-sw1' },
    message: 'Gi1/0/15 oper status changed up -> down',
  },
  {
    id: 'evt-5c4c9975',
    at: '2026-10-12T08:34:12.000Z',
    level: 'healthy',
    subject: { kind: 'server', id: 'srv-fra-web-01', name: 'fra-web-01' },
    message: 'cpu back under 70%',
    parentId: 'evt-69b879af',
  },
  {
    id: 'evt-69b879af',
    at: '2026-10-12T08:05:12.000Z',
    level: 'warning',
    subject: { kind: 'server', id: 'srv-fra-web-01', name: 'fra-web-01' },
    message: 'cpu 88%, above 80% limit',
  },
  {
    id: 'evt-1518daee',
    at: '2026-10-12T07:15:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-muc-cdn', name: 'muc-cdn' },
    message: 'latency above 150 ms limit',
  },
  {
    id: 'evt-411d7b7c',
    at: '2026-10-12T07:10:12.000Z',
    level: 'info',
    subject: { kind: 'server', id: 'srv-core-git-01', name: 'core-git-01' },
    message: 'agent updated 0.4.1 -> 0.4.2',
  },
  {
    id: 'evt-687522fe',
    at: '2026-10-12T05:30:12.000Z',
    level: 'healthy',
    subject: { kind: 'target', id: 'tgt-ath-isp-b', name: 'ath-isp-b' },
    message: 'back to baseline (5.0 ms)',
    parentId: 'evt-df38c94c',
  },
  {
    id: 'evt-df38c94c',
    at: '2026-10-12T05:05:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-ath-isp-b', name: 'ath-isp-b' },
    message: 'packet loss 4% over 5m',
  },
  {
    id: 'evt-4f85696e',
    at: '2026-10-12T04:03:12.000Z',
    level: 'healthy',
    subject: { kind: 'device', id: 'dev-fra-core-sw1', name: 'fra-core-sw1' },
    message: 'Gi1/0/24 utilization back under 80%',
    parentId: 'evt-87dab0de',
  },
  {
    id: 'evt-87dab0de',
    at: '2026-10-12T01:52:12.000Z',
    level: 'warning',
    subject: { kind: 'device', id: 'dev-fra-core-sw1', name: 'fra-core-sw1' },
    message: 'Gi1/0/24 utilization 92% for 10m',
  },
  {
    id: 'evt-666b0f4d',
    at: '2026-10-12T00:55:12.000Z',
    level: 'healthy',
    subject: { kind: 'target', id: 'tgt-fra-api', name: 'fra-api' },
    message: 'probes succeeding again',
    parentId: 'evt-7a4851b2',
  },
  {
    id: 'evt-7a4851b2',
    at: '2026-10-12T00:45:12.000Z',
    level: 'critical',
    subject: { kind: 'target', id: 'tgt-fra-api', name: 'fra-api' },
    message: 'TCP 443 timeout, probes failing',
  },
  {
    id: 'evt-9cca0d45',
    at: '2026-10-11T23:04:12.000Z',
    level: 'info',
    subject: { kind: 'server', id: 'srv-ath-app-02', name: 'ath-app-02' },
    message: 'agent updated 0.4.1 -> 0.4.2',
  },
  {
    id: 'evt-2f2f17fd',
    at: '2026-10-11T18:25:12.000Z',
    level: 'healthy',
    subject: { kind: 'container', id: 'ctr-hc-pacs-01-orthanc', name: 'orthanc@hc-pacs-01' },
    message: 'health check passing again',
    parentId: 'evt-44199fb9',
  },
  {
    id: 'evt-44199fb9',
    at: '2026-10-11T17:55:12.000Z',
    level: 'critical',
    subject: { kind: 'container', id: 'ctr-hc-pacs-01-orthanc', name: 'orthanc@hc-pacs-01' },
    message: 'reported unhealthy',
  },
  {
    id: 'evt-eac74905',
    at: '2026-10-11T17:05:12.000Z',
    level: 'warning',
    subject: { kind: 'target', id: 'tgt-hc-annex-lte', name: 'hc-annex-lte' },
    message: 'packet loss 3%',
  },
]

/** The events inside a range ending at `at`, as an events API would answer for it. */
export function storyEvents(range: RangeKey, at = STORY_NOW): SentinelEvent[] {
  return STORY_EVENTS.filter((entry) => Date.parse(entry.at) >= at - RANGE_MS[range])
}

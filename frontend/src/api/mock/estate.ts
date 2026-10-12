import type {
  ContainerHealth,
  ContainerState,
  Customer,
  DeviceType,
  ProbeProtocol,
  Site,
} from '@/api/types'

/**
 * MOCK ESTATE: the hand-placed part of the fictional fleet. Fictional
 * customers on documentation address ranges (RFC 5737 / `.example`); none of
 * this exists in the backend. fixtures.ts turns these tables into view-models
 * and adds the seeded bulk.
 *
 * Story the data tells (so every panel agrees and the future topology screen
 * has something real to show):
 *   - Piraeus Depot lost connectivity 14 minutes ago: its switch stopped
 *     answering SNMP, its gateway and VPN probes fail, and the file server
 *     stopped sending heartbeats (its containers are no longer observable).
 *   - ath-db-01 is running out of disk, which is starving pgbouncer and the
 *     api on ath-app-01; hc-bkp-01 is short on memory.
 *   - A queue worker on fra-web-02 is in a restart loop and burns its CPU.
 *   - The Frankfurt ISP link A has dropped ~6% of packets for 38 minutes and
 *     everything routed over it is slow.
 */

export const CUSTOMERS: readonly Customer[] = [
  { id: 'cus-meridian', name: 'Meridian Logistics' },
  { id: 'cus-northwind', name: 'Northwind Retail' },
  { id: 'cus-halcyon', name: 'Halcyon Clinics' },
  { id: 'cus-internal', name: 'Internal IT' },
]

export const SITES: readonly Site[] = [
  { id: 'site-ath-dc', customerId: 'cus-meridian', name: 'Athens DC' },
  { id: 'site-pir-depot', customerId: 'cus-meridian', name: 'Piraeus Depot' },
  { id: 'site-fra-dc', customerId: 'cus-northwind', name: 'Frankfurt DC' },
  { id: 'site-muc-stores', customerId: 'cus-northwind', name: 'Munich Stores' },
  { id: 'site-hc-main', customerId: 'cus-halcyon', name: 'Main Campus' },
  { id: 'site-hc-annex', customerId: 'cus-halcyon', name: 'North Annex' },
  { id: 'site-core-dc', customerId: 'cus-internal', name: 'Core DC' },
]

/* ----------------------------------------------------------------- servers */

/** [name, image, health = 'healthy', state = 'running', upHours = 400] */
export type ContainerSpec = readonly [
  name: string,
  image: string,
  health?: ContainerHealth,
  state?: ContainerState,
  upHours?: number,
]

/**
 * A problem with the heartbeat itself, as opposed to a resource problem:
 *   offline  the agent stopped reporting `lastSeenMin` minutes before the story anchor
 *   never    the server was enrolled but has not reported once
 */
export type ServerFault = { kind: 'offline'; lastSeenMin: number } | { kind: 'never' }

export interface ServerSpec {
  name: string
  ip: string
  os: string
  site: string
  cpu: number
  mem: number
  disk: number
  memGiB: number
  diskGiB: number
  uptimeDays: number
  /** Nominal seconds since the last heartbeat while healthy. */
  seenAgoSec: number
  fault?: ServerFault
  containers?: readonly ContainerSpec[]
}

export const SERVER_SPECS: readonly ServerSpec[] = [
  {
    name: 'ath-app-01',
    ip: '10.20.1.11',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-ath-dc',
    cpu: 34,
    mem: 58,
    disk: 41,
    memGiB: 32,
    diskGiB: 480,
    uptimeDays: 61,
    seenAgoSec: 12,
    containers: [
      ['nginx', 'nginx:1.27-alpine'],
      ['api', 'meridian/api:2.18.0', 'unhealthy'],
      ['worker', 'meridian/worker:2.18.0', 'none'],
      ['redis', 'redis:7.4-alpine'],
      ['otel-collector', 'otel/opentelemetry-collector:0.108', 'none'],
    ],
  },
  {
    name: 'ath-app-02',
    ip: '10.20.1.12',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-ath-dc',
    cpu: 29,
    mem: 54,
    disk: 39,
    memGiB: 32,
    diskGiB: 480,
    uptimeDays: 61,
    seenAgoSec: 21,
    containers: [
      ['nginx', 'nginx:1.27-alpine'],
      ['api', 'meridian/api:2.18.0'],
      ['worker', 'meridian/worker:2.18.0', 'none'],
      ['migrate', 'meridian/api:2.18.0', 'none', 'created', 61],
    ],
  },
  {
    name: 'ath-db-01',
    ip: '10.20.2.10',
    os: 'Debian 13',
    site: 'site-ath-dc',
    cpu: 22,
    mem: 71,
    disk: 91,
    memGiB: 64,
    diskGiB: 1000,
    uptimeDays: 143,
    seenAgoSec: 9,
    containers: [
      ['postgres', 'postgres:16.4'],
      ['pgbouncer', 'edoburu/pgbouncer:1.23', 'unhealthy'],
      ['pg-exporter', 'prometheuscommunity/postgres-exporter:0.15', 'none'],
    ],
  },
  {
    name: 'ath-mon-01',
    ip: '10.20.3.5',
    os: 'Debian 13',
    site: 'site-ath-dc',
    cpu: 12,
    mem: 33,
    disk: 28,
    memGiB: 16,
    diskGiB: 240,
    uptimeDays: 88,
    seenAgoSec: 17,
    containers: [
      ['grafana', 'grafana/grafana:11.2.0'],
      ['loki', 'grafana/loki:3.1.1', 'starting'],
      ['alertmanager', 'prom/alertmanager:0.27.0', 'none'],
      ['node-exporter', 'prom/node-exporter:1.8.2', 'none'],
      ['blackbox', 'prom/blackbox-exporter:0.25.0', 'none'],
      ['prometheus', 'prom/prometheus:2.54.1', 'none'],
    ],
  },
  {
    name: 'pir-fs-01',
    ip: '10.30.1.20',
    os: 'Rocky Linux 9.4',
    site: 'site-pir-depot',
    cpu: 8,
    mem: 46,
    disk: 63,
    memGiB: 16,
    diskGiB: 4000,
    uptimeDays: 212,
    seenAgoSec: 18,
    fault: { kind: 'offline', lastSeenMin: 14.5 },
    containers: [
      ['samba', 'dperson/samba:latest', 'none'],
      ['minio', 'minio/minio:RELEASE.2024-08-17', 'none'],
      ['filebrowser', 'filebrowser/filebrowser:v2.30.0', 'none'],
    ],
  },
  {
    name: 'fra-web-01',
    ip: '10.40.1.11',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-fra-dc',
    cpu: 47,
    mem: 62,
    disk: 33,
    memGiB: 32,
    diskGiB: 480,
    uptimeDays: 34,
    seenAgoSec: 6,
    containers: [
      ['nginx', 'nginx:1.27-alpine'],
      ['php-fpm', 'northwind/shop:5.3.1'],
      ['redis', 'redis:7.4-alpine'],
      ['certbot', 'certbot/certbot:v2.11.0', 'none', 'exited', 90],
    ],
  },
  {
    name: 'fra-web-02',
    ip: '10.40.1.12',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-fra-dc',
    cpu: 85,
    mem: 64,
    disk: 35,
    memGiB: 32,
    diskGiB: 480,
    uptimeDays: 34,
    seenAgoSec: 14,
    containers: [
      ['nginx', 'nginx:1.27-alpine'],
      ['php-fpm', 'northwind/shop:5.3.1'],
      ['queue-worker', 'northwind/shop:5.3.1', 'none', 'restarting'],
    ],
  },
  {
    name: 'fra-db-01',
    ip: '10.40.2.10',
    os: 'Debian 13',
    site: 'site-fra-dc',
    cpu: 38,
    mem: 77,
    disk: 62,
    memGiB: 128,
    diskGiB: 2000,
    uptimeDays: 97,
    seenAgoSec: 19,
    containers: [
      ['postgres', 'postgres:16.4'],
      ['pg-exporter', 'prometheuscommunity/postgres-exporter:0.15', 'none'],
      ['pgbackrest', 'woblerr/pgbackrest:2.53', 'none', 'exited', 20],
    ],
  },
  {
    name: 'fra-cache-01',
    ip: '10.40.2.30',
    os: 'Debian 13',
    site: 'site-fra-dc',
    cpu: 9,
    mem: 44,
    disk: 12,
    memGiB: 32,
    diskGiB: 240,
    uptimeDays: 97,
    seenAgoSec: 25,
    containers: [
      ['redis', 'redis:7.4-alpine'],
      ['redis-exporter', 'oliver006/redis_exporter:1.62', 'none'],
    ],
  },
  {
    name: 'muc-pos-01',
    ip: '10.41.1.10',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-muc-stores',
    cpu: 18,
    mem: 41,
    disk: 55,
    memGiB: 16,
    diskGiB: 480,
    uptimeDays: 19,
    seenAgoSec: 28,
    containers: [
      ['pos-api', 'northwind/pos:3.9.2'],
      ['nginx', 'nginx:1.27-alpine'],
      ['mqtt', 'eclipse-mosquitto:2.0', 'none'],
    ],
  },
  {
    name: 'muc-pos-02',
    ip: '10.41.1.11',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-muc-stores',
    cpu: 21,
    mem: 43,
    disk: 52,
    memGiB: 16,
    diskGiB: 480,
    uptimeDays: 19,
    seenAgoSec: 16,
    containers: [
      ['pos-api', 'northwind/pos:3.9.2'],
      ['nginx', 'nginx:1.27-alpine'],
      ['mqtt', 'eclipse-mosquitto:2.0', 'none'],
      ['receipt-printer', 'northwind/printd:1.4.0', 'none', 'dead', 52],
    ],
  },
  {
    name: 'hc-pacs-01',
    ip: '10.50.1.10',
    os: 'Rocky Linux 9.4',
    site: 'site-hc-main',
    cpu: 62,
    mem: 68,
    disk: 78,
    memGiB: 64,
    diskGiB: 8000,
    uptimeDays: 126,
    seenAgoSec: 11,
    containers: [
      ['orthanc', 'jodogne/orthanc:1.12.4'],
      ['nginx', 'nginx:1.27-alpine'],
      ['postgres', 'postgres:16.4'],
    ],
  },
  {
    name: 'hc-ad-01',
    ip: '10.50.1.5',
    os: 'Ubuntu 22.04 LTS',
    site: 'site-hc-main',
    cpu: 11,
    mem: 37,
    disk: 45,
    memGiB: 16,
    diskGiB: 240,
    uptimeDays: 203,
    seenAgoSec: 23,
    containers: [['samba-ad', 'instantlinux/samba-dc:4.20', 'none']],
  },
  {
    name: 'hc-bkp-01',
    ip: '10.51.1.10',
    os: 'Debian 13',
    site: 'site-hc-annex',
    cpu: 71,
    // Near the 95 line on purpose, but with room for the 1.5-point drift: statuses are judged on the
    // rounded value, so 94.5 and above would read "95%" and flip this story server to critical.
    mem: 92.8,
    disk: 66,
    memGiB: 32,
    diskGiB: 12000,
    uptimeDays: 54,
    seenAgoSec: 8,
    containers: [
      ['restic-server', 'restic/rest-server:0.13.0', 'none'],
      ['nginx', 'nginx:1.27-alpine'],
    ],
  },
  {
    name: 'core-ci-01',
    ip: '10.60.1.14',
    os: 'Ubuntu 24.04 LTS',
    site: 'site-core-dc',
    cpu: 17,
    mem: 49,
    disk: 36,
    memGiB: 32,
    diskGiB: 480,
    uptimeDays: 12,
    seenAgoSec: 22,
    fault: { kind: 'never' },
  },
  {
    name: 'core-git-01',
    ip: '10.60.1.10',
    os: 'Debian 13',
    site: 'site-core-dc',
    cpu: 24,
    mem: 52,
    disk: 58,
    memGiB: 32,
    diskGiB: 960,
    uptimeDays: 77,
    seenAgoSec: 15,
    containers: [
      ['gitea', 'gitea/gitea:1.22'],
      ['postgres', 'postgres:16.4'],
      ['runner', 'gitea/act_runner:0.2.10', 'none', 'paused'],
    ],
  },
]

/** Exporters and agents that most hosts also run: the seeded bulk of the container fleet. */
export const SIDECARS: readonly (readonly [name: string, image: string, chance: number])[] = [
  ['node-exporter', 'prom/node-exporter:1.8.2', 0.4],
  ['promtail', 'grafana/promtail:3.1.1', 0.2],
  ['cadvisor', 'gcr.io/cadvisor/cadvisor:v0.49.1', 0.1],
]

/* ----------------------------------------------------------- network probes */

/**
 * A stretch of abnormal behaviour of one target, in minutes before the story
 * anchor. An episode with `toMin` is history (it recovered); one without is
 * ongoing and only exists in the outage story.
 */
export interface EpisodeSpec {
  fromMin: number
  toMin?: number
  /** Typical latency during the episode, ms. */
  latencyMs?: number
  lossPercent?: number
  /** Every probe fails with this backend failure_reason. */
  failure?: string
}

export interface TargetSpec {
  name: string
  address: string
  protocol: ProbeProtocol
  port: number | null
  site: string | null
  /** Typical latency when everything is well, ms. */
  latencyMs: number
  /** Chronic packet loss, percent (ICMP only). */
  lossPercent?: number
  intervalSec?: number
  /** Chance that a single probe fails at random (a flaky link). */
  flaky?: number
  /** The live edge of a short failing run: the last `count` probes failed. Story only. */
  recentFailures?: { count: number; reason: string }
  episodes?: readonly EpisodeSpec[]
}

type TargetExtras = Partial<
  Pick<TargetSpec, 'lossPercent' | 'intervalSec' | 'flaky' | 'recentFailures' | 'episodes'>
>

const icmp = (
  name: string,
  address: string,
  site: string | null,
  latencyMs: number,
  extras: TargetExtras = {},
): TargetSpec => ({ name, address, protocol: 'icmp', port: null, site, latencyMs, ...extras })

const tcp = (
  name: string,
  address: string,
  port: number,
  site: string | null,
  latencyMs: number,
  extras: TargetExtras = {},
): TargetSpec => ({ name, address, protocol: 'tcp', port, site, latencyMs, ...extras })

export const TARGET_SPECS: readonly TargetSpec[] = [
  icmp('ath-gateway', '10.20.0.1', 'site-ath-dc', 0.8, { intervalSec: 30 }),
  icmp('ath-isp-a', '198.51.100.1', 'site-ath-dc', 4.2),
  icmp('ath-isp-b', '198.51.100.9', 'site-ath-dc', 5, {
    episodes: [{ fromMin: 540, toMin: 515, latencyMs: 96, lossPercent: 4 }],
  }),
  icmp('fra-gateway', '10.40.0.1', 'site-fra-dc', 0.9),
  icmp('fra-isp-a', '203.0.113.1', 'site-fra-dc', 9, {
    intervalSec: 30,
    episodes: [{ fromMin: 38, latencyMs: 168, lossPercent: 6 }],
  }),
  icmp('fra-isp-b', '203.0.113.9', 'site-fra-dc', 10.5),
  icmp('pir-gateway', '10.30.0.1', 'site-pir-depot', 1.2, {
    episodes: [{ fromMin: 14, failure: 'host_unreachable' }],
  }),
  icmp('muc-gateway', '10.41.0.1', 'site-muc-stores', 1.4),
  icmp('muc-isp-a', '203.0.113.60', 'site-muc-stores', 12),
  icmp('hc-gateway', '10.50.0.1', 'site-hc-main', 1.1),
  icmp('hc-annex-lte', '192.0.2.201', 'site-hc-annex', 184, { lossPercent: 3 }),
  icmp('core-gateway', '10.60.0.1', 'site-core-dc', 0.7),
  icmp('public-dns', '198.51.100.53', null, 9.1, { lossPercent: 0.4 }),
  icmp('public-dns-2', '203.0.113.53', null, 11.4),

  tcp('ath-api', 'api.meridian.example', 443, 'site-ath-dc', 12.3, {
    episodes: [{ fromMin: 190, toMin: 168, latencyMs: 188 }],
  }),
  tcp('ath-portal', 'portal.meridian.example', 443, 'site-ath-dc', 18),
  tcp('ath-erp', 'erp.meridian.example', 443, 'site-ath-dc', 22),
  tcp('ath-db-vip', '10.20.2.10', 5432, 'site-ath-dc', 1.9),
  tcp('ath-bastion', '10.20.0.20', 22, 'site-ath-dc', 2.4),
  tcp('ath-mon-https', '10.20.3.5', 3000, 'site-ath-dc', 4.5),
  tcp('pir-vpn', '10.30.0.2', 443, 'site-pir-depot', 24, {
    episodes: [{ fromMin: 13, failure: 'timeout' }],
  }),
  tcp('fra-vpn', 'vpn.northwind.example', 443, 'site-fra-dc', 21.1, {
    episodes: [{ fromMin: 36, latencyMs: 181 }],
  }),
  tcp('fra-shop', 'shop.northwind.example', 443, 'site-fra-dc', 31),
  tcp('fra-api', 'api.northwind.example', 443, 'site-fra-dc', 29, {
    episodes: [{ fromMin: 800, toMin: 790, failure: 'timeout' }],
  }),
  tcp('fra-db-vip', '10.40.2.10', 5432, 'site-fra-dc', 2.1),
  tcp('fra-smtp', '203.0.113.25', 25, 'site-fra-dc', 17),
  tcp('muc-vpn', '203.0.113.44', 443, 'site-muc-stores', 27.6, {
    flaky: 0.06,
    recentFailures: { count: 2, reason: 'connection_refused' },
  }),
  tcp('muc-pos-api', '10.41.1.10', 8443, 'site-muc-stores', 3.2),
  tcp('muc-cdn', 'cdn.northwind.example', 443, 'site-muc-stores', 212),
  tcp('hc-pacs-web', '192.0.2.80', 443, 'site-hc-main', 9.7),
  tcp('hc-pacs-dicom', '10.50.1.10', 4242, 'site-hc-main', 3.8),
  tcp('hc-ad-ldaps', '10.50.1.5', 636, 'site-hc-main', 2.2),
  tcp('hc-portal', 'portal.halcyon.example', 443, 'site-hc-main', 15),
  tcp('hc-bkp-rest', '10.51.1.10', 8000, 'site-hc-annex', 4.1),
  tcp('core-git-ssh', '10.60.1.10', 22, 'site-core-dc', 2.6),
  tcp('core-git-https', '10.60.1.10', 443, 'site-core-dc', 3.1),
]

/* --------------------------------------------------------- network devices */

export interface DeviceSpec {
  name: string
  type: DeviceType
  ip: string
  site: string
  reachable: boolean
  responseMs: number
  interfaces: number
  /** Admin-up interfaces whose operational status is not up. */
  down: number
  /** Seconds since the last poll attempt. */
  pollAgoSec: number
}

/** SNMP is PLANNED: this is inventory plus invented poll results. */
export const DEVICE_SPECS: readonly DeviceSpec[] = [
  {
    name: 'ath-core-sw1',
    type: 'switch',
    ip: '10.20.0.2',
    site: 'site-ath-dc',
    reachable: true,
    responseMs: 6.1,
    interfaces: 52,
    down: 1,
    pollAgoSec: 96,
  },
  {
    name: 'ath-edge-rtr1',
    type: 'router',
    ip: '10.20.0.3',
    site: 'site-ath-dc',
    reachable: true,
    responseMs: 3.4,
    interfaces: 8,
    down: 0,
    pollAgoSec: 140,
  },
  {
    name: 'ath-fw1',
    type: 'firewall',
    ip: '10.20.0.4',
    site: 'site-ath-dc',
    reachable: true,
    responseMs: 4.8,
    interfaces: 12,
    down: 0,
    pollAgoSec: 71,
  },
  {
    name: 'ath-wlc1',
    type: 'other',
    ip: '10.20.0.8',
    site: 'site-ath-dc',
    reachable: true,
    responseMs: 9.4,
    interfaces: 4,
    down: 0,
    pollAgoSec: 118,
  },
  {
    name: 'pir-sw1',
    type: 'switch',
    ip: '10.30.0.3',
    site: 'site-pir-depot',
    reachable: false,
    responseMs: 0,
    interfaces: 28,
    down: 0,
    pollAgoSec: 62,
  },
  {
    name: 'fra-core-sw1',
    type: 'switch',
    ip: '10.40.0.2',
    site: 'site-fra-dc',
    reachable: true,
    responseMs: 7.9,
    interfaces: 52,
    down: 2,
    pollAgoSec: 188,
  },
  {
    name: 'fra-edge-rtr1',
    type: 'router',
    ip: '10.40.0.3',
    site: 'site-fra-dc',
    reachable: true,
    responseMs: 4.1,
    interfaces: 8,
    down: 0,
    pollAgoSec: 105,
  },
  {
    name: 'fra-fw1',
    type: 'firewall',
    ip: '10.40.0.4',
    site: 'site-fra-dc',
    reachable: true,
    responseMs: 5.2,
    interfaces: 8,
    down: 0,
    pollAgoSec: 120,
  },
  {
    name: 'muc-sw1',
    type: 'switch',
    ip: '10.41.0.2',
    site: 'site-muc-stores',
    reachable: true,
    responseMs: 14.2,
    interfaces: 28,
    down: 0,
    pollAgoSec: 210,
  },
  {
    name: 'hc-core-sw1',
    type: 'switch',
    ip: '10.50.0.2',
    site: 'site-hc-main',
    reachable: true,
    responseMs: 8.6,
    interfaces: 52,
    down: 3,
    pollAgoSec: 160,
  },
  {
    name: 'hc-annex-sw1',
    type: 'switch',
    ip: '10.51.0.2',
    site: 'site-hc-annex',
    reachable: true,
    responseMs: 11.3,
    interfaces: 24,
    down: 0,
    pollAgoSec: 175,
  },
  {
    name: 'core-ups1',
    type: 'other',
    ip: '10.60.0.9',
    site: 'site-core-dc',
    reachable: true,
    responseMs: 18.7,
    interfaces: 2,
    down: 0,
    pollAgoSec: 230,
  },
]

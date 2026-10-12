import type {
  Alert,
  EntityKind,
  HealthStatus,
  NetworkSeries,
  OverviewSummary,
  SiteEntity,
  StatusCounts,
} from '@/api/types'
import { emptyCounts } from '@/lib/status'
import type { VerdictState } from '@/lib/verdict'

/**
 * Static sample data for the gallery. Nothing here comes from an API: the page
 * has to look the same on every visit so that a review compares like with like.
 */

/** The moment the samples were "taken", epoch ms. Fixed so "Showing data from 14:05:12Z" never changes. */
export const SAMPLE_TIME = Date.parse('2026-10-12T14:05:12Z')

export const counts = (over: Partial<StatusCounts> = {}): StatusCounts => ({
  ...emptyCounts(),
  ...over,
})

const total = (parts: StatusCounts) => Object.values(parts).reduce((sum, count) => sum + count, 0)

interface Estate {
  servers: StatusCounts
  containers: StatusCounts
  targets: StatusCounts
}

/** Totals follow from the counts, so a sample can never disagree with itself. */
function summaryOf({ servers, containers, targets }: Estate): OverviewSummary {
  return {
    generatedAt: new Date(SAMPLE_TIME).toISOString(),
    servers: { total: total(servers), online: servers.healthy + servers.warning, counts: servers },
    containers: {
      total: total(containers),
      running: total(containers) - containers.idle,
      counts: containers,
    },
    targets: {
      total: total(targets),
      up: targets.healthy + targets.warning,
      counts: targets,
      successTrend: [99, 99, 98, 99, 100, 99, 97, 98, 99, 100, 99, 99],
    },
    devices: { inInventory: 12, byType: { router: 4, switch: 5, firewall: 2, other: 1 } },
  }
}

/** One estate per verdict the data can produce. NO DATA is not data: it is how old data is judged. */
export const SAMPLE_SUMMARIES: Record<Exclude<VerdictState, 'nodata'>, OverviewSummary> = {
  critical: summaryOf({
    servers: counts({ healthy: 13, warning: 2, critical: 1 }),
    containers: counts({ healthy: 62, warning: 1, critical: 2, idle: 3 }),
    targets: counts({ healthy: 37, warning: 2, critical: 1 }),
  }),
  degraded: summaryOf({
    servers: counts({ healthy: 14, warning: 2 }),
    containers: counts({ healthy: 64, warning: 1, idle: 3 }),
    targets: counts({ healthy: 38, warning: 2 }),
  }),
  partial: summaryOf({
    servers: counts({ healthy: 15, unknown: 1 }),
    containers: counts({ healthy: 65, idle: 3 }),
    targets: counts({ healthy: 40 }),
  }),
  nominal: summaryOf({
    servers: counts({ healthy: 16 }),
    containers: counts({ healthy: 65, idle: 3 }),
    targets: counts({ healthy: 40 }),
  }),
}

/** Three active alerts for the planned Alerts tile. The real thing does not exist: this is sample data. */
export const SAMPLE_ALERTS: Alert[] = [
  {
    id: 'alert-1',
    severity: 'critical',
    state: 'active',
    title: 'Host unreachable',
    message: 'No heartbeat for 5 minutes',
    subject: { kind: 'server', id: 'srv-1', name: 'edge-gw-02' },
    rule: 'heartbeat-missed',
    siteId: null,
    since: '2026-10-12T14:00:00Z',
  },
  {
    id: 'alert-2',
    severity: 'critical',
    state: 'active',
    title: 'Target down',
    message: 'Connection refused',
    subject: { kind: 'target', id: 'tgt-1', name: 'acme-vpn:443' },
    rule: 'probe-failed',
    siteId: null,
    since: '2026-10-12T13:56:00Z',
  },
  {
    id: 'alert-3',
    severity: 'warning',
    state: 'active',
    title: 'Disk almost full',
    message: 'Disk at 91%',
    subject: { kind: 'server', id: 'srv-2', name: 'backup-01' },
    rule: 'disk-high',
    siteId: null,
    since: '2026-10-12T13:30:00Z',
  },
]

/* ----------------------------------------------------------------- entities */

const KIND_PREFIX: Record<EntityKind, string> = {
  server: 'srv',
  container: 'ctr',
  target: 'net',
  device: 'dev',
}

function entitiesOf(kind: EntityKind, statuses: readonly HealthStatus[]): SiteEntity[] {
  const prefix = KIND_PREFIX[kind]
  return statuses.map((status, index) => ({
    id: `${prefix}-${index + 1}`,
    kind,
    name: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    status,
  }))
}

const run = (status: HealthStatus, length: number): HealthStatus[] =>
  Array.from({ length }, () => status)

/**
 * `size` servers in a fixed mix: one of each problem status near the front, the
 * rest healthy, so strips of different lengths show the same worst-first grammar.
 */
export function stripEntities(size: number): SiteEntity[] {
  const problems: Record<number, HealthStatus> = {
    0: 'critical',
    3: 'warning',
    7: 'unknown',
    11: 'idle',
  }
  return entitiesOf(
    'server',
    Array.from({ length: size }, (_, index) => problems[index] ?? 'healthy'),
  )
}

/** One site of the interactive grid: every kind, every status. */
export const GRID_ENTITIES: SiteEntity[] = [
  ...entitiesOf('server', ['critical', 'warning', ...run('healthy', 4)]),
  ...entitiesOf('container', [
    'critical',
    'warning',
    'unknown',
    'idle',
    'idle',
    ...run('healthy', 7),
  ]),
  ...entitiesOf('target', ['critical', ...run('healthy', 5)]),
  ...entitiesOf('device', ['unknown', ...run('healthy', 3)]),
]

/* ------------------------------------------------------------------- chart */

const BUCKETS = 30
const SERIES_START = Date.parse('2026-10-12T13:36:00Z')
/** One minute with no usable measurement: a gap in both lines and a failed-probe mark. */
const GAP = 19

/** Thirty one-minute buckets: a gentle wave, a missed minute, then a climb in latency and loss. */
function sampleSeries(): NetworkSeries {
  const buckets = Array.from({ length: BUCKETS }, (_, index) => index)
  const measured = (value: (index: number) => number) =>
    buckets.map((index) => (index === GAP ? null : value(index)))
  const p95 = (index: number) =>
    Math.round(105 + 30 * Math.sin(index / 3.2) + Math.max(0, index - 23) * 14)
  return {
    generatedAt: new Date(SERIES_START + BUCKETS * 60_000).toISOString(),
    bucketMs: 60_000,
    t: buckets.map((index) => SERIES_START + index * 60_000),
    p95: measured(p95),
    p50: measured((index) => Math.round(p95(index) * 0.55)),
    lossMean: measured((index) => (index >= 24 ? 2.4 : index % 9 === 4 ? 1.1 : 0.2)),
    failedProbes: buckets.map((index) => (index === GAP ? 2 : 0)),
    probeCount: buckets.map((index) => (index === GAP ? 38 : 40)),
    targetCount: 40,
  }
}

export const SAMPLE_SERIES: NetworkSeries = sampleSeries()

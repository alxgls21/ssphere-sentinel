import type {
  EntityKind,
  NetworkSeries,
  OverviewSummary,
  SiteEntity,
  StatusCounts,
} from '@/api/types'
import { emptyCounts, healthOf, type DisplayStatus } from '@/lib/status'
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

/** Offline servers are already inside critical, so only the five health statuses add up. */
const total = ({ healthy, warning, critical, unknown, idle }: StatusCounts) =>
  healthy + warning + critical + unknown + idle

interface Estate {
  servers: StatusCounts
  containers: StatusCounts
}

/** Totals follow from the counts, so a sample can never disagree with itself. */
export function summaryOf({ servers, containers }: Estate): OverviewSummary {
  return {
    generatedAt: new Date(SAMPLE_TIME).toISOString(),
    servers: { total: total(servers), counts: servers },
    containers: { total: total(containers), counts: containers },
    targets: { total: 0, counts: counts() },
    devices: { total: 0, counts: counts() },
  }
}

/** One estate per verdict the data can produce. NO DATA is not data: it is how old data is judged. */
export const SAMPLE_SUMMARIES: Record<Exclude<VerdictState, 'nodata'>, OverviewSummary> = {
  critical: summaryOf({
    servers: counts({ healthy: 13, warning: 2, critical: 1 }),
    containers: counts({ healthy: 62, warning: 1, critical: 2, idle: 3 }),
  }),
  degraded: summaryOf({
    servers: counts({ healthy: 14, warning: 2 }),
    containers: counts({ healthy: 64, warning: 1, idle: 3 }),
  }),
  partial: summaryOf({
    servers: counts({ healthy: 15, unknown: 1 }),
    containers: counts({ healthy: 65, idle: 3 }),
  }),
  nominal: summaryOf({
    servers: counts({ healthy: 16 }),
    containers: counts({ healthy: 65, idle: 3 }),
  }),
}

/* ----------------------------------------------------------------- entities */

const KIND_PREFIX: Record<EntityKind, string> = {
  server: 'srv',
  container: 'ctr',
  target: 'net',
  device: 'dev',
}

/** An entity per shown state: offline is a server that is critical and flagged, as the API serves it. */
function entitiesOf(kind: EntityKind, statuses: readonly DisplayStatus[]): SiteEntity[] {
  const prefix = KIND_PREFIX[kind]
  return statuses.map((status, index) => ({
    id: `${prefix}-${index + 1}`,
    kind,
    name: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    status: healthOf(status),
    ...(status === 'offline' ? { offline: true } : {}),
  }))
}

const run = (status: DisplayStatus, length: number): DisplayStatus[] =>
  Array.from({ length }, () => status)

/**
 * `size` servers in a fixed mix: one of each problem status near the front, the
 * rest healthy, so strips of different lengths show the same worst-first grammar.
 * `extra` marks more positions (an offline server, say).
 */
export function stripEntities(
  size: number,
  extra: Record<number, DisplayStatus> = {},
): SiteEntity[] {
  const marked: Record<number, DisplayStatus> = {
    0: 'critical',
    3: 'warning',
    7: 'unknown',
    11: 'idle',
    ...extra,
  }
  return entitiesOf(
    'server',
    Array.from({ length: size }, (_, index) => marked[index] ?? 'healthy'),
  )
}

/** One site of the interactive grid: every kind, every status. */
export const GRID_ENTITIES: SiteEntity[] = [
  ...entitiesOf('server', ['critical', 'offline', 'warning', ...run('healthy', 3)]),
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

/* -------------------------------------------------------------- sparklines */

const MINUTE = 60_000
/** The last 60 one-minute buckets: the hour a server's resource history covers. */
const SPARK_TIMES = Array.from(
  { length: 60 },
  (_, index) => Math.floor(SAMPLE_TIME / MINUTE) * MINUTE - (59 - index) * MINUTE,
)
const cpu = (index: number) => Math.round(32 + 14 * Math.sin(index / 6) + (index % 5) * 2)
const keep = (indexes: readonly number[]) =>
  SPARK_TIMES.map((_, index) => (indexes.includes(index) ? cpu(index) : null))

export interface SparkSpecimen {
  name: string
  label: string
  /** Oldest first; null where a bucket held no sample. */
  values: (number | null)[]
  /** Start of each bucket, epoch ms. */
  times: number[]
}

/** A server's CPU over its last hour, in the shapes a series can take. */
export const SPARK_SPECIMENS: readonly SparkSpecimen[] = [
  {
    name: 'With a gap',
    label: 'CPU history of api-01, last hour',
    values: SPARK_TIMES.map((_, index) => (index >= 22 && index < 32 ? null : cpu(index))),
    times: SPARK_TIMES,
  },
  {
    name: 'Stopped reporting',
    label: 'CPU history of api-01, last hour',
    values: SPARK_TIMES.map((_, index) => (index >= 46 ? null : cpu(index))),
    times: SPARK_TIMES,
  },
  {
    name: 'Lone samples',
    label: 'CPU history of api-01, last hour',
    values: keep([4, 12, 13, 14, 15, 28, 40, 41, 42, 55, 56, 57, 58, 59]),
    times: SPARK_TIMES,
  },
  {
    name: 'Short',
    label: 'CPU history of api-01, last 2 minutes',
    values: [38, 52],
    times: SPARK_TIMES.slice(-2),
  },
]

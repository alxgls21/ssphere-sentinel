/**
 * Domain view-models consumed by the UI.
 *
 * These mirror the concepts of the Django backend (Server, DockerContainer,
 * NetworkTarget, Device, Customer, Site, ...) but they are the UI's own
 * contract. The console API serves some of it already (session, scope, servers,
 * containers, server history) and not the rest; an HTTP implementation of
 * `SentinelApi` (see ./client.ts) maps the real payloads onto these types and
 * nothing under src/features has to change.
 *
 * Conventions: timestamps are ISO-8601 UTC strings (or epoch ms inside time
 * series); durations are seconds; percentages are 0-100; latencies are
 * milliseconds; rates are bits/second.
 */

export type Iso = string

/**
 * The UI-wide status vocabulary. Every domain state maps onto one of these
 * (see src/lib/status.ts).
 *
 *   healthy   up and within thresholds
 *   warning   degraded
 *   critical  down or failing
 *   unknown   no data / not reported: asserts nothing, but needs a look
 *   idle      deliberately not running (exited, created, paused): neutral,
 *             not counted as needing attention
 */
export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown' | 'idle'

export type StatusCounts = Record<HealthStatus, number> & {
  /**
   * Of `critical`, the servers whose agent stopped reporting. Already counted in
   * `critical`: totals, the verdict and the badges read `critical`, and only a
   * composition that breaks the counts down shows this one apart. Absent when none.
   */
  offline?: number
}

export type RangeKey = '15m' | '1h' | '6h' | '24h'

/** Narrows every query to a customer and/or one of its sites. null = no filter. */
export interface Scope {
  customerId: string | null
  siteId: string | null
}

export const ALL_SCOPE: Scope = { customerId: null, siteId: null }

/** Common request shape. Every API method accepts a scope and an abort signal. */
export interface RequestOptions {
  scope?: Scope
  signal?: AbortSignal
}

/* ------------------------------------------------------------ organization */

export interface Customer {
  id: string
  name: string
}

export interface Site {
  id: string
  customerId: string
  name: string
}

export interface ScopeOptions {
  customers: Customer[]
  sites: Site[]
}

/* ----------------------------------------------------------------- servers */

/** Mirrors backend `Server.Status`. */
export type ServerStatus = 'online' | 'offline' | 'warning' | 'unknown'

export interface Server {
  id: string
  name: string
  hostname: string
  ipAddress: string | null
  operatingSystem: string
  status: ServerStatus
  /** The site the server is placed on in the admin; null when it is on none (see `site-links`). */
  siteId: string | null
  lastSeenAt: Iso | null
  agentVersion: string
  /** The latest telemetry; null until the first report. History is `ServerSeries`. */
  telemetry: ServerTelemetry | null
}

export interface ServerTelemetry {
  cpuPercent: number
  memoryPercent: number
  diskPercent: number
  memoryTotalBytes: number
  diskTotalBytes: number
  uptimeSeconds: number
  collectedAt: Iso
  /**
   * When the console API accepted the reading. Served by the console API; absent in demo data.
   * With `stale` it says how current the reading is, which is not the same as the heartbeat.
   */
  receivedAt?: Iso
  /**
   * The reading is older than the offline window: it is the last one received, not the present
   * value, and takes no part in health or load ranking. Absent (demo data) means current.
   */
  stale?: boolean
}

/* ------------------------------------------------------------------ docker */

/** Mirrors backend `DockerContainer.State` / `.Health`. */
export type ContainerState =
  'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | 'unknown'
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none' | 'unknown'

export interface DockerContainer {
  id: string
  serverId: string
  name: string
  image: string
  state: ContainerState
  health: ContainerHealth
  startedAt: Iso | null
}

/* ------------------------------------------------------------------ events */

export type SubjectKind = 'server' | 'container' | 'target' | 'device' | 'interface' | 'site'

export interface SubjectRef {
  kind: SubjectKind
  id: string
  name: string
}

export type EventLevel = 'info' | 'healthy' | 'warning' | 'critical'

/** One entry of an event log. The backend has none, so no screen reads this yet. */
export interface SentinelEvent {
  id: string
  at: Iso
  level: EventLevel
  subject: SubjectRef
  message: string
  /** Causally related earlier event (a recovery nests under its failure). */
  parentId?: string
}

/* ------------------------------------------------------------ overview data */

export type EntityKind = 'server' | 'container' | 'target' | 'device'

/**
 * Headline counts for the verdict, the sidebar badges and the tiles. Only what the console API
 * counts: servers and containers. Probe targets, SNMP devices, alerts and incidents have no
 * answer here, and none is made up.
 */
export interface OverviewSummary {
  generatedAt: Iso
  /** `total` is every server in scope; `counts` is by health status, with the offline share where known. */
  servers: { total: number; counts: StatusCounts }
  containers: { total: number; counts: StatusCounts }
}

export type AttentionSeverity = 'critical' | 'warning' | 'unknown' | 'idle'

export interface AttentionItem {
  kind: 'server' | 'container'
  id: string
  name: string
  severity: AttentionSeverity
  /** Domain word for the status tag: OFFLINE, UNHEALTHY, RESTARTING, ... */
  stateLabel: string
  /** A server whose agent stopped reporting: critical in `severity`, described apart wherever it is shown. */
  offline?: boolean
  /** One line built only from ingested fields (state, health, host, last seen, cpu/memory/disk). */
  detail: string
  hostName?: string
  customerName?: string
  siteName?: string
  /** When the problem is known to have started or last been seen. null = no timestamp exists. */
  ageIso: Iso | null
  ageBasis: 'last-seen' | 'failing-since' | null
}

export interface AttentionOptions extends RequestOptions {
  includeIdle?: boolean
}

export interface AttentionResult {
  generatedAt: Iso
  /** Sorted: severity desc, newest first, then name. */
  items: AttentionItem[]
  /** Idle containers left out of `items`: not asked for, or beyond the rows one request returns. */
  hiddenIdle: number
  /**
   * Problems (critical, warning, unknown) that exist but are not in `items`, because the lists
   * the queue is built from return only the worst rows of each. Absent or 0: the queue is whole.
   */
  omitted?: number
}

/**
 * Aggregated probe measurements, one entry per time bucket (parallel arrays).
 * `t` holds completed buckets only, so the newest point can lag "now" by up to
 * one bucket. `lossMean` excludes failed measurements (those are `failedProbes`).
 * With nothing monitored every array is empty.
 */
export interface NetworkSeries {
  generatedAt: Iso
  bucketMs: number
  /** Bucket start, epoch ms. */
  t: number[]
  /** Latency percentiles across targets that succeeded in the bucket; null = no data. */
  p50: (number | null)[]
  p95: (number | null)[]
  /** Mean packet loss (0-100) across ICMP measurements in the bucket. */
  lossMean: (number | null)[]
  failedProbes: number[]
  probeCount: number[]
  targetCount: number
}

export type LoadMetric = 'cpu' | 'memory' | 'disk'

export interface FleetLoadOptions extends RequestOptions {
  metric: LoadMetric
  limit?: number
}

export interface FleetLoadRow {
  serverId: string
  name: string
  percent: number
  collectedAt: Iso
}

export interface FleetLoad {
  generatedAt: Iso
  rows: FleetLoadRow[]
  /** Servers with no usable sample (offline, never reported). */
  excluded: string[]
}

export interface DomainBreakdown {
  domain: 'servers' | 'containers' | 'targets' | 'snmp'
  label: string
  counts: StatusCounts
  /** True when the console API serves nothing for this domain (probe targets, SNMP): no figure is shown. */
  planned?: boolean
}

export interface SiteEntity {
  id: string
  kind: EntityKind
  name: string
  status: HealthStatus
  /** A server whose agent stopped reporting: critical in `status`, described apart wherever it is shown. */
  offline?: boolean
}

export interface SiteBreakdown {
  siteId: string
  customerName: string
  siteName: string
  /** The servers and containers placed on the site, worst first. */
  entities: SiteEntity[]
}

/**
 * What the per-site rows rest on. `all`: every server and container is in them. `problems`: only
 * the ones that need attention are (every one of them is, but healthy and idle ones are not
 * counted per site). `none`: the problems alone do not fit the rows the API returns, so no
 * per-site figure is given. Absent means `all`.
 */
export type SiteCoverage = 'all' | 'problems' | 'none'

export interface HealthBreakdown {
  generatedAt: Iso
  domains: DomainBreakdown[]
  /** Worst site first. */
  sites: SiteBreakdown[]
  siteCoverage?: SiteCoverage
}

/** Every searchable thing, for the command palette. */
export interface EntityIndexItem {
  id: string
  kind: EntityKind | 'site' | 'customer'
  name: string
  /** Hostname, address, image, ...: matched by search and shown as the subtitle. */
  detail: string
  status: HealthStatus
  /** A server whose agent stopped reporting: critical in `status`, described apart wherever it is shown. */
  offline?: boolean
  customerName?: string
  siteName?: string
}

export interface EntityIndex {
  generatedAt: Iso
  items: EntityIndexItem[]
}

/* ---------------------------------------------------------- container lists */

/** A container with where it runs, as the fleet-wide list serves it. */
export interface ContainerListItem extends ServerContainer {
  serverName: string
  customerName?: string
  siteName?: string
}

export interface ContainerListOptions extends RequestOptions {
  /** Words, every one of which must appear in the name, image, Docker id, server, site or customer. */
  q?: string
  /** Only the containers of this server (its id). */
  server?: string
  status?: 'all' | 'critical' | 'warning' | 'unknown' | 'idle' | 'healthy'
  sort?: 'status' | 'name' | 'server' | 'started'
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface ContainerList {
  generatedAt: Iso
  items: ContainerListItem[]
  page: PageInfo
  /** Per health status over the scope, the server and the search, not the status filter: what each filter chip would show. */
  counts: StatusCounts
  /** Containers in the scope (and of the server asked for), whatever the search. */
  scopeTotal: number
}

/* ------------------------------------------------------------ servers screen */

/** One server as the list and the detail page show it: the record, its health and where it lives. */
export interface ServerListItem {
  server: Server
  /** Heartbeat status combined with the resource thresholds (src/lib/status.ts). */
  health: HealthStatus
  customerName?: string
  siteName?: string
  /** Containers last reported by the host's Docker agent. */
  containers: { total: number; counts: StatusCounts }
}

/** One page of a paginated list, as the console API reports it. `number` is 1-based. */
export interface PageInfo {
  number: number
  size: number
  /** Items that match the query, across every page. */
  total: number
  pages: number
}

export type ServerStatusFilter = 'all' | 'critical' | 'warning' | 'unknown' | 'healthy'
export type ServerSortKey = 'status' | 'name' | 'cpu' | 'memory' | 'disk' | 'uptime' | 'seen'
export type SortDirection = 'asc' | 'desc'

/** What the Servers list asks for. Search, filter, sort and paging are the answerer's job. */
export interface ServerListOptions extends RequestOptions {
  /** Words, every one of which must appear in the name, hostname, address, OS, site or customer. */
  q?: string
  status?: ServerStatusFilter
  sort?: ServerSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface ServerList {
  generatedAt: Iso
  /** The requested page of servers that match the query. */
  items: ServerListItem[]
  page: PageInfo
  /** Per health status over the scope and the search, not the status filter: what each filter chip would show. */
  counts: StatusCounts
  /** Servers in the scope, whatever the search. */
  scopeTotal: number
}

export interface ServerContainer {
  container: DockerContainer
  status: HealthStatus
}

export interface ServerDetail {
  generatedAt: Iso
  item: ServerListItem
  containers: ServerContainer[]
}

export interface ServerSeriesOptions extends Pick<RequestOptions, 'signal'> {
  serverId: string
  range: RangeKey
}

/**
 * CPU, memory and disk history of one server, one entry per bucket (parallel
 * arrays, null = no sample). The console API serves it
 * (`servers/<id>/series/`); the demo data builds it until the screen is connected.
 */
export interface ServerSeries {
  generatedAt: Iso
  bucketMs: number
  /** Bucket start, epoch ms. */
  t: number[]
  cpu: (number | null)[]
  memory: (number | null)[]
  disk: (number | null)[]
}

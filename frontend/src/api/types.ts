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
  /** The backend has no Site link for servers yet: sample data (see `site-links`). */
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

/* ----------------------------------------------------------- network probes */

export type ProbeProtocol = 'icmp' | 'tcp'
export type ProbeStatus = 'up' | 'degraded' | 'down' | 'unknown'

export interface NetworkTarget {
  id: string
  name: string
  address: string
  protocol: ProbeProtocol
  port: number | null
  status: ProbeStatus
  /** The backend has no Site link for targets yet: sample data (see `site-links`). */
  siteId: string | null
  latencyMs: number | null
  packetLossPercent: number
  /** Last time a probe completed (success or failure). */
  lastProbeAt: Iso | null
  /** Start of the current run of failed measurements; null while healthy. */
  failingSince: Iso | null
  /** Consecutive failed measurements in the current run. */
  consecutiveFailures: number
  failureReason: string
}

/* ------------------------------------------------- network devices (SNMP) */

export type DeviceType = 'router' | 'switch' | 'firewall' | 'other'

export interface NetworkDevice {
  id: string
  name: string
  deviceType: DeviceType
  managementAddress: string
  siteId: string | null
  reachable: boolean
  responseMs: number | null
  lastPollAt: Iso | null
  interfacesTotal: number
  /** Admin-up interfaces whose operational status is not "up". */
  interfacesDown: number
}

/* ---------------------------------------------------------- alerts & events */

export type AlertSeverity = 'critical' | 'warning'
export type AlertState = 'active' | 'acknowledged'
export type SubjectKind = 'server' | 'container' | 'target' | 'device' | 'interface' | 'site'

export interface SubjectRef {
  kind: SubjectKind
  id: string
  name: string
}

/** PLANNED: the backend has no alert engine. Always sample data. */
export interface Alert {
  id: string
  severity: AlertSeverity
  state: AlertState
  title: string
  message: string
  subject: SubjectRef
  rule: string
  siteId: string | null
  since: Iso
}

export type EventLevel = 'info' | 'healthy' | 'warning' | 'critical'

/** PLANNED: the backend has no event log. Always sample data. */
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

/** Headline counts for the verdict, the sidebar badges and the tiles. */
export interface OverviewSummary {
  generatedAt: Iso
  servers: { total: number; online: number; counts: StatusCounts }
  containers: { total: number; running: number; counts: StatusCounts }
  targets: {
    total: number
    up: number
    counts: StatusCounts
    /** Success rate (0-100) per bucket over the last hour, oldest first (12 points; empty when nothing is monitored). */
    successTrend: number[]
  }
  /** SNMP devices. PLANNED: inventory only, nothing is collected. */
  devices: { inInventory: number; byType: Record<DeviceType, number> }
}

export type AttentionSeverity = 'critical' | 'warning' | 'unknown' | 'idle'

export interface AttentionItem {
  kind: 'server' | 'container' | 'target'
  id: string
  name: string
  /** Probe protocol, set for kind 'target' so the row can read "tcp acme-vpn" / "icmp 10.20.0.1". */
  protocol?: ProbeProtocol
  severity: AttentionSeverity
  /** Domain word for the status tag: OFFLINE, UNHEALTHY, RESTARTING, DOWN, ... */
  stateLabel: string
  /** A server whose agent stopped reporting: critical in `severity`, described apart wherever it is shown. */
  offline?: boolean
  /** One line built only from ingested fields (state, health, last seen, failure reason, latency, loss, cpu/disk). */
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
  /** Idle items left out of `items` (shown behind a "+N hidden" toggle). */
  hiddenIdle: number
}

export interface NetworkSeriesOptions extends RequestOptions {
  range: RangeKey
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
  /** True when the console shows no real data for this domain (SNMP: the console does not read it yet). */
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
  /** Sample data until the backend links servers and targets to sites. */
  entities: SiteEntity[]
}

export interface HealthBreakdown {
  generatedAt: Iso
  domains: DomainBreakdown[]
  /** Worst site first. */
  sites: SiteBreakdown[]
}

export interface AlertsOptions extends RequestOptions {
  state?: AlertState
  limit?: number
}

export interface EventsOptions extends RequestOptions {
  range?: RangeKey
  limit?: number
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

export interface ServerList {
  generatedAt: Iso
  items: ServerListItem[]
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

import type { PublishedThresholds } from './auth'
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
  /** Free text about the host. Served by the console API; absent in demo data. */
  description?: string
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

type SubjectKind = 'server' | 'container' | 'target' | 'device' | 'interface' | 'site'

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
 * Headline counts for the verdict and the tiles. Only what the console API counts: servers,
 * containers and probe targets, each with the API's own total and counts over the whole scope.
 * SNMP devices, alerts and incidents have no answer here, and none is made up.
 */
export interface OverviewSummary {
  generatedAt: Iso
  /** `total` is every server in scope; `counts` is by health status, with the offline share where known. */
  servers: { total: number; counts: StatusCounts }
  containers: { total: number; counts: StatusCounts }
  targets: { total: number; counts: StatusCounts }
  /** `total` is every SNMP device in scope; `counts` is the devices by health, never their interfaces. */
  devices: { total: number; counts: StatusCounts }
}

export type AttentionSeverity = 'critical' | 'warning' | 'unknown' | 'idle'

export interface AttentionItem {
  kind: 'server' | 'container' | 'target' | 'device'
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
  ageBasis: 'last-seen' | 'last-measured' | 'last-polled' | 'failing-since' | null
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

/**
 * The interfaces of the SNMP devices the rows hold, counted by the interface's own health: up is
 * healthy, down a warning, admin down idle, and an interface of a device that is not current
 * unknown. The API counts interfaces per device, not for the scope, so this is a sum of the rows:
 * the whole scope when `complete`, otherwise only the first `devices` of `of` devices.
 */
export interface InterfaceFigures {
  total: number
  counts: StatusCounts
  /** Devices whose interfaces are summed. */
  devices: number
  /** Devices in the scope. */
  of: number
  /** Every device in scope is among the rows: the sum is the scope's. */
  complete: boolean
}

export interface DomainBreakdown {
  domain: 'servers' | 'containers' | 'targets' | 'snmp'
  label: string
  counts: StatusCounts
  /** SNMP devices only: their interfaces, and how much of the scope that sum reaches. */
  interfaces?: InterfaceFigures
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

/** The agent enrolled for a server: who reports for it. Never its token, nor the token's hash. */
export interface MonitoringAgent {
  id: string
  name: string
  /** A disabled agent's heartbeats are refused; enabling it again needs no new token. */
  enabled: boolean
  lastSeenAt: Iso | null
  agentVersion: string
  createdAt: Iso
  updatedAt: Iso
}

export interface ServerDetail {
  generatedAt: Iso
  item: ServerListItem
  /** Null for a server that has no agent yet (added in the admin, or its agent not created yet). */
  agent: MonitoringAgent | null
  containers: ServerContainer[]
}

/** What adding a server sends. Only the name is required; a blank hostname takes the name. */
export interface ServerInput {
  name: string
  hostname?: string
  description?: string
  operatingSystem?: string
  /** An IPv4 or IPv6 address; null for none. */
  ipAddress?: string | null
  /** The site the server is placed on; null for none (seen by accounts with every customer only). */
  siteId?: string | null
}

/** A change to a server: only the fields that change (the same fields as `ServerInput`). */
export type ServerPatch = Partial<ServerInput>

/** What deleting a server did: what went with it, and what only lost its agent. */
export interface ServerDeleted {
  generatedAt: Iso
  deleted: {
    id: string
    name: string
    /** It had an agent, which is gone with it (its token stopped working at once). */
    agent: boolean
    telemetrySamples: number
    containers: number
    /** Network measurements its agent reported, kept without their agent. */
    measurementsKept: number
    targetsUnassigned: number
    devicesUnassigned: number
  }
}

/** What adding an agent sends: its name, or nothing (the server's name). */
export interface AgentInput {
  name?: string
}

/** An agent of a visible server, for choosing which agent probes a target or polls a device. */
export interface AgentOption {
  id: string
  name: string
  enabled: boolean
  status: 'online' | 'offline' | 'unknown'
  lastSeenAt: Iso | null
  serverId: string
  serverName: string
}

export interface AgentOptionList {
  generatedAt: Iso
  items: AgentOption[]
  page: PageInfo
}

export interface AgentListOptions extends Pick<RequestOptions, 'signal'> {
  /** Words, every one of which must appear in the agent's or the server's name. */
  q?: string
  page?: number
  pageSize?: number
}

/**
 * The one answer that carries an agent's plaintext token: when the agent is created and when its
 * token is rotated. The server never answers it again, and the console never keeps it: not in the
 * URL, the history, any storage or any cache. `serverUrl` is the address the agent must use; null
 * while the server has no `SENTINEL_URL` (it never guesses one from the request in production).
 */
export interface AgentEnrollment {
  generatedAt: Iso
  item: MonitoringAgent
  token: string
  serverUrl: string | null
}

/** An agent as it now is, after it was enabled or disabled. */
export interface AgentChange {
  generatedAt: Iso
  item: MonitoringAgent
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

/* ---------------------------------------------------------- network targets */

export type TargetProtocol = 'icmp' | 'tcp'

/**
 * Why the console API gave a target its health, in its own terms:
 *   disabled         the target is switched off (idle)
 *   no_agent         no agent is assigned to measure it (unknown)
 *   agent_offline    its agent is disabled or has stopped reporting (unknown)
 *   no_measurement   nothing has been measured yet (unknown)
 *   stale            the newest measurement is too old to describe the present (unknown)
 *   failing          the latest measurements all failed (critical)
 *   failed           the latest measurement failed (warning)
 *   latency, loss    it answered, but slowly or lossily (warning)
 *   ok               it answered within the limits (healthy)
 */
export type TargetReason =
  | 'disabled'
  | 'no_agent'
  | 'agent_offline'
  | 'no_measurement'
  | 'stale'
  | 'failing'
  | 'failed'
  | 'latency'
  | 'loss'
  | 'ok'

/** The agent that measures a target, when one is assigned and its server is visible to the user. */
export interface TargetAgent {
  id: string
  name: string
  /** `online`, `offline`, or `unknown` when it has never been seen. */
  status: 'online' | 'offline' | 'unknown'
  lastSeenAt: Iso | null
  /** The server the agent runs on: only given where the user may see it, so a link needs no more check. */
  serverId: string
  serverName: string
}

export interface TargetConfig {
  id: string
  name: string
  address: string
  protocol: TargetProtocol
  /** The TCP port; null for ICMP. */
  port: number | null
  enabled: boolean
  intervalSeconds: number
  timeoutSeconds: number
  /** The SLA expectation, informational (0-100). */
  expectedSlaPercent: number
  /** A free-text label for reports. It says nothing about who sees the target: the site does. */
  customerLabel: string | null
  circuitId: string | null
  siteId: string | null
  /** An agent is assigned, whether or not the user may see its server. */
  agentAssigned: boolean
  agent: TargetAgent | null
}

/**
 * The target's entry for the agent's targets file (agent/network_targets.example.json), by the
 * agent's own keys: what an operator copies into the file on the host that probes it.
 */
export interface TargetAgentEntry {
  id: string
  name: string
  hostname_or_ip: string
  protocol: TargetProtocol
  port: number | null
  enabled: boolean
  monitoring_interval_seconds: number
  timeout_seconds: number
  probe_count: number
}

/**
 * One round of an agent's probes. `success`: at least one probe was answered. `latencyMs`: the mean
 * round trip of the ones that were (null when none was). `lossPercent`: the share that was not; for
 * an ICMP target that is lost packets, for a TCP target failed connection attempts.
 */
export interface TargetMeasurement {
  measuredAt: Iso
  receivedAt: Iso
  success: boolean
  latencyMs: number | null
  lossPercent: number
  probeCount: number
  successfulProbes: number
  failureReason: string | null
}

export interface TargetListItem {
  target: TargetConfig
  /** The newest measurement by when it was taken, whatever its age; null if never measured. */
  latest: TargetMeasurement | null
  /** There is a latest measurement and it is no longer current: it takes no part in `health`. */
  stale: boolean
  health: HealthStatus
  reason: TargetReason
  customerName?: string
  siteName?: string
}

export type TargetStatusFilter = 'all' | 'critical' | 'warning' | 'unknown' | 'idle' | 'healthy'
export type TargetSortKey = 'status' | 'name' | 'latency' | 'loss' | 'measured'

export interface TargetListOptions extends RequestOptions {
  /** Words, every one of which must appear in the name, address, circuit id, site or customer. */
  q?: string
  status?: TargetStatusFilter
  sort?: TargetSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface TargetList {
  generatedAt: Iso
  items: TargetListItem[]
  page: PageInfo
  /** Per health status over the scope and the search, not the status filter. */
  counts: StatusCounts
  /** Targets in the scope, whatever the search. */
  scopeTotal: number
}

/**
 * What the last 24 hours observed. `percent` is the share of the measurements taken that succeeded
 * (null without any): an observation, not an SLA or an uptime guarantee. `coveragePercent` says how
 * much of the window the agent measured at all, against the measurements its interval would give.
 */
export interface TargetAvailability {
  from: Iso
  to: Iso
  measurements: number
  successful: number
  percent: number | null
  expectedMeasurements: number
  coveragePercent: number | null
}

export interface TargetDetail {
  generatedAt: Iso
  item: TargetListItem
  /** The newest measurements, newest first. */
  measurements: TargetMeasurement[]
  availability24h: TargetAvailability
  /** The line the agent's targets file needs for this target. */
  agentEntry: TargetAgentEntry
}

/** What adding a target sends (`name`, `address` and `protocol` required); the server fills the rest with its defaults. */
export interface TargetInput {
  name: string
  address: string
  protocol: TargetProtocol
  /** A TCP target needs one; an ICMP target must have none (null). */
  port?: number | null
  enabled?: boolean
  intervalSeconds?: number
  timeoutSeconds?: number
  expectedSlaPercent?: number
  customerLabel?: string
  circuitId?: string
  /** Null: no site (seen by accounts with every customer only). */
  siteId?: string | null
  /** The agent that probes it; null for none (nothing measures it). */
  agentId?: string | null
}

/** A change: only the fields that change. */
export type TargetPatch = Partial<TargetInput>

export interface TargetDeleted {
  generatedAt: Iso
  deleted: { id: string; name: string; measurements: number }
}

export interface TargetSeriesOptions extends Pick<RequestOptions, 'signal'> {
  targetId: string
  range: RangeKey
}

/**
 * A target's history, one entry per completed bucket (parallel arrays, oldest first). `latencyMs` and
 * `latencyMaxMs` are the mean and the highest latency of the measurements that succeeded; `lossPercent`
 * their mean loss; all are null where a bucket has no such measurement. `measurements` and `failed`
 * are counts (0 for an empty bucket): a failed measurement is counted in `failed`, never as 100% loss.
 * A target never measured has empty arrays.
 */
export interface TargetSeries {
  generatedAt: Iso
  bucketMs: number
  t: number[]
  latencyMs: (number | null)[]
  latencyMaxMs: (number | null)[]
  lossPercent: (number | null)[]
  measurements: number[]
  failed: number[]
}

/* -------------------------------------------------------------- SNMP devices */

export type DeviceType = 'router' | 'switch' | 'firewall' | 'other'
export type SnmpVersion = '2c' | '3'

/**
 * Why the console API gave a device its health:
 *   disabled       the device is switched off (idle)
 *   no_agent       no agent is assigned to poll it (unknown)
 *   agent_offline  its agent is disabled or has stopped reporting (unknown)
 *   no_poll        it has never been polled (unknown)
 *   stale          the latest poll is too old to describe the present (unknown)
 *   unreachable    the latest poll could not reach it (critical)
 *   ok             the latest poll reached it (healthy)
 * A device's interfaces never change its health: a switch with unused ports down is healthy.
 */
export type DeviceReason =
  'disabled' | 'no_agent' | 'agent_offline' | 'no_poll' | 'stale' | 'unreachable' | 'ok'

/**
 * Why an interface has its health:
 *   device_unavailable  its device is not healthy, so the stored status is last-known (unknown)
 *   absent              not in the device's latest complete listing (unknown)
 *   admin_down          switched off on purpose (idle)
 *   up                  administratively and operationally up (healthy)
 *   down                administratively up but operationally down (warning)
 *   other               testing, dormant, notPresent, unknown (unknown)
 */
export type InterfaceReason =
  'device_unavailable' | 'absent' | 'admin_down' | 'up' | 'down' | 'other'

/** The agent that polls a device, as for a target: only where its server is visible to the user. */
export type DeviceAgent = TargetAgent

export interface DeviceConfig {
  id: string
  name: string
  type: DeviceType
  address: string
  enabled: boolean
  siteId: string | null
  snmpVersion: SnmpVersion
  port: number
  pollIntervalSeconds: number
  timeoutSeconds: number
  retries: number
  agentAssigned: boolean
  agent: DeviceAgent | null
}

/** The latest poll of a device, kept whatever its age. */
export interface DeviceState {
  reachable: boolean
  /** The poll error word (`timeout`, `unreachable`, `auth_failure`, ...), as the agent reported it. */
  error: string | null
  responseMs: number | null
  uptimeSeconds: number | null
  sysName: string | null
  sysDescr: string | null
  sysObjectId: string | null
  lastPollAt: Iso
  lastSuccessAt: Iso | null
  lastDiscoveryAt: Iso | null
  receivedAt: Iso | null
}

export interface DeviceListItem {
  device: DeviceConfig
  /** The latest poll; null if the device has never been polled. */
  state: DeviceState | null
  /** There is a latest poll and it is no longer current: it takes no part in `health`. */
  stale: boolean
  health: HealthStatus
  reason: DeviceReason
  /** The present interfaces counted by their own health. */
  interfaces: { total: number; counts: StatusCounts }
  customerName?: string
  siteName?: string
}

export type DeviceStatusFilter = 'all' | 'critical' | 'warning' | 'unknown' | 'idle' | 'healthy'
export type DeviceSortKey = 'status' | 'name' | 'response' | 'polled'

export interface DeviceListOptions extends RequestOptions {
  /** Words, every one of which must appear in the name, address, sysName, site or customer. */
  q?: string
  status?: DeviceStatusFilter
  sort?: DeviceSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface DeviceList {
  generatedAt: Iso
  items: DeviceListItem[]
  page: PageInfo
  /** Per health status over the scope and the search, not the status filter. */
  counts: StatusCounts
  /** SNMP devices in the scope, whatever the search. */
  scopeTotal: number
}

export interface DevicePoll {
  measuredAt: Iso
  receivedAt: Iso
  reachable: boolean
  responseMs: number | null
  error: string | null
}

/** Why a sample gives no rate, the first of these that holds. */
export type InvalidReason = 'delta_state' | 'interval' | 'implausible' | 'stale'

/**
 * The rates of an interface's latest sample, as the console API calculated them from the agent's
 * deltas. When `valid` is false every rate is null, never 0, and `invalidReason` says why.
 * Utilization is null where the speed is not known, though the bps stand; a rate is null where
 * the device lacks that counter.
 */
export interface InterfaceRates {
  measuredAt: Iso
  /** `ok`, `speed_changed` (both valid), or why the deltas are not (`first`, `reboot`, `reset`, `gap`). */
  deltaState: string
  octetsBits: number | null
  intervalSeconds: number | null
  valid: boolean
  invalidReason: InvalidReason | null
  inBps: number | null
  outBps: number | null
  inUtilizationPercent: number | null
  outUtilizationPercent: number | null
  inErrorsPerSec: number | null
  outErrorsPerSec: number | null
  inDiscardsPerSec: number | null
  outDiscardsPerSec: number | null
}

export interface DeviceInterface {
  ifIndex: number
  name: string
  descr: string | null
  alias: string | null
  /** The IANA ifType number. */
  type: number
  /** Null when the device does not report a speed. */
  speedBps: number | null
  /** IF-MIB words: `up`, `down`, `testing`, ... */
  adminStatus: string
  operStatus: string
  operStatusChangedAt: Iso | null
  health: HealthStatus
  reason: InterfaceReason
  /** The latest sample's rates; null if the interface was never sampled. */
  rates: InterfaceRates | null
}

export interface DeviceDetail {
  generatedAt: Iso
  item: DeviceListItem
  /** The newest polls, newest first. */
  polls: DevicePoll[]
  /** The present interfaces, by ifIndex. */
  interfaces: DeviceInterface[]
}

export interface DeviceSeriesOptions extends Pick<RequestOptions, 'signal'> {
  deviceId: string
  range: RangeKey
}

export interface InterfaceSeriesOptions extends DeviceSeriesOptions {
  ifIndex: number
}

/**
 * A device's poll history, one entry per completed bucket (parallel arrays, oldest first).
 * `responseMs` is the mean response time of the reachable polls, null where a bucket has none.
 * `reachablePolls` and `failedPolls` are counts (0 for an empty bucket). A device never polled has
 * empty arrays.
 */
export interface DeviceSeries {
  generatedAt: Iso
  bucketMs: number
  t: number[]
  responseMs: (number | null)[]
  reachablePolls: number[]
  failedPolls: number[]
}

/**
 * An interface's history, one entry per completed bucket (parallel arrays, oldest first): the means
 * and maxima of the valid samples in it, each sample judged by itself. A bucket with no valid sample
 * is null, never 0; `validSamples` and `invalidSamples` count what the bucket held. An interface
 * never sampled has empty arrays.
 */
export interface InterfaceSeries {
  generatedAt: Iso
  bucketMs: number
  t: number[]
  inBps: (number | null)[]
  outBps: (number | null)[]
  inBpsMax: (number | null)[]
  outBpsMax: (number | null)[]
  inErrorsPerSec: (number | null)[]
  outErrorsPerSec: (number | null)[]
  inDiscardsPerSec: (number | null)[]
  outDiscardsPerSec: (number | null)[]
  validSamples: number[]
  invalidSamples: number[]
}

/* ---------------------------------------------------------------- topology */

/**
 * What a topology node is. `customer`, `site` and `group` only hold other nodes (`group` is the
 * one synthetic "No site" holder); the rest are monitored entities with a health of their own.
 */
export type TopologyNodeKind =
  'customer' | 'site' | 'group' | 'server' | 'container' | 'target' | 'device' | 'interface'

/** The kinds the console API leaves out unless they are asked for. */
export type TopologyInclude = 'containers' | 'interfaces'

/** The agent installed on a server, as the topology reports it. */
export interface TopologyAgent {
  id: string
  name: string
  version: string | null
  status: 'online' | 'offline' | 'unknown'
  lastSeenAt: Iso | null
}

export interface TopologyNode {
  /** `<kind>:<ref>`, or `group:unassigned`. */
  id: string
  kind: TopologyNodeKind
  label: string
  /** The node it belongs to (a site in its customer, a server on its site): grouping, never a link. */
  parent: string | null
  /** The console's health; null for the nodes that only hold others. */
  health: HealthStatus | null
  /** The id the other console endpoints take; null for the synthetic group. */
  ref: string | null
  /** Servers only: the agent installed on it, or null when it has none. */
  agent: TopologyAgent | null
  /** True for the "No site" group, which is not a record of its own. */
  synthetic: boolean
}

/**
 * Which server's agent measures what: it probes a network target or polls an SNMP device. This is
 * monitoring responsibility, never a network link: the console knows no cabling or routing.
 */
export interface TopologyEdge {
  id: string
  /** The server whose agent does the measuring. */
  source: string
  /** The target or device it measures. */
  target: string
  kind: 'probes' | 'polls'
}

/** Of one kind: how many the scope holds, and how many of them this answer returned. */
export interface TopologyCount {
  visible: number
  returned: number
}

/**
 * The infrastructure graph of a scope, as recorded: who owns what, where it is, what runs on what
 * and which agent measures what. Taken worst health first up to the limit, each node with every
 * ancestor; `truncated` says that some of the scope was left out.
 */
export interface Topology {
  generatedAt: Iso
  /** Whether any edge is a physical link. The console API has none to give: always false. */
  physicalLinksKnown: boolean
  /** Ancestors before the nodes they hold. */
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  /** Only the kinds the answer covers: containers and interfaces when asked for, the group when one exists. */
  counts: Partial<Record<TopologyNodeKind, TopologyCount>>
  truncated: boolean
}

export interface TopologyOptions extends RequestOptions {
  include?: readonly TopologyInclude[]
  /** Nodes to return, parents included: 1 to 5000 (the console API's default is 2000). */
  limit?: number
}

/* --------------------------------------------------------------- incidents */

/**
 * Where an incident stands. `active` and `acknowledged` are both open: acknowledging marks an
 * incident as seen and nothing else. `recovered` and `closed` are ended: the condition cleared and
 * the recovery was confirmed, or monitoring of the object ended (`closeReason`).
 */
export type IncidentStatus = 'active' | 'acknowledged' | 'recovered' | 'closed'

export type AlertSeverity = 'critical' | 'warning'

export type IncidentEntityKind = 'server' | 'container' | 'target' | 'device' | 'interface'

/** The health a rule fired on. */
export type IncidentConditionHealth = 'critical' | 'warning' | 'unknown'

export type IncidentCloseReason =
  | 'entity_removed'
  | 'entity_disabled'
  | 'entity_moved'
  | 'out_of_scope'
  | 'rule_disabled'
  | 'rule_changed'

export interface IncidentItem {
  id: string
  status: IncidentStatus
  severity: AlertSeverity
  /** The rule's condition when the incident opened. */
  condition: { health: IncidentConditionHealth; reason: string | null }
  /** `ref` is the id the other console endpoints take; `label` the object's name when the incident opened. */
  entity: { kind: IncidentEntityKind; ref: string; label: string }
  rule: { id: string; name: string }
  siteId: string | null
  customerName?: string
  siteName?: string
  /** When the condition began. */
  startedAt: Iso
  /** When it had held for the rule's activation time. */
  openedAt: Iso
  acknowledgedAt: Iso | null
  acknowledgedBy: string | null
  recoveredAt: Iso | null
  closedAt: Iso | null
  closeReason: IncidentCloseReason | null
  /** This user may acknowledge it now: it is active and the account has the permission. */
  canAcknowledge: boolean
}

export type IncidentStatusFilter =
  'all' | 'open' | 'active' | 'acknowledged' | 'ended' | 'recovered' | 'closed'
export type IncidentSeverityFilter = 'all' | AlertSeverity
export type IncidentKindFilter = 'all' | IncidentEntityKind
export type IncidentSortKey = 'opened' | 'started' | 'severity' | 'status' | 'name'

export interface IncidentListOptions extends RequestOptions {
  /** Words, every one of which must appear in the object's name or reference, the rule, the site or the customer. */
  q?: string
  status?: IncidentStatusFilter
  severity?: IncidentSeverityFilter
  kind?: IncidentKindFilter
  sort?: IncidentSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

/** Incidents per status over the scope, the search, the severity and the kind: never the status filter. */
export type IncidentCounts = Record<IncidentStatus, number>

export interface IncidentList {
  generatedAt: Iso
  items: IncidentItem[]
  page: PageInfo
  counts: IncidentCounts
  /** Incidents in the scope, whatever the search and filters. */
  scopeTotal: number
}

export type IncidentEventKind =
  'opened' | 'acknowledged' | 'recovery_started' | 'recovery_interrupted' | 'recovered' | 'closed'

/** One step of an incident's history. `health` and `reason` are what was observed then, where anything was. */
export interface IncidentStep {
  at: Iso
  kind: IncidentEventKind
  health: HealthStatus | null
  reason: string | null
  /** The user name of whoever acknowledged. */
  actor: string | null
}

export interface IncidentRule {
  id: string
  name: string
  description: string
  enabled: boolean
}

export interface IncidentDetail {
  generatedAt: Iso
  item: IncidentItem
  rule: IncidentRule
  /** The object still exists where this user may see it: its own page opens. */
  entityVisible: boolean
  /** In order, oldest first. */
  timeline: IncidentStep[]
}

export type EngineState = 'running' | 'failed' | 'stale' | 'never_started'

/** What the alert engine says about itself. Nothing is inferred from the incidents. */
export interface EngineStatus {
  generatedAt: Iso
  state: EngineState
  stale: boolean
  staleAfterSeconds: number
  intervalSeconds: number | null
  startedAt: Iso | null
  lastSuccessAt: Iso | null
  lastAttemptAt: Iso | null
  lastCycleMs: number | null
  /** The category only, never the message. */
  lastError: { at: Iso; category: 'database' | 'internal' } | null
  /** Null while the engine finds the agents' heartbeats missing all at once. */
  monitoringSince: Iso | null
}

/**
 * The open incidents of a scope for the shell and the Overview: the counts are the API's, over the
 * whole scope, and `recent` holds only the first few (critical first, then the newest).
 */
export interface IncidentOverview {
  generatedAt: Iso
  /** Active and acknowledged. */
  open: number
  active: number
  acknowledged: number
  /** Open and critical. */
  critical: number
  recent: IncidentItem[]
}

/* ---------------------------------------------------------------- settings */

/** The state of a background process the console watches: the alert engine, the notifier. */
export type NotifierState = 'running' | 'failed' | 'stale' | 'never_started' | 'disabled'

/** A console user's own email preferences. `updatedAt` null: nothing was ever saved (the defaults show). */
export interface NotificationPreferences {
  enabled: boolean
  minSeverity: AlertSeverity
  sendRecovery: boolean
  updatedAt: Iso | null
}

/**
 * pending: queued, no notifier has taken it. sending: a notifier is sending it. sent, failed,
 * cancelled and expired are final. A test email is sent once and never retried.
 */
export type TestEmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'expired'

/** Why a test email was not sent, by category, with the server's own words for it. Never an SMTP message. */
interface TestEmailFailure {
  category: string
  label: string
}

export interface TestEmail {
  id: string
  status: TestEmailStatus
  failure: TestEmailFailure | null
  createdAt: Iso
  expiresAt: Iso
  finishedAt: Iso | null
}

export interface NotificationSettings {
  generatedAt: Iso
  preferences: NotificationPreferences
  /** The address is the account's own, read-only here: an administrator sets it. */
  account: { email: string | null }
  /** `available`: this server sends email. `deliverable`: and the account has an address. */
  email: { available: boolean; deliverable: boolean }
  /** `allowed`: this account may ask for a test email. `latest`: its latest request, if any. */
  testEmail: { allowed: boolean; latest: TestEmail | null }
}

/** What the preferences are saved as: exactly these three. */
export interface NotificationPreferencesInput {
  enabled: boolean
  minSeverity: AlertSeverity
  sendRecovery: boolean
}

/** A test email as it was asked for or read, with the state of the notifier that has to send it. */
export interface TestEmailAnswer {
  generatedAt: Iso
  item: TestEmail
  notifier: { state: NotifierState }
}

export type RuleScopeType = 'all' | 'customer' | 'site'

/** What an alert rule is for: every object, one customer's, or one site's. */
export interface AlertRuleScope {
  type: RuleScopeType
  customerId: string | null
  customerName: string | null
  siteId: string | null
  siteName: string | null
}

export interface AlertRule {
  id: string
  /** Names the rules Sentinel installed; read-only. Null for a rule an operator made. */
  key: string | null
  name: string
  description: string
  enabled: boolean
  /** The kind of object it concerns. It never changes. */
  kind: IncidentEntityKind
  /** The health it fires on, and optionally only for one reason of the kind (null: any). */
  health: IncidentConditionHealth
  reason: string | null
  severity: AlertSeverity
  activationSeconds: number
  recoverySeconds: number
  scope: AlertRuleScope
  openIncidents: number
  createdAt: Iso
  updatedAt: Iso
  /** Sent back with every change: a rule changed meanwhile is a conflict, never an overwrite. */
  version: number
  /** This user may change this rule (the capability, and the rule). */
  canEdit: boolean
}

export type RuleEnabledFilter = 'all' | 'enabled' | 'disabled'
export type RuleScopeFilter = 'all' | 'global' | 'customer' | 'site'
export type RuleSortKey = 'name' | 'kind' | 'severity' | 'updated'

/** Rules are global: the top bar's scope does not narrow them, and `scope` is the rules' own filter. */
export interface AlertRuleListOptions extends Pick<RequestOptions, 'signal'> {
  /** Words, every one of which must appear in the name, description, customer or site. */
  q?: string
  enabled?: RuleEnabledFilter
  kind?: IncidentKindFilter
  severity?: IncidentSeverityFilter
  scope?: RuleScopeFilter
  sort?: RuleSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface AlertRuleList {
  generatedAt: Iso
  items: AlertRule[]
  page: PageInfo
  /** Over every filter but `enabled`, so the chips stay true. */
  counts: { enabled: number; disabled: number }
  /** Every rule, whatever the search and filters. */
  scopeTotal: number
}

/** What closing an incident under a rule may follow from a change. */
export type RuleClosure = 'rule_disabled' | 'rule_changed' | 'out_of_scope'

/**
 * Which changes end the rule's open incidents, as the API states them: by field, why they end
 * (`closes`) and which of them (`which`). `to` is the value that does it, where one value does.
 */
export type ChangeEffects = Record<string, { to?: boolean; closes: RuleClosure; which: string }>

export interface AlertRuleDetail {
  generatedAt: Iso
  item: AlertRule
  changeEffects: ChangeEffects
}

/** What a rule is created with. The server fills the rest with the defaults the options list. */
export interface AlertRuleInput {
  name: string
  description?: string
  enabled?: boolean
  kind: IncidentEntityKind
  health: IncidentConditionHealth
  /** Null: any reason. */
  reason?: string | null
  severity: AlertSeverity
  activationSeconds?: number
  recoverySeconds?: number
  /** At most one of the two. */
  customerId?: string | null
  siteId?: string | null
}

/** A change: only the fields that change, and the version that was read. The kind never changes. */
export type AlertRulePatch = Partial<Omit<AlertRuleInput, 'kind'>> & { version: number }

/** What a change did to the rule's open incidents, when the engine next runs. */
export interface RuleEffects {
  /** How many were open when the change was made. */
  openIncidents: number
  closes: RuleClosure[]
  closesAll: boolean
}

/** A saved change. `effects` is null when nothing changed: the rule is as it was, its version too. */
export interface AlertRuleChange {
  generatedAt: Iso
  item: AlertRule
  effects: RuleEffects | null
}

export interface RuleConditionOption {
  health: IncidentConditionHealth
  label: string
  /** The reasons a rule of this kind and this health may be narrowed to. */
  reasons: string[]
}

export interface RuleKindOption {
  value: IncidentEntityKind
  label: string
  conditions: RuleConditionOption[]
}

/** What the server accepts, to build a rule form from: nothing is assumed in the console. */
export interface AlertRuleOptions {
  generatedAt: Iso
  kinds: RuleKindOption[]
  severities: { value: AlertSeverity; label: string }[]
  defaults: { enabled: boolean; activationSeconds: number; recoverySeconds: number }
  limits: { maxDurationSeconds: number; nameMaxLength: number; descriptionMaxLength: number }
  changeEffects: ChangeEffects
}

/** The alert engine's state without its own timestamp (the status carries one). */
export type EngineBody = Omit<EngineStatus, 'generatedAt'>

export interface NotifierStatus {
  state: NotifierState
  stale: boolean
  staleAfterSeconds: number
  intervalSeconds: number | null
  startedAt: Iso | null
  lastSuccessAt: Iso | null
  lastAttemptAt: Iso | null
  /** Its latest sign of life, also between the emails of a long cycle. */
  lastActiveAt: Iso | null
  lastSmtpSuccessAt: Iso | null
  lastCycleMs: number | null
  /** The notifier's own failure: its database, or itself. */
  lastError: { at: Iso; category: 'database' | 'internal' } | null
  /** The mail server it could not reach or log in to, and why, by category. */
  lastSmtpError: {
    at: Iso
    category: 'connection' | 'timeout' | 'tls' | 'authentication'
  } | null
  /** What the notifier itself reported: whether a mail server is set, and whether it logs in. Null before its first cycle. */
  smtpConfigured: boolean | null
  authenticationConfigured: boolean | null
}

export interface OutboxSummary {
  pending: number
  sending: number
  oldestPendingAt: Iso | null
  /** Emails that waited longer than they may. */
  overdue: number
  last24Hours: {
    created: number
    sent: number
    failed: number
    cancelled: number
    /** By category: how many emails did not go, and why. */
    failures: Record<string, number>
  }
  testEmails: { open: number; last24Hours: Record<TestEmailStatus, number> }
}

export type EmailSecurity = 'starttls' | 'tls' | 'none'

/** What the deployment sets (its environment), shown here and changed there. Never a secret. */
export interface SystemEnvironment {
  email: {
    enabled: boolean
    host: string | null
    port: number
    security: EmailSecurity
    fromAddress: string | null
    timeoutSeconds: number
    maxAgeHours: number
    consoleUrl: string | null
  }
  retention: {
    incidentDays: number
    notificationDays: number
    networkMeasurementDays: number
    snmpDays: number
    telemetryDays: number
    absentContainerDays: number
  }
  monitoring: {
    offlineThresholdSeconds: number
    thresholds: PublishedThresholds
  }
}

export interface SystemStatus {
  generatedAt: Iso
  alertEngine: EngineBody
  notifier: NotifierStatus
  outbox: OutboxSummary
  environment: SystemEnvironment
}

/* ---------------------------------------------------------- administration */

/** One page of an administration list: the page and the scope, no health counts. */
export interface RecordList<Item> {
  generatedAt: Iso
  items: Item[]
  page: PageInfo
  /** Records in the scope, whatever the search and filters. */
  scopeTotal: number
}

/** What a deletion answers: the record is gone, named one last time. */
export interface Deleted {
  generatedAt: Iso
  deleted: { id: string; name: string }
}

export type RecordSortKey = 'name' | 'created'

/** The list query of customers and sites: search, sort, page. */
export interface RecordListOptions extends Pick<RequestOptions, 'signal'> {
  /** Words, every one of which must appear in the name, the notes or description, or the customer's name. */
  q?: string
  sort?: RecordSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

/** A customer as the console administers it, with what belongs to it (what must go elsewhere before it can be deleted). */
export interface CustomerRecord {
  id: string
  name: string
  notes: string
  sites: number
  servers: number
  devices: number
  targets: number
  domains: number
  createdAt: Iso
  updatedAt: Iso
}

export interface SiteRecord {
  id: string
  customerId: string
  customerName: string
  name: string
  description: string
  servers: number
  devices: number
  targets: number
  createdAt: Iso
  updatedAt: Iso
}

export type CustomerList = RecordList<CustomerRecord>
export type SiteList = RecordList<SiteRecord>

export interface SiteListOptions extends RecordListOptions {
  /** Only the sites of this customer (its id). */
  customer?: string
}

/** One customer with its sites. */
export interface CustomerDetail {
  generatedAt: Iso
  item: CustomerRecord
  sites: SiteRecord[]
}

export interface SiteDetail {
  generatedAt: Iso
  item: SiteRecord
}

export interface CustomerInput {
  name: string
  notes?: string
}
export type CustomerPatch = Partial<CustomerInput>

export interface SiteInput {
  customerId: string
  name: string
  description?: string
}
/** A change: only the fields that change. Another `customerId` moves the site, and changes who sees everything on it. */
export type SitePatch = Partial<SiteInput>

/**
 * The four roles the console assigns, each a bundle of the server's permissions: a viewer reads
 * what its grants show; an operator also acknowledges incidents; an editor configures monitoring
 * for every customer; an administrator may do everything, accounts included.
 */
export type UserRole = 'viewer' | 'operator' | 'editor' | 'administrator'

export interface CustomerGrant {
  id: string
  name: string
}

export interface SiteGrant {
  id: string
  customerId: string
  customerName: string
  name: string
}

/** An account as the console administers it. Never a password, a hash, or anything about one. */
export interface Account {
  id: number
  username: string
  firstName: string
  lastName: string
  displayName: string
  email: string
  /** What its permissions amount to; null for an account that may not use the console at all. */
  role: UserRole | null
  /** It sees every customer (every editor and administrator; a viewer or operator granted so). */
  allCustomers: boolean
  active: boolean
  lastLoginAt: Iso | null
  createdAt: Iso
  /** The sign-in throttle refuses it until `lockedUntil`. */
  locked: boolean
  lockedUntil: Iso | null
  /** This is the signed-in account. */
  self: boolean
  /** The customers and the sites it is granted (what it sees, unless it sees every customer). */
  customers: CustomerGrant[]
  sites: SiteGrant[]
}

export type AccountActiveFilter = 'all' | 'active' | 'inactive'
export type AccountSortKey = 'username' | 'joined' | 'lastLogin'

export interface AccountListOptions extends Pick<RequestOptions, 'signal'> {
  /** Words, every one of which must appear in the user name, the names or the email. */
  q?: string
  active?: AccountActiveFilter
  sort?: AccountSortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export interface AccountList extends RecordList<Account> {
  /** Over the search, not the active filter: what each chip would show. */
  counts: { active: number; inactive: number }
}

export interface AccountDetail {
  generatedAt: Iso
  item: Account
}

/** What creating an account sends: the user name, the first password and the role are required. */
export interface AccountInput {
  username: string
  /** Typed by the administrator and told to the user, who changes it from their own account. Never answered. */
  password: string
  role: UserRole
  email?: string
  firstName?: string
  lastName?: string
  active?: boolean
  /** Viewers and operators only: the other roles see every customer. */
  allCustomers?: boolean
  customerIds?: string[]
  siteIds?: string[]
}

/** A change: only the fields that change. A password is set from its own method. */
export type AccountPatch = Partial<Omit<AccountInput, 'password'>>

export interface OwnPasswordInput {
  currentPassword: string
  newPassword: string
}

export interface PasswordChanged {
  generatedAt: Iso
  changedAt: Iso
}

/** A value an audit entry records: what JSON can hold, never a password, a hash, a token or a credential. */
export type AuditValue = string | number | boolean | null | AuditValue[]

export interface AuditChange {
  before: AuditValue
  after: AuditValue
}

/** One administrative action: who, when, what, on which object, and the fields that changed. */
export interface AuditEntry {
  id: number
  at: Iso
  /** `id` is null once the account is gone; the name stays. */
  actor: { id: number | null; username: string }
  action: string
  actionLabel: string
  targetType: string
  targetTypeLabel: string
  targetId: string
  targetName: string
  changes: Record<string, AuditChange>
}

export interface AuditOption {
  value: string
  label: string
}

export interface AuditLog extends RecordList<AuditEntry> {
  /** Every action and every kind of object the trail knows, for the filters. */
  actions: AuditOption[]
  targetTypes: AuditOption[]
}

export interface AuditLogOptions extends Pick<RequestOptions, 'signal'> {
  /** Words, every one of which must appear in the actor's name, the object's name or its id. */
  q?: string
  /** The id of an account. */
  actor?: number
  action?: string
  targetType?: string
  targetId?: string
  /** 1-based. */
  page?: number
  pageSize?: number
}

/** How a device is polled. Never the credential profile: it is written and never read back. */
export interface SnmpSettings {
  version: SnmpVersion
  port: number
  pollIntervalSeconds: number
  timeoutSeconds: number
  retries: number
}

/** A device of the inventory as the console administers it, with or without an SNMP configuration. */
export interface InventoryDevice {
  id: string
  name: string
  type: DeviceType
  address: string
  enabled: boolean
  description: string
  siteId: string | null
  customerName?: string
  siteName?: string
  agentAssigned: boolean
  agent: DeviceAgent | null
  /** Null for a device that is not polled. */
  snmp: SnmpSettings | null
  /** Polls or interface samples exist: it cannot be deleted until they are purged. */
  hasHistory: boolean
  createdAt: Iso
  updatedAt: Iso
}

export type InventorySnmpFilter = 'all' | 'configured' | 'none'
export type InventorySortKey = 'name' | 'type' | 'address' | 'created'

export interface InventoryDeviceListOptions extends RequestOptions {
  /** Words, every one of which must appear in the name, address, description, site or customer. */
  q?: string
  snmp?: InventorySnmpFilter
  sort?: InventorySortKey
  dir?: SortDirection
  /** 1-based. */
  page?: number
  pageSize?: number
}

export type InventoryDeviceList = RecordList<InventoryDevice>

export interface InventoryDeviceDetail {
  generatedAt: Iso
  item: InventoryDevice
}

/**
 * The SNMP configuration a write sends. `credentialProfile` is the name of a profile in the agent's
 * own credentials file: required when the configuration is created, left out to keep the one the
 * device has; the credentials themselves never reach the server.
 */
export interface SnmpInput {
  version?: SnmpVersion
  port?: number
  credentialProfile?: string
  pollIntervalSeconds?: number
  timeoutSeconds?: number
  retries?: number
}

/** What adding a device sends (`name` and `address` required). `snmp: null` means the device is not polled. */
export interface InventoryDeviceInput {
  name: string
  address: string
  type?: DeviceType
  enabled?: boolean
  description?: string
  siteId?: string | null
  agentId?: string | null
  snmp?: SnmpInput | null
}

/** A change: only the fields that change. `snmp` as an object changes the keys it holds; `snmp: null` removes it. */
export type InventoryDevicePatch = Partial<InventoryDeviceInput>

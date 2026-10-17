import type {
  AttentionOptions,
  AttentionResult,
  ContainerList,
  ContainerListOptions,
  DeviceDetail,
  DeviceList,
  DeviceListOptions,
  DeviceSeries,
  DeviceSeriesOptions,
  EntityIndex,
  FleetLoad,
  FleetLoadOptions,
  HealthBreakdown,
  InterfaceSeries,
  InterfaceSeriesOptions,
  OverviewSummary,
  RequestOptions,
  ScopeOptions,
  ServerDetail,
  ServerList,
  ServerListOptions,
  ServerSeries,
  ServerSeriesOptions,
  TargetDetail,
  TargetList,
  TargetListOptions,
  TargetSeries,
  TargetSeriesOptions,
} from './types'

/**
 * The only door between the UI and its data. Screens depend on this
 * interface, never on how the data is produced.
 *
 * Each Overview panel has its own method so each panel loads, refreshes and
 * fails independently. The port holds only what the console API can answer:
 * there is no method for probe latency, alerts or events, so no screen can show
 * them. A new capability adds its method here, with its endpoint, together.
 * The console API is the implementation (src/app/consoleApi.ts); the sample
 * fleet in ./mock exists for tests and for design work, and never ships.
 */
export interface SentinelApi {
  /** Honest provenance of the data, shown to operators in the shell. */
  readonly source: 'mock' | 'http'

  /** Customers and sites, for the scope picker. */
  getScopeOptions(options?: Pick<RequestOptions, 'signal'>): Promise<ScopeOptions>

  /** Headline counts: drives the verdict, tiles and sidebar badges. */
  getOverviewSummary(options?: RequestOptions): Promise<OverviewSummary>

  /** Needs-attention queue: non-healthy servers and containers. */
  listAttention(options?: AttentionOptions): Promise<AttentionResult>

  /** Top servers by CPU, memory or disk from the latest telemetry. */
  getFleetLoad(options: FleetLoadOptions): Promise<FleetLoad>

  /** Per-domain composition and per-site entity grids. Targets and SNMP are planned rows: nothing is counted for them. */
  getHealthBreakdown(options?: RequestOptions): Promise<HealthBreakdown>

  /** Everything searchable, for the command palette. */
  getEntityIndex(options?: RequestOptions): Promise<EntityIndex>

  /** One page of the servers in scope that match the query, with their latest telemetry and the counts the filter chips show. */
  listServers(options?: ServerListOptions): Promise<ServerList>

  /** One page of the containers of every visible server, searched, filtered, sorted and paged by the answerer. */
  listContainers(options?: ContainerListOptions): Promise<ContainerList>

  /** One page of the network targets in scope, searched, filtered, sorted and paged by the answerer. */
  listTargets(options?: TargetListOptions): Promise<TargetList>

  /** One target with its recent measurements and what the last 24 hours observed. 404 for an unknown or hidden id. */
  getTarget(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<TargetDetail>

  /** A target's latency and loss history over one of the supported ranges. */
  getTargetSeries(options: TargetSeriesOptions): Promise<TargetSeries>

  /** One page of the SNMP devices in scope, searched, filtered, sorted and paged by the answerer. */
  listDevices(options?: DeviceListOptions): Promise<DeviceList>

  /** One device with its recent polls and present interfaces. 404 for an unknown or hidden id. */
  getDevice(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<DeviceDetail>

  /** A device's response-time and poll history over one of the supported ranges. */
  getDeviceSeries(options: DeviceSeriesOptions): Promise<DeviceSeries>

  /** An interface's traffic, error and discard history over one of the supported ranges. */
  getInterfaceSeries(options: InterfaceSeriesOptions): Promise<InterfaceSeries>

  /** One server and its containers. Rejects with ApiError(404) for an unknown id. */
  getServer(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<ServerDetail>

  /** CPU, memory and disk history, with a gap for every bucket that has no sample. */
  getServerSeries(options: ServerSeriesOptions): Promise<ServerSeries>
}

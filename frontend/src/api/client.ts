import type {
  AlertsOptions,
  Alert,
  AttentionOptions,
  AttentionResult,
  EntityIndex,
  EventsOptions,
  FleetLoad,
  FleetLoadOptions,
  HealthBreakdown,
  NetworkSeries,
  NetworkSeriesOptions,
  OverviewSummary,
  RequestOptions,
  ScopeOptions,
  SentinelEvent,
  ServerDetail,
  ServerList,
  ServerSeries,
  ServerSeriesOptions,
} from './types'

/**
 * The only door between the UI and its data. Screens depend on this
 * interface, never on how the data is produced.
 *
 * Each Overview panel has its own method so each panel loads, refreshes and
 * fails independently. Today the only implementation is the mock in ./mock.
 * To go live, add an HTTP implementation (fetch + mapping onto ./types) and
 * provide it from src/app/providers.tsx. Each new screen adds its methods here.
 *
 * Methods marked "mock-only" cannot be served by the backend as it is today
 * (see src/config/features.ts); a real adapter returns empty data for them.
 */
export interface SentinelApi {
  /** Honest provenance of the data, shown to operators in the shell. */
  readonly source: 'mock' | 'http'

  /** Customers and sites, for the scope picker. */
  getScopeOptions(options?: Pick<RequestOptions, 'signal'>): Promise<ScopeOptions>

  /** Headline counts: drives the verdict, tiles and sidebar badges. */
  getOverviewSummary(options?: RequestOptions): Promise<OverviewSummary>

  /** Needs-attention queue: non-healthy servers, containers and targets. */
  listAttention(options?: AttentionOptions): Promise<AttentionResult>

  /** Probe latency percentiles and loss over time. Percentiles are mock-only (the backend does not aggregate). */
  getNetworkSeries(options: NetworkSeriesOptions): Promise<NetworkSeries>

  /** Top servers by CPU, memory or disk from the latest telemetry. */
  getFleetLoad(options: FleetLoadOptions): Promise<FleetLoad>

  /** Per-domain composition and per-site entity grids. Site grouping is mock-only. */
  getHealthBreakdown(options?: RequestOptions): Promise<HealthBreakdown>

  /** PLANNED: the backend has no alert engine. */
  listAlerts(options?: AlertsOptions): Promise<Alert[]>

  /** PLANNED: the backend has no event log. */
  listEvents(options?: EventsOptions): Promise<SentinelEvent[]>

  /** Everything searchable, for the command palette. */
  getEntityIndex(options?: RequestOptions): Promise<EntityIndex>

  /** Every server in scope with its latest telemetry. Search, filter and sort are the UI's: the fleet is small. */
  listServers(options?: RequestOptions): Promise<ServerList>

  /** One server and its containers. Rejects with ApiError(404) for an unknown id. */
  getServer(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<ServerDetail>

  /** CPU, memory and disk history. Mock-only (the backend keeps the latest sample only). */
  getServerSeries(options: ServerSeriesOptions): Promise<ServerSeries>
}

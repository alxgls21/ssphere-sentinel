import type {
  AlertRuleChange,
  AlertRuleDetail,
  AlertRuleInput,
  AlertRuleList,
  AlertRuleListOptions,
  AlertRuleOptions,
  AlertRulePatch,
  AttentionOptions,
  AttentionResult,
  ContainerList,
  ContainerListOptions,
  DeviceDetail,
  DeviceList,
  DeviceListOptions,
  DeviceSeries,
  DeviceSeriesOptions,
  EngineStatus,
  EntityIndex,
  FleetLoad,
  FleetLoadOptions,
  HealthBreakdown,
  IncidentDetail,
  IncidentList,
  IncidentListOptions,
  IncidentOverview,
  InterfaceSeries,
  InterfaceSeriesOptions,
  NotificationPreferencesInput,
  NotificationSettings,
  OverviewSummary,
  RequestOptions,
  ScopeOptions,
  ServerDetail,
  ServerList,
  ServerListOptions,
  ServerSeries,
  ServerSeriesOptions,
  SystemStatus,
  TargetDetail,
  TargetList,
  TargetListOptions,
  TargetSeries,
  TargetSeriesOptions,
  TestEmailAnswer,
  Topology,
  TopologyOptions,
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

  /**
   * The infrastructure graph of the scope: customers, sites, servers, targets and devices (and,
   * when asked for, containers and interfaces), grouped by what holds them, with the monitoring
   * edges. Never physical links. Up to `limit` nodes; `truncated` says when some were left out.
   */
  getTopology(options?: TopologyOptions): Promise<Topology>

  /** One page of the alert incidents in scope, searched, filtered, sorted and paged by the answerer. */
  listIncidents(options?: IncidentListOptions): Promise<IncidentList>

  /** One incident with its rule and its timeline. 404 for an unknown or hidden id. */
  getIncident(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<IncidentDetail>

  /**
   * Marks an active incident as seen (it stays open) and answers with the incident as it now is.
   * Acknowledged already is the same answer. Rejects: 403 without the permission, 404 for an unknown
   * or hidden id, 409 `incident_ended` once it has ended.
   */
  acknowledgeIncident(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<IncidentDetail>

  /** What the alert engine says about itself: running, failed, stale or never started. */
  getEngineStatus(options?: Pick<RequestOptions, 'signal'>): Promise<EngineStatus>

  /** The open incidents of the scope, counted by the answerer, with the first few that matter most. */
  getIncidentOverview(options?: RequestOptions): Promise<IncidentOverview>

  /** The signed-in user's own email preferences, with the account's address and whether this server sends email. */
  getNotificationSettings(options?: Pick<RequestOptions, 'signal'>): Promise<NotificationSettings>

  /**
   * Saves the user's own preferences (exactly three fields) and answers with them as they now are.
   * Rejects: 400 `validation_error` with `fields`, 409 `no_email_address` to switch emails on
   * without an address on the account.
   */
  saveNotificationPreferences(
    input: NotificationPreferencesInput,
    options?: Pick<RequestOptions, 'signal'>,
  ): Promise<NotificationSettings>

  /**
   * Asks for one test email to the account's own address; the notifier sends it. Rejects: 403, 409
   * `email_disabled`, `no_email_address` or `test_email_pending`, and 429 `rate_limited` with the
   * seconds to wait in `retryAfterSeconds`.
   */
  requestTestEmail(options?: Pick<RequestOptions, 'signal'>): Promise<TestEmailAnswer>

  /** One of the user's own test emails, to follow it until it is final. 404 for another user's. */
  getTestEmail(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<TestEmailAnswer>

  /** One page of the alert rules, searched, filtered, sorted and paged by the answerer. 403 without the capability. */
  listAlertRules(options?: AlertRuleListOptions): Promise<AlertRuleList>

  /** One rule, and which changes would end its open incidents. */
  getAlertRule(id: string, options?: Pick<RequestOptions, 'signal'>): Promise<AlertRuleDetail>

  /** What a rule form may offer: the kinds, their conditions and reasons, the limits and the defaults. */
  getAlertRuleOptions(options?: Pick<RequestOptions, 'signal'>): Promise<AlertRuleOptions>

  /** Creates a rule. Rejects: 400 `validation_error` with `fields`, 403. */
  createAlertRule(
    input: AlertRuleInput,
    options?: Pick<RequestOptions, 'signal'>,
  ): Promise<AlertRuleDetail>

  /**
   * Changes a rule: the fields that change, and the version that was read. Rejects: 409
   * `version_conflict` when the rule changed since (nothing is overwritten), 400
   * `validation_error` with `fields`, 403, 404.
   */
  updateAlertRule(
    id: string,
    patch: AlertRulePatch,
    options?: Pick<RequestOptions, 'signal'>,
  ): Promise<AlertRuleChange>

  /** The alert engine, the notifier, the email outbox and what the deployment sets. 403 without the capability. */
  getSystemStatus(options?: Pick<RequestOptions, 'signal'>): Promise<SystemStatus>
}

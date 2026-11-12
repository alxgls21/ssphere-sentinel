import type {
  AccountDetail,
  AccountInput,
  AccountList,
  AccountListOptions,
  AccountPatch,
  AgentChange,
  AgentEnrollment,
  AgentInput,
  AgentListOptions,
  AgentOptionList,
  AlertRuleChange,
  AlertRuleDetail,
  AlertRuleInput,
  AlertRuleList,
  AlertRuleListOptions,
  AlertRuleOptions,
  AlertRulePatch,
  AttentionOptions,
  AttentionResult,
  AuditLog,
  AuditLogOptions,
  ContainerList,
  ContainerListOptions,
  CustomerDetail,
  CustomerInput,
  CustomerList,
  CustomerPatch,
  Deleted,
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
  InventoryDeviceDetail,
  InventoryDeviceInput,
  InventoryDeviceList,
  InventoryDeviceListOptions,
  InventoryDevicePatch,
  NotificationPreferencesInput,
  NotificationSettings,
  OverviewSummary,
  OwnPasswordInput,
  PasswordChanged,
  RecordListOptions,
  RequestOptions,
  ScopeOptions,
  ServerDeleted,
  ServerDetail,
  ServerInput,
  ServerList,
  ServerListOptions,
  ServerPatch,
  ServerSeries,
  ServerSeriesOptions,
  SiteDetail,
  SiteInput,
  SiteList,
  SiteListOptions,
  SitePatch,
  SystemStatus,
  TargetDeleted,
  TargetDetail,
  TargetInput,
  TargetList,
  TargetListOptions,
  TargetPatch,
  TargetSeries,
  TargetSeriesOptions,
  TestEmailAnswer,
  Topology,
  TopologyOptions,
} from './types'

type Signal = Pick<RequestOptions, 'signal'>

/**
 * The only door between the UI and its data. Screens depend on this
 * interface, never on how the data is produced.
 *
 * Each Overview panel has its own method so each panel loads, refreshes and
 * fails independently. The port holds only what the console API can answer:
 * what has no method here, no screen can show. A new capability adds its
 * method here, with its endpoint, together.
 * The console API is the implementation (src/app/consoleApi.ts); the sample
 * fleet in ./mock exists for tests and for design work, and never ships.
 */
export interface SentinelApi {
  /** Honest provenance of the data, shown to operators in the shell. */
  readonly source: 'mock' | 'http'

  /** Customers and sites, for the scope picker. */
  getScopeOptions(options?: Signal): Promise<ScopeOptions>

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

  /** One target with its recent measurements, what the last 24 hours observed and its entry for the agent's file. 404 for an unknown or hidden id. */
  getTarget(id: string, options?: Signal): Promise<TargetDetail>

  /** A target's latency and loss history over one of the supported ranges. */
  getTargetSeries(options: TargetSeriesOptions): Promise<TargetSeries>

  /** One page of the SNMP devices in scope, searched, filtered, sorted and paged by the answerer. */
  listDevices(options?: DeviceListOptions): Promise<DeviceList>

  /** One device with its recent polls and present interfaces. 404 for an unknown or hidden id. */
  getDevice(id: string, options?: Signal): Promise<DeviceDetail>

  /** A device's response-time and poll history over one of the supported ranges. */
  getDeviceSeries(options: DeviceSeriesOptions): Promise<DeviceSeries>

  /** An interface's traffic, error and discard history over one of the supported ranges. */
  getInterfaceSeries(options: InterfaceSeriesOptions): Promise<InterfaceSeries>

  /** One server and its containers. Rejects with ApiError(404) for an unknown id. */
  getServer(id: string, options?: Signal): Promise<ServerDetail>

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
  getIncident(id: string, options?: Signal): Promise<IncidentDetail>

  /**
   * Marks an active incident as seen (it stays open) and answers with the incident as it now is.
   * Acknowledged already is the same answer. Rejects: 403 without the permission, 404 for an unknown
   * or hidden id, 409 `incident_ended` once it has ended.
   */
  acknowledgeIncident(id: string, options?: Signal): Promise<IncidentDetail>

  /** What the alert engine says about itself: running, failed, stale or never started. */
  getEngineStatus(options?: Signal): Promise<EngineStatus>

  /** The open incidents of the scope, counted by the answerer, with the first few that matter most. */
  getIncidentOverview(options?: RequestOptions): Promise<IncidentOverview>

  /** The signed-in user's own email preferences, with the account's address and whether this server sends email. */
  getNotificationSettings(options?: Signal): Promise<NotificationSettings>

  /**
   * Saves the user's own preferences (exactly three fields) and answers with them as they now are.
   * Rejects: 400 `validation_error` with `fields`, 409 `no_email_address` to switch emails on
   * without an address on the account.
   */
  saveNotificationPreferences(
    input: NotificationPreferencesInput,
    options?: Signal,
  ): Promise<NotificationSettings>

  /**
   * Asks for one test email to the account's own address; the notifier sends it. Rejects: 403, 409
   * `email_disabled`, `no_email_address` or `test_email_pending`, and 429 `rate_limited` with the
   * seconds to wait in `retryAfterSeconds`.
   */
  requestTestEmail(options?: Signal): Promise<TestEmailAnswer>

  /** One of the user's own test emails, to follow it until it is final. 404 for another user's. */
  getTestEmail(id: string, options?: Signal): Promise<TestEmailAnswer>

  /** One page of the alert rules, searched, filtered, sorted and paged by the answerer. 403 without the capability. */
  listAlertRules(options?: AlertRuleListOptions): Promise<AlertRuleList>

  /** One rule, and which changes would end its open incidents. */
  getAlertRule(id: string, options?: Signal): Promise<AlertRuleDetail>

  /** What a rule form may offer: the kinds, their conditions and reasons, the limits and the defaults. */
  getAlertRuleOptions(options?: Signal): Promise<AlertRuleOptions>

  /** Creates a rule. Rejects: 400 `validation_error` with `fields`, 403. */
  createAlertRule(input: AlertRuleInput, options?: Signal): Promise<AlertRuleDetail>

  /**
   * Changes a rule: the fields that change, and the version that was read. Rejects: 409
   * `version_conflict` when the rule changed since (nothing is overwritten), 400
   * `validation_error` with `fields`, 403, 404.
   */
  updateAlertRule(id: string, patch: AlertRulePatch, options?: Signal): Promise<AlertRuleChange>

  /** The alert engine, the notifier, the email outbox and what the deployment sets. 403 without the capability. */
  getSystemStatus(options?: Signal): Promise<SystemStatus>

  /**
   * Adds a server (no agent yet) and answers with its detail. Rejects: 400 `validation_error` with
   * `fields`, 409 `server_exists` for a name another server has, 403.
   */
  createServer(input: ServerInput, options?: Signal): Promise<ServerDetail>

  /**
   * Changes a server (only the fields sent) and answers with its detail. Rejects: 400
   * `validation_error` with `fields`, 409 `server_exists`, 403, 404.
   */
  updateServer(id: string, patch: ServerPatch, options?: Signal): Promise<ServerDetail>

  /**
   * Deletes a server with its agent (whose token stops working at once), its telemetry and its
   * containers; measurements, targets and devices are kept without their agent. Rejects: 403, 404.
   */
  deleteServer(id: string, options?: Signal): Promise<ServerDeleted>

  /**
   * Adds the agent of a server and answers with its token, once. Rejects: 409 `agent_exists` when the
   * server has one, 404 for an unknown server, 400 `validation_error`, 403.
   */
  createAgent(serverId: string, input: AgentInput, options?: Signal): Promise<AgentEnrollment>

  /**
   * Gives an agent a new token, answered once; the old token stops working at once. Rejects: 404 for an
   * unknown agent, 403.
   */
  rotateAgentToken(agentId: string, options?: Signal): Promise<AgentEnrollment>

  /** Enables or disables an agent (a disabled agent's heartbeats are refused). Rejects: 404, 403. */
  setAgentEnabled(agentId: string, enabled: boolean, options?: Signal): Promise<AgentChange>

  /** The agents of the servers the account may see, for choosing which agent probes a target or polls a device. */
  listAgents(options?: AgentListOptions): Promise<AgentOptionList>

  /** Adds a target and answers with its detail (its agent entry included). Rejects: 400 `validation_error`, 403. */
  createTarget(input: TargetInput, options?: Signal): Promise<TargetDetail>

  /** Changes a target (only the fields sent; `{enabled}` switches it). Rejects: 400, 403, 404. */
  updateTarget(id: string, patch: TargetPatch, options?: Signal): Promise<TargetDetail>

  /** Deletes a target with its measurement history. Rejects: 403, 404. */
  deleteTarget(id: string, options?: Signal): Promise<TargetDeleted>

  /** One page of the customers the account may see, searched, sorted and paged by the answerer. */
  listCustomers(options?: RecordListOptions): Promise<CustomerList>

  /** One customer with its sites. 404 for an unknown or hidden id. */
  getCustomer(id: string, options?: Signal): Promise<CustomerDetail>

  /** Adds a customer. Rejects: 400 `validation_error`, 409 `customer_exists` (a name taken in any case), 403. */
  createCustomer(input: CustomerInput, options?: Signal): Promise<CustomerDetail>

  /** Changes a customer (only the fields sent). Rejects: 400, 409 `customer_exists`, 403, 404. */
  updateCustomer(id: string, patch: CustomerPatch, options?: Signal): Promise<CustomerDetail>

  /**
   * Deletes a customer that has nothing left: 409 `customer_in_use` while it still has sites, domains
   * or alert rules (nothing is ever deleted along with it). Rejects: 403, 404.
   */
  deleteCustomer(id: string, options?: Signal): Promise<Deleted>

  /** One page of the sites the account may see (of one customer, if asked), searched, sorted and paged. */
  listSites(options?: SiteListOptions): Promise<SiteList>

  /** One site. 404 for an unknown or hidden id. */
  getSite(id: string, options?: Signal): Promise<SiteDetail>

  /** Adds a site to a customer. Rejects: 400 `validation_error`, 409 `site_exists` (a name the customer uses), 403. */
  createSite(input: SiteInput, options?: Signal): Promise<SiteDetail>

  /** Changes a site (only the fields sent; another customer moves it). Rejects: 400, 409 `site_exists`, 403, 404. */
  updateSite(id: string, patch: SitePatch, options?: Signal): Promise<SiteDetail>

  /**
   * Deletes a site that has nothing left: 409 `site_in_use` while it still has servers, devices,
   * targets, alert rules or incidents (nothing is ever deleted along with it). Rejects: 403, 404.
   */
  deleteSite(id: string, options?: Signal): Promise<Deleted>

  /** One page of the devices of the inventory in scope, searched, filtered, sorted and paged by the answerer. */
  listInventoryDevices(options?: InventoryDeviceListOptions): Promise<InventoryDeviceList>

  /** One device of the inventory, with its SNMP settings (never the credential profile). 404 for an unknown or hidden id. */
  getInventoryDevice(id: string, options?: Signal): Promise<InventoryDeviceDetail>

  /** Adds a device, with its SNMP configuration if given. Rejects: 400 `validation_error`, 409 `device_exists`, 403. */
  createInventoryDevice(
    input: InventoryDeviceInput,
    options?: Signal,
  ): Promise<InventoryDeviceDetail>

  /** Changes a device (only the fields sent). Rejects: 400, 409 `device_exists`, 403, 404. */
  updateInventoryDevice(
    id: string,
    patch: InventoryDevicePatch,
    options?: Signal,
  ): Promise<InventoryDeviceDetail>

  /** Deletes a device without history: 409 `device_has_history` while polls or samples exist. Rejects: 403, 404. */
  deleteInventoryDevice(id: string, options?: Signal): Promise<Deleted>

  /** One page of every account, searched, filtered, sorted and paged by the answerer. 403 unless an administrator. */
  listUsers(options?: AccountListOptions): Promise<AccountList>

  /** One account. 404 for an unknown id; 403 unless an administrator. */
  getUser(id: number, options?: Signal): Promise<AccountDetail>

  /** Creates an account with its first password. Rejects: 400 `validation_error` (the password's rules included), 409 `user_exists`, 403. */
  createUser(input: AccountInput, options?: Signal): Promise<AccountDetail>

  /**
   * Changes an account (only the fields sent). Rejects: 409 `own_account` (your own account is not
   * deactivated or demoted here) or `last_administrator`, 409 `user_exists`, 400, 403, 404.
   */
  updateUser(id: number, patch: AccountPatch, options?: Signal): Promise<AccountDetail>

  /** Sets another account's password, which ends its sessions. Rejects: 400 (the rules), 409 `own_account`, 403, 404. */
  resetUserPassword(id: number, password: string, options?: Signal): Promise<AccountDetail>

  /** Forgets an account's failed sign-ins, so a lockout ends now. Rejects: 403, 404. */
  unlockUser(id: number, options?: Signal): Promise<AccountDetail>

  /**
   * Changes the signed-in account's own password: the current one must be right (a wrong one counts
   * as a failed sign-in: 429 `too_many_attempts` once locked), the new one must pass the rules
   * (400 `validation_error`). This session goes on; every other one of the account ends.
   */
  changeOwnPassword(input: OwnPasswordInput, options?: Signal): Promise<PasswordChanged>

  /** One page of the audit trail, newest first, filtered and paged by the answerer. 403 without the capability. */
  listAuditLog(options?: AuditLogOptions): Promise<AuditLog>
}

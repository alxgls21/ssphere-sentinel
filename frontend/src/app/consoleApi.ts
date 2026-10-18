import type { SentinelApi } from '@/api/client'
import type { ConsoleHttp } from '@/api/http'
import type {
  ContainerList,
  DeviceList,
  IncidentList,
  Scope,
  ServerList,
  TargetList,
} from '@/api/types'
import { incidentOverviewOf } from '@/lib/incidents'
import { OVERVIEW_PAGE_SIZE, attentionOf, healthOf, summaryOf } from '@/lib/overview'

/** Requests for the same view that arrive together (the verdict, the queue, the health panel) share one answer. */
const SHARE_MS = 1500

interface Worst {
  servers: ServerList
  containers: ContainerList
  targets: TargetList
  devices: DeviceList
}

/** Open incidents the Overview lists: the few that matter most, never a page of them. */
export const OVERVIEW_INCIDENTS = 5

interface OpenIncidents {
  open: IncidentList
  critical: IncidentList
}

/** Rejects with an AbortError when `signal` aborts, as a request of its own would. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/**
 * The console API as the whole SentinelApi. The Overview is servers, containers, probe targets and
 * SNMP devices: the worst first of each, from the same four list requests (one page each, shared
 * by every panel and refresh), and the counts the API gives. The open incidents are two more
 * bounded requests, shared the same way: the first few by severity, and the critical ones counted.
 * What the API does not serve (events) has no method here and no figure anywhere: a failed request
 * is that panel's error, and nothing stands in for it.
 */
export function createConsoleApi(http: ConsoleHttp): SentinelApi {
  let shared: { key: string; at: number; promise: Promise<Worst> } | null = null
  let sharedIncidents: { key: string; at: number; promise: Promise<OpenIncidents> } | null = null

  const openIncidents = (scope: Scope | undefined): Promise<OpenIncidents> => {
    const key = JSON.stringify(scope ?? null)
    const now = Date.now()
    if (sharedIncidents && sharedIncidents.key === key && now - sharedIncidents.at < SHARE_MS) {
      return sharedIncidents.promise
    }
    const promise = Promise.all([
      http.listIncidents({
        scope,
        status: 'open',
        sort: 'severity',
        dir: 'desc',
        page: 1,
        pageSize: OVERVIEW_INCIDENTS,
      }),
      // Only its counts are read: the API counts per status over the whole scope, whatever the page.
      http.listIncidents({ scope, status: 'open', severity: 'critical', page: 1, pageSize: 1 }),
    ]).then(([open, critical]) => ({ open, critical }))
    const entry = { key, at: now, promise }
    sharedIncidents = entry
    promise.catch(() => {
      if (sharedIncidents === entry) sharedIncidents = null
    })
    return promise
  }

  const worstFirst = (scope: Scope | undefined): Promise<Worst> => {
    const key = JSON.stringify(scope ?? null)
    const now = Date.now()
    if (shared && shared.key === key && now - shared.at < SHARE_MS) return shared.promise
    const query = {
      scope,
      sort: 'status',
      dir: 'desc',
      page: 1,
      pageSize: OVERVIEW_PAGE_SIZE,
    } as const
    const promise = Promise.all([
      http.listServers(query),
      http.listContainers(query),
      http.listTargets(query),
      http.listDevices(query),
    ]).then(([servers, containers, targets, devices]) => ({
      servers,
      containers,
      targets,
      devices,
    }))
    const entry = { key, at: now, promise }
    shared = entry
    // A failure is not shared: the next request asks again.
    promise.catch(() => {
      if (shared === entry) shared = null
    })
    return promise
  }

  return {
    source: 'http',
    getScopeOptions: (options) => http.getScopeOptions(options?.signal),
    getFleetLoad: (options) => http.getFleetLoad(options),
    listServers: (options) => http.listServers(options),
    listContainers: (options) => http.listContainers(options),
    listTargets: (options) => http.listTargets(options),
    getTarget: (id, options) => http.getTarget(id, options),
    getTargetSeries: (options) => http.getTargetSeries(options),
    listDevices: (options) => http.listDevices(options),
    getDevice: (id, options) => http.getDevice(id, options),
    getDeviceSeries: (options) => http.getDeviceSeries(options),
    getInterfaceSeries: (options) => http.getInterfaceSeries(options),
    getServer: (id, options) => http.getServer(id, options),
    getServerSeries: (options) => http.getServerSeries(options),
    getTopology: (options) => http.getTopology(options),
    listIncidents: (options) => http.listIncidents(options),
    getIncident: (id, options) => http.getIncident(id, options),
    acknowledgeIncident: (id, options) => http.acknowledgeIncident(id, options),
    getEngineStatus: (options) => http.getEngineStatus(options),
    getNotificationSettings: (options) => http.getNotificationSettings(options),
    saveNotificationPreferences: (input, options) =>
      http.saveNotificationPreferences(input, options),
    requestTestEmail: (options) => http.requestTestEmail(options),
    getTestEmail: (id, options) => http.getTestEmail(id, options),
    listAlertRules: (options) => http.listAlertRules(options),
    getAlertRule: (id, options) => http.getAlertRule(id, options),
    getAlertRuleOptions: (options) => http.getAlertRuleOptions(options),
    createAlertRule: (input, options) => http.createAlertRule(input, options),
    updateAlertRule: (id, patch, options) => http.updateAlertRule(id, patch, options),
    getSystemStatus: (options) => http.getSystemStatus(options),
    getIncidentOverview: async (options) => {
      const { open, critical } = await abortable(openIncidents(options?.scope), options?.signal)
      return incidentOverviewOf(open, critical)
    },
    getOverviewSummary: async (options) => {
      const { servers, containers, targets, devices } = await abortable(
        worstFirst(options?.scope),
        options?.signal,
      )
      return summaryOf(servers, containers, targets, devices)
    },
    listAttention: async (options) => {
      const { servers, containers, targets, devices } = await abortable(
        worstFirst(options?.scope),
        options?.signal,
      )
      return attentionOf(servers, containers, targets, devices, {
        includeIdle: options?.includeIdle,
        now: Date.parse(servers.generatedAt),
      })
    },
    getHealthBreakdown: async (options) => {
      const { servers, containers, targets, devices } = await abortable(
        worstFirst(options?.scope),
        options?.signal,
      )
      return healthOf(servers, containers, targets, devices)
    },
    // Search across every entity is not built on the console API yet: the palette lists screens and actions only.
    getEntityIndex: async () => ({ generatedAt: new Date().toISOString(), items: [] }),
  }
}

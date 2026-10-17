import type { SentinelApi } from '@/api/client'
import type { ConsoleHttp } from '@/api/http'
import type { ContainerList, Scope, ServerList } from '@/api/types'
import { OVERVIEW_PAGE_SIZE, attentionOf, healthOf, summaryOf } from '@/lib/overview'

/** Requests for the same view that arrive together (the verdict, the queue, the health panel) share one answer. */
const SHARE_MS = 1500

interface Worst {
  servers: ServerList
  containers: ContainerList
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
 * The console API as the whole SentinelApi. The Overview is servers and containers: the
 * worst first of each, from the same two list requests, and the counts the API gives. What the
 * API does not serve (probe targets, SNMP devices, alerts, events) has no method here and no
 * figure anywhere: a failed request is that panel's error, and nothing stands in for it.
 */
export function createConsoleApi(http: ConsoleHttp): SentinelApi {
  let shared: { key: string; at: number; promise: Promise<Worst> } | null = null

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
    const promise = Promise.all([http.listServers(query), http.listContainers(query)]).then(
      ([servers, containers]) => ({ servers, containers }),
    )
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
    getServer: (id, options) => http.getServer(id, options),
    getServerSeries: (options) => http.getServerSeries(options),
    getOverviewSummary: async (options) => {
      const { servers, containers } = await abortable(worstFirst(options?.scope), options?.signal)
      return summaryOf(servers, containers)
    },
    listAttention: async (options) => {
      const { servers, containers } = await abortable(worstFirst(options?.scope), options?.signal)
      return attentionOf(servers, containers, {
        includeIdle: options?.includeIdle,
        now: Date.parse(servers.generatedAt),
      })
    },
    getHealthBreakdown: async (options) => {
      const { servers, containers } = await abortable(worstFirst(options?.scope), options?.signal)
      return healthOf(servers, containers)
    },
    // Search across every entity is not built on the console API yet: the palette lists screens and actions only.
    getEntityIndex: async () => ({ generatedAt: new Date().toISOString(), items: [] }),
  }
}

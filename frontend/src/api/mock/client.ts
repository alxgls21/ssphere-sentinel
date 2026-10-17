import type { SentinelApi } from '../client'
import { ApiError } from '../errors'
import type { RequestOptions, Scope } from '../types'
import { listAttention } from './attention'
import { entityIndex, fleetLoad, healthBreakdown, scopeOptions, summarize } from './derive'
import { buildServerSeries, listContainers, listServers, serverDetail } from './servers'
import { buildEstate, scopeEstate, type Estate, type FleetProfile } from './fixtures'
import { emptyCounts } from '@/lib/status'
import { hash01, hashString } from './random'
import type { MockScenario } from './scenario'
import { toIso, type Clock } from './time'

export interface MockApiOptions {
  scenario?: MockScenario
  /** Clock source; tests inject a fixed time. */
  now?: () => number
  /** Overrides the scenario's simulated latency (tests use 0). */
  delayMs?: number
}

/**
 * How each scenario answers (see scenario.ts for what they are for):
 *   serve       compute the answer after the delay
 *   first-only  serve each method once, then fail every later call
 *   fail        fail after the delay
 *   never       never answer; a request ends only when it is aborted
 */
interface Behavior {
  profile: FleetProfile
  mode: 'serve' | 'first-only' | 'fail' | 'never'
  delayMs: number
}

const DEFAULT_DELAY_MS = 350

const BEHAVIORS: Record<MockScenario, Behavior> = {
  normal: { profile: 'story', mode: 'serve', delayMs: DEFAULT_DELAY_MS },
  healthy: { profile: 'calm', mode: 'serve', delayMs: DEFAULT_DELAY_MS },
  partial: { profile: 'partial', mode: 'serve', delayMs: DEFAULT_DELAY_MS },
  stale: { profile: 'story', mode: 'first-only', delayMs: DEFAULT_DELAY_MS },
  slow: { profile: 'story', mode: 'serve', delayMs: 3000 },
  loading: { profile: 'story', mode: 'never', delayMs: 0 },
  empty: { profile: 'empty', mode: 'serve', delayMs: DEFAULT_DELAY_MS },
  error: { profile: 'story', mode: 'fail', delayMs: 250 },
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

export function createMockApi(options: MockApiOptions = {}): SentinelApi {
  const behavior = BEHAVIORS[options.scenario ?? 'normal']
  const readClock = options.now ?? (() => Date.now())
  // The story is pinned to the moment the API was created (see Clock).
  const anchor = readClock()
  /** Methods that have answered once already (the `first-only` behavior). */
  const answered = new Set<string>()

  /** Each panel answers a little differently fast, as independent requests do. */
  const delayFor = (method: string): number =>
    options.delayMs ?? Math.round(behavior.delayMs * (0.8 + 0.4 * hash01(hashString(method), 1)))

  function respond<T>(
    method: string,
    signal: AbortSignal | undefined,
    compute: (clock: Clock) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (behavior.mode === 'never') return

      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        // Only an answer that was delivered counts: a request abandoned mid-flight
        // (a remount, a changed scope) must not use up the one good response.
        const fails =
          behavior.mode === 'fail' || (behavior.mode === 'first-only' && answered.has(method))
        if (fails) {
          reject(new ApiError('Service unavailable (simulated)', 503))
          return
        }
        answered.add(method)
        try {
          resolve(compute({ now: readClock(), anchor }))
        } catch (error) {
          // A builder may refuse (an unknown id is a 404): that is the request failing, not the mock crashing.
          reject(error)
        }
      }, delayFor(method))
    })
  }

  const estateAt = (clock: Clock, scope?: Scope): Estate =>
    scopeEstate(buildEstate(behavior.profile, clock), scope)

  const scoped = <T>(
    method: string,
    { scope, signal }: RequestOptions | undefined = {},
    build: (estate: Estate, clock: Clock) => T,
  ) => respond(method, signal, (clock) => build(estateAt(clock, scope), clock))

  return {
    source: 'mock',

    getScopeOptions: (request) =>
      respond('getScopeOptions', request?.signal, (clock) => scopeOptions(estateAt(clock).fleet)),

    getOverviewSummary: (request) =>
      scoped('getOverviewSummary', request, (estate, { now }) => summarize(estate, now)),

    listAttention: (request) =>
      scoped('listAttention', request, ({ fleet }, { now }) =>
        listAttention(fleet, now, request?.includeIdle ?? false),
      ),

    getFleetLoad: (request) =>
      scoped('getFleetLoad', request, ({ fleet }, { now }) =>
        fleetLoad(fleet, request.metric, request.limit, now),
      ),

    getHealthBreakdown: (request) =>
      scoped('getHealthBreakdown', request, (estate, { now }) => healthBreakdown(estate, now)),

    getEntityIndex: (request) =>
      scoped('getEntityIndex', request, (estate, { now }) => entityIndex(estate, now)),

    listServers: (request) =>
      scoped('listServers', request, ({ fleet }, { now }) => listServers(fleet, now, request)),

    listContainers: (request) =>
      scoped('listContainers', request, ({ fleet }, { now }) =>
        listContainers(fleet, now, request),
      ),

    // The sample fleet monitors no network targets: an empty inventory, and no target to open.
    listTargets: (request) =>
      scoped('listTargets', request, (_estate, { now }) => ({
        generatedAt: toIso(now),
        items: [],
        page: { number: 1, size: request?.pageSize ?? 50, total: 0, pages: 1 },
        counts: emptyCounts(),
        scopeTotal: 0,
      })),

    getTarget: (id, request) =>
      respond('getTarget', request?.signal, () => {
        throw new ApiError(`Target ${id} not found`, 404)
      }),

    getTargetSeries: (request) =>
      respond('getTargetSeries', request.signal, () => {
        throw new ApiError(`Target ${request.targetId} not found`, 404)
      }),

    // The sample fleet monitors no SNMP devices: an empty inventory, and no device to open.
    listDevices: (request) =>
      scoped('listDevices', request, (_estate, { now }) => ({
        generatedAt: toIso(now),
        items: [],
        page: { number: 1, size: request?.pageSize ?? 50, total: 0, pages: 1 },
        counts: emptyCounts(),
        scopeTotal: 0,
      })),

    getDevice: (id, request) =>
      respond('getDevice', request?.signal, () => {
        throw new ApiError(`Device ${id} not found`, 404)
      }),

    getDeviceSeries: (request) =>
      respond('getDeviceSeries', request.signal, () => {
        throw new ApiError(`Device ${request.deviceId} not found`, 404)
      }),

    getInterfaceSeries: (request) =>
      respond('getInterfaceSeries', request.signal, () => {
        throw new ApiError(`Device ${request.deviceId} not found`, 404)
      }),

    getServer: (id, request) =>
      respond('getServer', request?.signal, (clock) =>
        serverDetail(estateAt(clock).fleet, id, clock.now),
      ),

    getServerSeries: (request) =>
      respond('getServerSeries', request.signal, (clock) => {
        const { server } = serverDetail(estateAt(clock).fleet, request.serverId, clock.now).item
        return buildServerSeries(server, request.range, clock.now)
      }),
  }
}

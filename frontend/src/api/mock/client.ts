import type { SentinelApi } from '../client'
import { ApiError } from '../errors'
import type { RequestOptions, Scope } from '../types'
import { deriveActivity } from './activity'
import { listAttention } from './attention'
import { entityIndex, fleetLoad, healthBreakdown, scopeOptions, summarize } from './derive'
import { buildServerSeries, listServers, serverDetail } from './servers'
import { buildEstate, scopeEstate, type Estate, type FleetProfile } from './fixtures'
import { hash01, hashString } from './random'
import type { MockScenario } from './scenario'
import { buildNetworkSeries, RANGE_MS } from './series'
import type { Clock } from './time'

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

    getNetworkSeries: (request) =>
      scoped('getNetworkSeries', request, ({ probes }, { now }) =>
        buildNetworkSeries(probes, request.range, now),
      ),

    getFleetLoad: (request) =>
      scoped('getFleetLoad', request, ({ fleet }, { now }) =>
        fleetLoad(fleet, request.metric, request.limit, now),
      ),

    getHealthBreakdown: (request) =>
      scoped('getHealthBreakdown', request, (estate, { now }) => healthBreakdown(estate, now)),

    listAlerts: (request) =>
      scoped('listAlerts', request, (estate, clock) => {
        const { alerts } = deriveActivity(estate, clock)
        const wanted = request?.state
          ? alerts.filter((alert) => alert.state === request.state)
          : alerts
        return request?.limit === undefined ? wanted : wanted.slice(0, request.limit)
      }),

    listEvents: (request) =>
      scoped('listEvents', request, (estate, clock) => {
        const { events } = deriveActivity(estate, clock)
        const since = request?.range ? clock.now - RANGE_MS[request.range] : -Infinity
        const wanted = events.filter((event) => Date.parse(event.at) >= since)
        return request?.limit === undefined ? wanted : wanted.slice(0, request.limit)
      }),

    getEntityIndex: (request) =>
      scoped('getEntityIndex', request, (estate, { now }) => entityIndex(estate, now)),

    listServers: (request) =>
      scoped('listServers', request, ({ fleet }, { now }) => listServers(fleet, now)),

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

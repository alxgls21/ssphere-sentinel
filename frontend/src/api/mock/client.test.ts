import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError, isAbortError } from '@/api/errors'
import { computeVerdict, type VerdictState } from '@/lib/verdict'
import { createMockApi, type MockApiOptions } from './client'
import { MOCK_SCENARIOS, type MockScenario } from './scenario'

const NOW = Date.UTC(2026, 9, 12, 14, 5, 12)

const apiFor = (scenario: MockScenario, extra: Partial<MockApiOptions> = {}) =>
  createMockApi({ scenario, now: () => NOW, delayMs: 0, ...extra })

type Call = (api: SentinelApi, signal?: AbortSignal) => Promise<unknown>

/** One call per API method, so behavior can be checked for every method at once. */
const CALLS: Record<string, Call> = {
  getScopeOptions: (api, signal) => api.getScopeOptions({ signal }),
  getOverviewSummary: (api, signal) => api.getOverviewSummary({ signal }),
  listAttention: (api, signal) => api.listAttention({ signal }),
  getFleetLoad: (api, signal) => api.getFleetLoad({ metric: 'cpu', signal }),
  getHealthBreakdown: (api, signal) => api.getHealthBreakdown({ signal }),
  getEntityIndex: (api, signal) => api.getEntityIndex({ signal }),
  listContainers: (api, signal) => api.listContainers({ signal }),
}
const METHODS = Object.keys(CALLS)

/** Settles to the rejection (or 'resolved'), so a test can wait for it without an unhandled rejection. */
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved' as const,
    (error: unknown) => error,
  )

afterEach(() => {
  vi.useRealTimers()
})

describe('scenarios', () => {
  async function verdictOf(scenario: MockScenario): Promise<VerdictState> {
    return computeVerdict(await apiFor(scenario).getOverviewSummary(), 'live').state
  }

  it('lists every scenario the UI can select', () => {
    expect([...MOCK_SCENARIOS]).toEqual([
      'normal',
      'healthy',
      'partial',
      'stale',
      'slow',
      'loading',
      'empty',
      'error',
    ])
  })

  it('normal tells the outage story: critical', async () => {
    expect(await verdictOf('normal')).toBe('critical')
    const { items } = await apiFor('normal').listAttention()
    expect(items.some((item) => item.severity === 'critical')).toBe(true)
  })

  it('healthy is nominal, with nothing to attend to', async () => {
    const api = apiFor('healthy')
    expect(await verdictOf('healthy')).toBe('nominal')
    const attention = await api.listAttention()
    expect(attention.items).toEqual([])
    expect(attention.hiddenIdle).toBeGreaterThan(0)
  })

  it('partial is partial: nothing failing, something unobserved', async () => {
    const api = apiFor('partial')
    expect(await verdictOf('partial')).toBe('partial')
    const { items } = await api.listAttention()
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.severity === 'unknown')).toBe(true)
  })

  it('stale, slow and loading serve the same story as normal', async () => {
    expect(await verdictOf('stale')).toBe('critical')
    expect(await verdictOf('slow')).toBe('critical')
  })

  it('empty monitors nothing: zero counts, empty lists, empty series', async () => {
    const api = apiFor('empty')
    const summary = await api.getOverviewSummary()
    expect(summary.servers).toEqual({
      total: 0,
      counts: { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 },
    })
    expect(summary.containers.total).toBe(0)
    expect(computeVerdict(summary, 'live').state).toBe('nodata')
    expect(await api.listAttention({ includeIdle: true })).toMatchObject({
      items: [],
      hiddenIdle: 0,
    })
    expect(await api.getFleetLoad({ metric: 'cpu' })).toMatchObject({ rows: [], excluded: [] })
    const breakdown = await api.getHealthBreakdown()
    expect(breakdown.sites).toEqual([])
    expect(
      breakdown.domains.map((d) => Object.values(d.counts).reduce((a, b) => a + b, 0)),
    ).toEqual([0, 0, 0, 0])
    expect((await api.getEntityIndex()).items).toEqual([])
    expect(await api.getScopeOptions()).toEqual({ customers: [], sites: [] })
  })

  it.each(METHODS)('error rejects %s with a 503 ApiError', async (method) => {
    const failure = await outcome((CALLS[method] as Call)(apiFor('error')))
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 503 })
  })

  it.each(METHODS)('stale answers %s once, then fails with 503', async (method) => {
    const api = apiFor('stale')
    const call = CALLS[method] as Call
    expect(await outcome(call(api))).toBe('resolved')
    const second = await outcome(call(api))
    expect(second).toBeInstanceOf(ApiError)
    expect(second).toMatchObject({ status: 503 })
    expect(await outcome(call(api))).toBeInstanceOf(ApiError)
  })

  it('stale counts each method separately', async () => {
    const api = apiFor('stale')
    await api.getOverviewSummary()
    expect(await outcome(api.getOverviewSummary())).toBeInstanceOf(ApiError)
    expect(await outcome(api.listAttention())).toBe('resolved')
  })

  it('stale does not spend its good answer on a request that was abandoned', async () => {
    const api = apiFor('stale', { delayMs: 20 })
    const controller = new AbortController()
    const abandoned = outcome(api.getOverviewSummary({ signal: controller.signal }))
    controller.abort()
    expect(isAbortError(await abandoned)).toBe(true)
    expect(await outcome(api.getOverviewSummary())).toBe('resolved')
  })
})

/** Whether a request has ended yet (either way), without awaiting it. */
function track(promise: Promise<unknown>) {
  const state = { settled: false }
  void outcome(promise).then(() => {
    state.settled = true
  })
  return state
}

describe('timing', () => {
  it('answers after about 350 ms by default', async () => {
    vi.useFakeTimers()
    const request = track(createMockApi({ now: () => NOW }).getOverviewSummary())
    await vi.advanceTimersByTimeAsync(200)
    expect(request.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(request.settled).toBe(true)
  })

  it('slow answers after about 3 s', async () => {
    vi.useFakeTimers()
    const request = track(createMockApi({ scenario: 'slow', now: () => NOW }).getOverviewSummary())
    await vi.advanceTimersByTimeAsync(2000)
    expect(request.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1800)
    expect(request.settled).toBe(true)
  })

  it('error fails after a short delay, not instantly', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ scenario: 'error', now: () => NOW })
    const failure = outcome(api.getOverviewSummary())
    const request = track(failure)
    await vi.advanceTimersByTimeAsync(100)
    expect(request.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(await failure).toBeInstanceOf(ApiError)
  })

  it('lets delayMs override the scenario, including for slow', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ scenario: 'slow', now: () => NOW, delayMs: 10 })
    const request = track(api.getOverviewSummary())
    await vi.advanceTimersByTimeAsync(10)
    expect(request.settled).toBe(true)
  })

  it('spreads the panels so they do not all land in the same frame', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ now: () => NOW })
    const landed = new Set<number>()
    const started = Date.now()
    for (const method of METHODS) {
      void (CALLS[method] as Call)(api).then(() => landed.add(Date.now() - started))
    }
    await vi.advanceTimersByTimeAsync(600)
    expect(landed.size).toBeGreaterThan(3)
    for (const at of landed) expect(at).toBeGreaterThanOrEqual(280)
    for (const at of landed) expect(at).toBeLessThanOrEqual(420)
  })

  it('loading never answers', async () => {
    vi.useFakeTimers()
    const api = createMockApi({ scenario: 'loading', now: () => NOW, delayMs: 0 })
    const request = track(api.getOverviewSummary())
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(request.settled).toBe(false)
  })
})

describe('abort', () => {
  it.each(
    MOCK_SCENARIOS.flatMap((scenario) => METHODS.map((method) => [scenario, method] as const)),
  )(
    '%s: %s rejects with an abort error when the signal is already aborted',
    async (scenario, method) => {
      const controller = new AbortController()
      controller.abort()
      const result = await outcome((CALLS[method] as Call)(apiFor(scenario), controller.signal))
      expect(isAbortError(result)).toBe(true)
    },
  )

  it.each(METHODS)('%s ends as soon as the request is aborted in flight', async (method) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const api = createMockApi({ now: () => NOW, delayMs: 5000 })
    const result = outcome((CALLS[method] as Call)(api, controller.signal))
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    // No timer needs to run: abort settles the request on its own.
    expect(isAbortError(await result)).toBe(true)
  })

  it('loading honors abort and ends there', async () => {
    const controller = new AbortController()
    const api = apiFor('loading')
    const result = outcome(api.getEntityIndex({ signal: controller.signal }))
    controller.abort()
    expect(isAbortError(await result)).toBe(true)
  })

  it('does not leak abort listeners once a request is answered', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await apiFor('normal').getOverviewSummary({ signal: controller.signal })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('determinism and the clock', () => {
  it('answers every method identically for the same clock', async () => {
    const a = apiFor('normal')
    const b = apiFor('normal')
    for (const method of METHODS) {
      expect(await (CALLS[method] as Call)(a), method).toEqual(await (CALLS[method] as Call)(b))
    }
  })

  it('stamps generatedAt with the injected clock', async () => {
    const api = apiFor('normal')
    const iso = new Date(NOW).toISOString()
    expect((await api.getOverviewSummary()).generatedAt).toBe(iso)
    expect((await api.listAttention()).generatedAt).toBe(iso)
    expect((await api.getFleetLoad({ metric: 'cpu' })).generatedAt).toBe(iso)
    expect((await api.getHealthBreakdown()).generatedAt).toBe(iso)
    expect((await api.getEntityIndex()).generatedAt).toBe(iso)
  })

  it('reports its source honestly', () => {
    expect(apiFor('normal').source).toBe('mock')
  })

  it('ages the story as the clock advances, without changing a single status', async () => {
    let clock = NOW
    const api = createMockApi({ now: () => clock, delayMs: 0 })
    const before = await api.listAttention({ includeIdle: true })
    clock += 6 * 3_600_000
    const after = await api.listAttention({ includeIdle: true })
    const key = (item: { id: string; severity: string; stateLabel: string }) =>
      `${item.id}|${item.severity}|${item.stateLabel}`
    expect(after.items.map(key).sort()).toEqual(before.items.map(key).sort())
    const offline = (result: typeof before) => result.items.find((i) => i.name === 'pir-fs-01')
    expect(offline(after)?.ageIso).toBe(offline(before)?.ageIso)
    expect(offline(after)?.detail).not.toBe(offline(before)?.detail)
  })

  it('returns fresh objects: mutating a result never corrupts the next one', async () => {
    const api = apiFor('normal')
    const options = await api.getScopeOptions()
    options.customers.length = 0
    const first = options.sites[0]
    if (first) first.name = 'tampered'
    const again = await api.getScopeOptions()
    expect(again.customers).toHaveLength(4)
    expect(again.sites[0]?.name).toBe('Athens DC')
  })
})

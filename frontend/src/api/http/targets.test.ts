import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import {
  getTarget,
  getTargetSeries,
  listTargets,
  parseTargetDetail,
  parseTargetList,
  parseTargetSeries,
} from './targets'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (targets.py). */
const counts = { healthy: 3, warning: 1, critical: 1, unknown: 2, idle: 1 }
const measurement = (over: Record<string, unknown> = {}) => ({
  measuredAt: '2026-10-17T10:00:00.000Z',
  receivedAt: '2026-10-17T10:00:01.000Z',
  success: true,
  latencyMs: 12.4,
  lossPercent: 0,
  probeCount: 4,
  successfulProbes: 4,
  failureReason: null,
  ...over,
})
const agent = {
  id: 'a1',
  name: 'ath-probe',
  status: 'online',
  lastSeenAt: '2026-10-17T10:00:00.000Z',
  serverId: 's1',
  serverName: 'ath-probe-01',
}
const target = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'ath-gateway',
  address: '10.20.0.1',
  protocol: 'icmp',
  port: null,
  enabled: true,
  intervalSeconds: 60,
  timeoutSeconds: 5,
  circuitId: null,
  siteId: 'site-1',
  agentAssigned: true,
  agent,
  ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  target: target(),
  latest: measurement(),
  stale: false,
  health: 'healthy',
  reason: 'ok',
  customerName: 'Meridian',
  siteName: 'Athens DC',
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items: [item()],
  page: { number: 1, size: 50, total: 1, pages: 1 },
  counts,
  scopeTotal: 8,
  ...over,
})
const availability = {
  from: '2026-10-16T10:00:00.000Z',
  to: '2026-10-17T10:00:00.000Z',
  measurements: 1400,
  successful: 1393,
  percent: 99.5,
  expectedMeasurements: 1440,
  coveragePercent: 97.2,
}
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: item(),
  measurements: [measurement()],
  availability24h: availability,
  ...over,
})
const series = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  bucketMs: 60000,
  t: [1, 2, 3],
  latencyMs: [10, null, 12.5],
  latencyMaxMs: [14, null, 19],
  lossPercent: [0, null, 1.5],
  measurements: [1, 0, 2],
  failed: [0, 0, 1],
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get, post: vi.fn() } as unknown as Transport & { get: typeof get }
}

describe('targets list', () => {
  it('maps the answer onto the view-model, keeping the page, the counts and the scope total', async () => {
    const result = await listTargets(transport(list()))({ q: ' gate ' })
    const [first] = result.items
    expect(first?.target).toMatchObject({
      id: 't1',
      protocol: 'icmp',
      port: null,
      enabled: true,
      intervalSeconds: 60,
      timeoutSeconds: 5,
      circuitId: null,
      agentAssigned: true,
      agent: { name: 'ath-probe', status: 'online', serverId: 's1', serverName: 'ath-probe-01' },
    })
    expect(first).toMatchObject({
      health: 'healthy',
      reason: 'ok',
      stale: false,
      customerName: 'Meridian',
      siteName: 'Athens DC',
      latest: { success: true, latencyMs: 12.4, lossPercent: 0, probeCount: 4 },
    })
    expect(result.page).toEqual({ number: 1, size: 50, total: 1, pages: 1 })
    expect(result.counts).toEqual(counts)
    expect(result.scopeTotal).toBe(8)
  })

  it('keeps an assigned agent the user may not see as no agent object, apart from no agent at all', () => {
    const hidden = parseTargetList(
      list({ items: [item({ target: target({ agentAssigned: true, agent: null }) })] }),
    )
    expect(hidden.items[0]?.target).toMatchObject({ agentAssigned: true, agent: null })
    const none = parseTargetList(
      list({ items: [item({ target: target({ agentAssigned: false, agent: null }) })] }),
    )
    expect(none.items[0]?.target).toMatchObject({ agentAssigned: false, agent: null })
  })

  it('keeps a TCP target’s port, a target never measured, and a stale measurement marked stale', () => {
    const [tcp, never, stale] = parseTargetList(
      list({
        items: [
          item({ target: target({ protocol: 'tcp', port: 443 }) }),
          item({ latest: null, reason: 'no_measurement', health: 'unknown' }),
          item({ stale: true, reason: 'stale', health: 'unknown' }),
        ],
      }),
    ).items
    expect(tcp?.target).toMatchObject({ protocol: 'tcp', port: 443 })
    expect(never?.latest).toBeNull()
    expect(stale).toMatchObject({ stale: true, reason: 'stale' })
  })

  it('keeps a failed measurement as it is: no latency, its failure reason', () => {
    const [failed] = parseTargetList(
      list({
        items: [
          item({
            latest: measurement({
              success: false,
              latencyMs: null,
              lossPercent: 100,
              successfulProbes: 0,
              failureReason: 'timeout',
            }),
            health: 'warning',
            reason: 'failed',
          }),
        ],
      }),
    ).items
    expect(failed?.latest).toMatchObject({
      success: false,
      latencyMs: null,
      failureReason: 'timeout',
    })
  })

  it('trusts the health and the reason the server decided and does not work them out again', () => {
    // A 100% loss measurement the server calls healthy: the console shows the server's verdict.
    const [first] = parseTargetList(
      list({ items: [item({ latest: measurement({ lossPercent: 100 }), health: 'healthy' })] }),
    ).items
    expect(first?.health).toBe('healthy')
  })

  it('sends only what differs from the defaults: scope, search, filter, sort, page', async () => {
    const t = transport(list())
    await listTargets(t)({
      scope: { customerId: 'c1', siteId: 's1' },
      q: ' gate  way ',
      status: 'warning',
      sort: 'latency',
      dir: 'asc',
      page: 3,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('targets/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: 's1',
        q: 'gate  way',
        status: 'warning',
        sort: 'latency',
        dir: 'asc',
        page: '3',
        pageSize: '50',
      },
    })
    await listTargets(t)({ status: 'all', q: '  ' })
    expect(t.get).toHaveBeenLastCalledWith('targets/', {
      signal: undefined,
      query: expect.objectContaining({ status: undefined, q: undefined, page: undefined }),
    })
  })

  it.each([
    [
      'a protocol that is not icmp or tcp',
      list({ items: [item({ target: target({ protocol: 'udp' }) })] }),
    ],
    ['a reason it does not know', list({ items: [item({ reason: 'sleepy' })] })],
    ['a health it does not know', list({ items: [item({ health: 'fine' })] })],
    [
      'an agent with an unknown status',
      list({ items: [item({ target: target({ agent: { ...agent, status: 'asleep' } }) })] }),
    ],
    [
      'a measurement with no time',
      list({ items: [item({ latest: measurement({ measuredAt: 'soon' }) })] }),
    ],
    [
      'a loss that is not a number',
      list({ items: [item({ latest: measurement({ lossPercent: '1%' }) })] }),
    ],
    ['an interval of zero', list({ items: [item({ target: target({ intervalSeconds: 0 }) })] })],
    ['counts that are not numbers', list({ counts: { ...counts, healthy: 'many' } })],
    ['no page', list({ page: undefined })],
    ['something that is not an object', 'oops'],
  ])('refuses %s as a bad response, not a guess', (_name, answer) => {
    expect(() => parseTargetList(answer)).toThrow(ApiError)
    try {
      parseTargetList(answer)
    } catch (error) {
      expect(error).toMatchObject({ code: 'bad_response' })
    }
  })
})

describe('target detail', () => {
  it('maps the item, the recent measurements and the 24 hours', async () => {
    const t = transport(detail())
    const result = await getTarget(t)('a b/c')
    expect(t.get).toHaveBeenCalledWith('targets/a%20b%2Fc/', { signal: undefined })
    expect(result.item.target.name).toBe('ath-gateway')
    expect(result.measurements).toHaveLength(1)
    expect(result.availability24h).toEqual(availability)
  })

  it('keeps an availability with no measurements as null percent and its own coverage', () => {
    const result = parseTargetDetail(
      detail({
        availability24h: {
          ...availability,
          measurements: 0,
          successful: 0,
          percent: null,
          coveragePercent: 0,
        },
      }),
    )
    expect(result.availability24h).toMatchObject({
      percent: null,
      coveragePercent: 0,
      measurements: 0,
    })
  })

  it('refuses an availability that is not whole', () => {
    expect(() =>
      parseTargetDetail(detail({ availability24h: { ...availability, successful: 'all' } })),
    ).toThrow(ApiError)
    expect(() => parseTargetDetail(detail({ availability24h: null }))).toThrow(ApiError)
  })

  it('lets a 404 through for the page to say not found', async () => {
    const t = { get: vi.fn().mockRejectedValue(new ApiError('Not found.', 404)), post: vi.fn() }
    await expect(getTarget(t as unknown as Transport)('x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('target series', () => {
  it('maps parallel arrays and keeps null buckets as null', async () => {
    const t = transport(series())
    const result = await getTargetSeries(t)({ targetId: 't1', range: '6h' })
    expect(t.get).toHaveBeenCalledWith('targets/t1/series/', {
      signal: undefined,
      query: { range: '6h' },
    })
    expect(result.latencyMs).toEqual([10, null, 12.5])
    expect(result.latencyMaxMs).toEqual([14, null, 19])
    expect(result.lossPercent).toEqual([0, null, 1.5])
    expect(result.measurements).toEqual([1, 0, 2])
    expect(result.failed).toEqual([0, 0, 1])
  })

  it('accepts the empty arrays of a target never measured', () => {
    const empty = parseTargetSeries(
      series({
        t: [],
        latencyMs: [],
        latencyMaxMs: [],
        lossPercent: [],
        measurements: [],
        failed: [],
      }),
    )
    expect(empty.t).toEqual([])
  })

  it('refuses arrays that are not as long as the time axis, and counts that are not whole', () => {
    expect(() => parseTargetSeries(series({ latencyMs: [1, 2] }))).toThrow(ApiError)
    expect(() => parseTargetSeries(series({ failed: [0, 0] }))).toThrow(ApiError)
    expect(() => parseTargetSeries(series({ measurements: [1, 0.5, 2] }))).toThrow(ApiError)
    expect(() => parseTargetSeries(series({ lossPercent: [0, 'x', 1] }))).toThrow(ApiError)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import {
  getDevice,
  getDeviceSeries,
  getInterfaceSeries,
  listDevices,
  parseDeviceDetail,
  parseDeviceList,
  parseDeviceSeries,
  parseInterfaceSeries,
} from './devices'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (devices.py). */
const counts = { healthy: 3, warning: 1, critical: 1, unknown: 2, idle: 1 }
const agent = {
  id: 'a1',
  name: 'ath-probe',
  status: 'online',
  lastSeenAt: '2026-10-17T10:00:00.000Z',
  serverId: 's1',
  serverName: 'ath-probe-01',
}
const device = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'ath-core-sw',
  type: 'switch',
  address: '10.20.0.250',
  enabled: true,
  siteId: 'site-1',
  snmpVersion: '2c',
  port: 161,
  pollIntervalSeconds: 60,
  timeoutSeconds: 5,
  retries: 2,
  agentAssigned: true,
  agent,
  ...over,
})
const state = (over: Record<string, unknown> = {}) => ({
  reachable: true,
  error: null,
  responseMs: 12.4,
  uptimeSeconds: 259200,
  sysName: 'ath-core-sw.example.net',
  sysDescr: 'Example OS',
  sysObjectId: '1.3.6.1.4.1.9.1.1',
  lastPollAt: '2026-10-17T10:00:00.000Z',
  lastSuccessAt: '2026-10-17T10:00:00.000Z',
  lastDiscoveryAt: '2026-10-17T09:00:00.000Z',
  receivedAt: '2026-10-17T10:00:01.000Z',
  ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  device: device(),
  state: state(),
  stale: false,
  health: 'healthy',
  reason: 'ok',
  interfaces: { total: 8, counts },
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
const rates = (over: Record<string, unknown> = {}) => ({
  measuredAt: '2026-10-17T10:00:00.000Z',
  deltaState: 'ok',
  octetsBits: 64,
  intervalSeconds: 60,
  valid: true,
  invalidReason: null,
  inBps: 420000000,
  outBps: 85000000,
  inUtilizationPercent: 42,
  outUtilizationPercent: 8.5,
  inErrorsPerSec: 0,
  outErrorsPerSec: 0.05,
  inDiscardsPerSec: 0,
  outDiscardsPerSec: 1.5,
  ...over,
})
const invalid = (reason: string, deltaState = 'ok') =>
  rates({
    valid: false,
    invalidReason: reason,
    deltaState,
    inBps: null,
    outBps: null,
    inUtilizationPercent: null,
    outUtilizationPercent: null,
    inErrorsPerSec: null,
    outErrorsPerSec: null,
    inDiscardsPerSec: null,
    outDiscardsPerSec: null,
  })
const iface = (over: Record<string, unknown> = {}) => ({
  ifIndex: 1,
  name: 'Gi1/0/1',
  descr: 'GigabitEthernet1/0/1',
  alias: 'uplink',
  type: 6,
  speedBps: 1000000000,
  adminStatus: 'up',
  operStatus: 'up',
  operStatusChangedAt: '2026-10-16T10:00:00.000Z',
  health: 'healthy',
  reason: 'up',
  rates: rates(),
  ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: item(),
  polls: [
    {
      measuredAt: '2026-10-17T10:00:00.000Z',
      receivedAt: '2026-10-17T10:00:01.000Z',
      reachable: true,
      responseMs: 11,
      error: null,
    },
  ],
  interfaces: [iface()],
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get, post: vi.fn() } as unknown as Transport & { get: typeof get }
}

describe('devices list', () => {
  it('maps the answer onto the view-model, keeping the page, the counts and the scope total', async () => {
    const result = await listDevices(transport(list()))({ q: ' core ' })
    const [first] = result.items
    expect(first?.device).toMatchObject({
      id: 'd1',
      type: 'switch',
      address: '10.20.0.250',
      snmpVersion: '2c',
      port: 161,
      pollIntervalSeconds: 60,
      timeoutSeconds: 5,
      retries: 2,
      agentAssigned: true,
      agent: { name: 'ath-probe', status: 'online', serverId: 's1', serverName: 'ath-probe-01' },
    })
    expect(first).toMatchObject({
      health: 'healthy',
      reason: 'ok',
      stale: false,
      customerName: 'Meridian',
      siteName: 'Athens DC',
      interfaces: { total: 8, counts },
      state: { reachable: true, responseMs: 12.4, sysName: 'ath-core-sw.example.net' },
    })
    expect(result.page).toEqual({ number: 1, size: 50, total: 1, pages: 1 })
    expect(result.counts).toEqual(counts)
    expect(result.scopeTotal).toBe(8)
  })

  it('never carries a credential: only the fields named are read, whatever else an answer holds', () => {
    const sneaky = list({
      items: [
        item({
          device: {
            ...device(),
            credentialProfile: 'prod-snmp',
            community: 'public',
            authKey: 'x',
          },
          credentials: { name: 'prod-snmp' },
        }),
      ],
    })
    const parsed = JSON.stringify(parseDeviceList(sneaky))
    expect(parsed).not.toMatch(/credential|community|authKey|prod-snmp|public/i)
  })

  it('keeps a device never polled as no state, and a stale poll marked stale', () => {
    const [never, stale] = parseDeviceList(
      list({
        items: [
          item({ state: null, reason: 'no_poll', health: 'unknown' }),
          item({ stale: true, reason: 'stale', health: 'unknown' }),
        ],
      }),
    ).items
    expect(never?.state).toBeNull()
    expect(stale).toMatchObject({ stale: true, reason: 'stale' })
  })

  it('keeps an unreachable poll as it is: its error word and no response time', () => {
    const [down] = parseDeviceList(
      list({
        items: [
          item({
            state: state({ reachable: false, error: 'timeout', responseMs: null }),
            health: 'critical',
            reason: 'unreachable',
          }),
        ],
      }),
    ).items
    expect(down?.state).toMatchObject({ reachable: false, error: 'timeout', responseMs: null })
  })

  it('keeps an assigned agent the user may not see as no agent object, apart from no agent at all', () => {
    const [hidden, none] = parseDeviceList(
      list({
        items: [
          item({ device: device({ agentAssigned: true, agent: null }) }),
          item({ device: device({ agentAssigned: false, agent: null }) }),
        ],
      }),
    ).items
    expect(hidden?.device).toMatchObject({ agentAssigned: true, agent: null })
    expect(none?.device).toMatchObject({ agentAssigned: false, agent: null })
  })

  it('trusts the health and reason the server decided: an interface count never changes the device’s', () => {
    // Every interface down and the server still calls the device healthy: a switch with ports down is healthy.
    const [first] = parseDeviceList(
      list({
        items: [item({ interfaces: { total: 4, counts: { ...counts, healthy: 0, warning: 4 } } })],
      }),
    ).items
    expect(first?.health).toBe('healthy')
  })

  it('sends only what differs from the defaults: scope, search, filter, sort, page', async () => {
    const t = transport(list())
    await listDevices(t)({
      scope: { customerId: 'c1', siteId: 's1' },
      q: ' core  sw ',
      status: 'critical',
      sort: 'response',
      dir: 'asc',
      page: 3,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('devices/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: 's1',
        q: 'core  sw',
        status: 'critical',
        sort: 'response',
        dir: 'asc',
        page: '3',
        pageSize: '50',
      },
    })
    await listDevices(t)({ status: 'all', q: '  ' })
    expect(t.get).toHaveBeenLastCalledWith('devices/', {
      signal: undefined,
      query: expect.objectContaining({ status: undefined, q: undefined, page: undefined }),
    })
  })

  it.each([
    [
      'a type that is not a device type',
      list({ items: [item({ device: device({ type: 'toaster' }) })] }),
    ],
    [
      'an SNMP version it does not know',
      list({ items: [item({ device: device({ snmpVersion: '1' }) })] }),
    ],
    ['a reason it does not know', list({ items: [item({ reason: 'sleepy' })] })],
    ['a health it does not know', list({ items: [item({ health: 'fine' })] })],
    ['a poll with no time', list({ items: [item({ state: state({ lastPollAt: 'soon' }) })] })],
    [
      'a response time that is not a number',
      list({ items: [item({ state: state({ responseMs: '12' }) })] }),
    ],
    [
      'interface counts that are not numbers',
      list({ items: [item({ interfaces: { total: 1, counts: { ...counts, idle: 'x' } } })] }),
    ],
    ['a port of zero', list({ items: [item({ device: device({ port: 0 }) })] })],
    ['no page', list({ page: undefined })],
    ['something that is not an object', 'oops'],
  ])('refuses %s as a bad response, not a guess', (_name, answer) => {
    expect(() => parseDeviceList(answer)).toThrow(ApiError)
    try {
      parseDeviceList(answer)
    } catch (error) {
      expect(error).toMatchObject({ code: 'bad_response' })
    }
  })
})

describe('device detail', () => {
  it('maps the item, the polls and the interfaces', async () => {
    const t = transport(detail())
    const result = await getDevice(t)('a b/c')
    expect(t.get).toHaveBeenCalledWith('devices/a%20b%2Fc/', { signal: undefined })
    expect(result.item.device.name).toBe('ath-core-sw')
    expect(result.polls).toEqual([
      {
        measuredAt: '2026-10-17T10:00:00.000Z',
        receivedAt: '2026-10-17T10:00:01.000Z',
        reachable: true,
        responseMs: 11,
        error: null,
      },
    ])
    expect(result.interfaces[0]).toMatchObject({
      ifIndex: 1,
      name: 'Gi1/0/1',
      descr: 'GigabitEthernet1/0/1',
      alias: 'uplink',
      speedBps: 1000000000,
      adminStatus: 'up',
      operStatus: 'up',
      health: 'healthy',
      reason: 'up',
    })
  })

  it('keeps the rates exactly as the API calculated them, with no recalculation', () => {
    const [first] = parseDeviceDetail(detail()).interfaces
    expect(first?.rates).toEqual({
      measuredAt: '2026-10-17T10:00:00.000Z',
      deltaState: 'ok',
      octetsBits: 64,
      intervalSeconds: 60,
      valid: true,
      invalidReason: null,
      inBps: 420000000,
      outBps: 85000000,
      inUtilizationPercent: 42,
      outUtilizationPercent: 8.5,
      inErrorsPerSec: 0,
      outErrorsPerSec: 0.05,
      inDiscardsPerSec: 0,
      outDiscardsPerSec: 1.5,
    })
  })

  it('keeps a valid zero as 0 and an unknown speed as null with the bps standing', () => {
    const [first] = parseDeviceDetail(
      detail({
        interfaces: [
          iface({
            speedBps: null,
            rates: rates({ inBps: 0, inUtilizationPercent: null, outUtilizationPercent: null }),
          }),
        ],
      }),
    ).interfaces
    expect(first?.speedBps).toBeNull()
    expect(first?.rates).toMatchObject({ valid: true, inBps: 0, inUtilizationPercent: null })
  })

  it.each([
    ['delta_state', 'first'],
    ['delta_state', 'reboot'],
    ['delta_state', 'reset'],
    ['delta_state', 'gap'],
    ['interval', 'ok'],
    ['implausible', 'ok'],
    ['stale', 'ok'],
  ])('keeps an invalid sample (%s, %s) with every rate null, never 0', (reason, deltaState) => {
    const [first] = parseDeviceDetail(
      detail({ interfaces: [iface({ rates: invalid(reason, deltaState) })] }),
    ).interfaces
    expect(first?.rates).toMatchObject({
      valid: false,
      invalidReason: reason,
      deltaState,
      inBps: null,
      outBps: null,
      inUtilizationPercent: null,
      outErrorsPerSec: null,
      inDiscardsPerSec: null,
    })
  })

  it('keeps an interface never sampled as no rates', () => {
    const [first] = parseDeviceDetail(detail({ interfaces: [iface({ rates: null })] })).interfaces
    expect(first?.rates).toBeNull()
  })

  it('refuses rates that contradict themselves: an invalid sample that gives a rate, or a valid one that says why not', () => {
    const lie = rates({ valid: false, invalidReason: 'stale' }) // invalid, yet bps present
    expect(() => parseDeviceDetail(detail({ interfaces: [iface({ rates: lie })] }))).toThrow(
      ApiError,
    )
    const confused = rates({ invalidReason: 'stale' }) // valid, yet a reason
    expect(() => parseDeviceDetail(detail({ interfaces: [iface({ rates: confused })] }))).toThrow(
      ApiError,
    )
    const silent = { ...invalid('stale'), invalidReason: null } // invalid, no reason
    expect(() => parseDeviceDetail(detail({ interfaces: [iface({ rates: silent })] }))).toThrow(
      ApiError,
    )
  })

  it('refuses an invalid reason it does not know, and a health or reason it does not know', () => {
    expect(() =>
      parseDeviceDetail(detail({ interfaces: [iface({ rates: invalid('mood') })] })),
    ).toThrow(ApiError)
    expect(() => parseDeviceDetail(detail({ interfaces: [iface({ reason: 'moody' })] }))).toThrow(
      ApiError,
    )
    expect(() => parseDeviceDetail(detail({ interfaces: [iface({ health: 'fine' })] }))).toThrow(
      ApiError,
    )
  })

  it('lets a 404 through for the page to say not found', async () => {
    const t = { get: vi.fn().mockRejectedValue(new ApiError('Not found.', 404)), post: vi.fn() }
    await expect(getDevice(t as unknown as Transport)('x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('device series', () => {
  const series = (over: Record<string, unknown> = {}) => ({
    generatedAt: '2026-10-17T10:00:05.000Z',
    bucketMs: 60000,
    t: [1, 2, 3],
    responseMs: [10, null, 12.5],
    reachablePolls: [1, 0, 2],
    failedPolls: [0, 1, 0],
    ...over,
  })

  it('maps parallel arrays, keeps null buckets null, and asks for the range', async () => {
    const t = transport(series())
    const result = await getDeviceSeries(t)({ deviceId: 'd1', range: '6h' })
    expect(t.get).toHaveBeenCalledWith('devices/d1/series/', {
      signal: undefined,
      query: { range: '6h' },
    })
    expect(result.responseMs).toEqual([10, null, 12.5])
    expect(result.reachablePolls).toEqual([1, 0, 2])
    expect(result.failedPolls).toEqual([0, 1, 0])
  })

  it('accepts the empty arrays of a device never polled, and refuses arrays of another length', () => {
    expect(
      parseDeviceSeries(series({ t: [], responseMs: [], reachablePolls: [], failedPolls: [] })).t,
    ).toEqual([])
    expect(() => parseDeviceSeries(series({ responseMs: [1] }))).toThrow(ApiError)
    expect(() => parseDeviceSeries(series({ failedPolls: [0, 0.5, 0] }))).toThrow(ApiError)
  })
})

describe('interface series', () => {
  const series = (over: Record<string, unknown> = {}) => ({
    generatedAt: '2026-10-17T10:00:05.000Z',
    bucketMs: 60000,
    t: [1, 2, 3],
    inBps: [400, null, 410],
    outBps: [80, null, 85],
    inBpsMax: [500, null, 450],
    outBpsMax: [100, null, 90],
    inErrorsPerSec: [0, null, 0],
    outErrorsPerSec: [0, null, 0],
    inDiscardsPerSec: [0, null, 1.5],
    outDiscardsPerSec: [0, null, 0],
    validSamples: [1, 0, 1],
    invalidSamples: [0, 2, 0],
    ...over,
  })

  it('maps every column, keeps null buckets null and a real 0 as 0, and asks for the interface and range', async () => {
    const t = transport(series())
    const result = await getInterfaceSeries(t)({ deviceId: 'd 1', ifIndex: 12, range: '24h' })
    expect(t.get).toHaveBeenCalledWith('devices/d%201/interfaces/12/series/', {
      signal: undefined,
      query: { range: '24h' },
    })
    expect(result.inBps).toEqual([400, null, 410])
    expect(result.inErrorsPerSec).toEqual([0, null, 0])
    expect(result.validSamples).toEqual([1, 0, 1])
    // A bucket of only unusable samples is a gap with a count, not 0 traffic.
    expect(result.inBps[1]).toBeNull()
    expect(result.invalidSamples[1]).toBe(2)
  })

  it('accepts the empty arrays of an interface never sampled, and refuses ragged ones', () => {
    const arrays = Object.keys(series()).filter((key) => !['generatedAt', 'bucketMs'].includes(key))
    const empty = Object.fromEntries(arrays.map((key) => [key, []]))
    expect(parseInterfaceSeries(series(empty)).t).toEqual([])
    expect(() => parseInterfaceSeries(series({ inBps: [1, 2] }))).toThrow(ApiError)
    expect(() => parseInterfaceSeries(series({ invalidSamples: [0, 1.5, 0] }))).toThrow(ApiError)
    expect(() => parseInterfaceSeries(series({ outBpsMax: [1, 'x', 3] }))).toThrow(ApiError)
  })
})

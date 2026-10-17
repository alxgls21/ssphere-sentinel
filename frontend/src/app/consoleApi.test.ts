import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleHttp } from '@/api/http'
import type { ContainerList, DeviceList, ServerList, TargetList } from '@/api/types'
import { item as deviceItem } from '@/features/snmp/testing'
import { OVERVIEW_PAGE_SIZE } from '@/lib/overview'
import { emptyCounts } from '@/lib/status'
import { createConsoleApi } from './consoleApi'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const page = { number: 1, size: OVERVIEW_PAGE_SIZE, total: 0, pages: 1 }

const servers = (over: Partial<ServerList> = {}): ServerList => ({
  generatedAt: new Date(NOW).toISOString(),
  items: [],
  page,
  counts: { ...emptyCounts(), healthy: 12, critical: 1 },
  scopeTotal: 13,
  ...over,
})
const containers = (over: Partial<ContainerList> = {}): ContainerList => ({
  generatedAt: new Date(NOW).toISOString(),
  items: [],
  page,
  counts: { ...emptyCounts(), healthy: 40, idle: 2 },
  scopeTotal: 42,
  ...over,
})
const targets = (over: Partial<TargetList> = {}): TargetList => ({
  generatedAt: new Date(NOW).toISOString(),
  items: [],
  page,
  counts: { ...emptyCounts(), healthy: 30, warning: 2, critical: 1, unknown: 3 },
  scopeTotal: 36,
  ...over,
})

const devices = (over: Partial<DeviceList> = {}): DeviceList => ({
  generatedAt: new Date(NOW).toISOString(),
  items: [],
  page,
  counts: { ...emptyCounts(), healthy: 90, critical: 4, unknown: 6, idle: 2 },
  scopeTotal: 102,
  ...over,
})

function fakeHttp(over: Partial<ConsoleHttp> = {}) {
  const http = {
    auth: {},
    getScopeOptions: vi.fn(async () => ({ customers: [], sites: [] })),
    listServers: vi.fn(async () => servers()),
    listContainers: vi.fn(async () => containers()),
    listTargets: vi.fn(async () => targets()),
    listDevices: vi.fn(async () => devices()),
    getDevice: vi.fn(),
    getDeviceSeries: vi.fn(),
    getInterfaceSeries: vi.fn(),
    getServer: vi.fn(),
    getServerSeries: vi.fn(),
    getFleetLoad: vi.fn(),
    ...over,
  } as unknown as ConsoleHttp & {
    listServers: ReturnType<typeof vi.fn>
    listContainers: ReturnType<typeof vi.fn>
    listTargets: ReturnType<typeof vi.fn>
    listDevices: ReturnType<typeof vi.fn>
    getDevice: ReturnType<typeof vi.fn>
    getDeviceSeries: ReturnType<typeof vi.fn>
    getInterfaceSeries: ReturnType<typeof vi.fn>
  }
  return http
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('createConsoleApi', () => {
  it('is the console API: source http, and exactly the methods the API can answer', () => {
    const api = createConsoleApi(fakeHttp())
    expect(api.source).toBe('http')
    expect(Object.keys(api).sort()).toEqual(
      [
        'getEntityIndex',
        'getFleetLoad',
        'getHealthBreakdown',
        'getOverviewSummary',
        'getScopeOptions',
        'getServer',
        'getInterfaceSeries',
        'getServerSeries',
        'getDevice',
        'getDeviceSeries',
        'getTarget',
        'getTargetSeries',
        'listAttention',
        'listContainers',
        'listDevices',
        'listTargets',
        'listServers',
        'source',
      ].sort(),
    )
    for (const missing of ['listAlerts', 'listEvents', 'getNetworkSeries']) {
      expect(api).not.toHaveProperty(missing)
    }
  })

  it('builds the summary from the console API’s own counts and totals', async () => {
    const api = createConsoleApi(fakeHttp())
    const summary = await api.getOverviewSummary()
    expect(summary.servers).toMatchObject({ total: 13, counts: { healthy: 12, critical: 1 } })
    expect(summary.containers).toMatchObject({ total: 42, counts: { healthy: 40, idle: 2 } })
    expect(summary.targets).toEqual({
      total: 36,
      counts: { healthy: 30, warning: 2, critical: 1, unknown: 3, idle: 0 },
    })
    expect(summary.devices).toEqual({
      total: 102,
      counts: { healthy: 90, warning: 0, critical: 4, unknown: 6, idle: 2 },
    })
  })

  it('asks for the worst first of servers, containers, targets and devices, one worst-first page of each', async () => {
    const http = fakeHttp()
    await createConsoleApi(http).getOverviewSummary({ scope: { customerId: 'c1', siteId: null } })
    const query = {
      scope: { customerId: 'c1', siteId: null },
      sort: 'status',
      dir: 'desc',
      page: 1,
      pageSize: OVERVIEW_PAGE_SIZE,
    }
    expect(http.listServers).toHaveBeenCalledExactlyOnceWith(query)
    expect(http.listContainers).toHaveBeenCalledExactlyOnceWith(query)
    expect(http.listTargets).toHaveBeenCalledExactlyOnceWith(query)
    expect(http.listDevices).toHaveBeenCalledExactlyOnceWith(query)
  })

  it('reads the devices in the same scope as the rest: customer and site together', async () => {
    const http = fakeHttp()
    const scope = { customerId: 'c1', siteId: 's1' }
    await createConsoleApi(http).getHealthBreakdown({ scope })
    expect(http.listDevices).toHaveBeenCalledWith(expect.objectContaining({ scope }))
    expect(http.listServers).toHaveBeenCalledWith(expect.objectContaining({ scope }))
  })

  it('builds the queue and the health from the devices the page returns, beyond which it claims nothing', async () => {
    const down = deviceItem({ id: 'd1', name: 'pir-core', reason: 'unreachable' })
    const ok = deviceItem({
      id: 'd2',
      name: 'ath-core-sw',
      reason: 'ok',
      interfaces: { healthy: 4 },
    })
    const http = fakeHttp({
      listDevices: vi.fn(async () => devices({ items: [down, ok] })),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    const queue = await api.listAttention()
    expect(queue.items.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['device:pir-core'])
    // 17 problems exist (1 server, 6 targets, 10 devices) and one row is listed: 16 are beyond the rows.
    expect(queue.omitted).toBe(16)
    const health = await api.getHealthBreakdown()
    expect(health.domains[3]).toMatchObject({
      domain: 'snmp',
      counts: { healthy: 90, critical: 4, unknown: 6, idle: 2 },
      interfaces: { devices: 2, of: 102, complete: false },
    })
  })

  it('asks for no device one by one: no detail, no history, no second page', async () => {
    const http = fakeHttp({
      listDevices: vi.fn(async () =>
        devices({
          scopeTotal: 5000,
          page: { number: 1, size: OVERVIEW_PAGE_SIZE, total: 5000, pages: 25 },
        }),
      ),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    await Promise.all([api.getOverviewSummary(), api.listAttention(), api.getHealthBreakdown()])
    expect(http.listDevices).toHaveBeenCalledTimes(1)
    expect(http.listDevices).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: OVERVIEW_PAGE_SIZE }),
    )
    expect(http.getDevice).not.toHaveBeenCalled()
    expect(http.getDeviceSeries).not.toHaveBeenCalled()
    expect(http.getInterfaceSeries).not.toHaveBeenCalled()
  })

  it('answers the verdict, the queue and the health panel from one set of requests', async () => {
    const http = fakeHttp()
    const api = createConsoleApi(http)
    await Promise.all([api.getOverviewSummary(), api.listAttention(), api.getHealthBreakdown()])
    expect(http.listServers).toHaveBeenCalledTimes(1)
    expect(http.listTargets).toHaveBeenCalledTimes(1)
    expect(http.listContainers).toHaveBeenCalledTimes(1)
    expect(http.listDevices).toHaveBeenCalledTimes(1)
  })

  it('asks again once the shared answer is old, and again for another scope', async () => {
    const http = fakeHttp()
    const api = createConsoleApi(http)
    await api.getOverviewSummary()
    vi.advanceTimersByTime(2000)
    await api.getOverviewSummary()
    expect(http.listServers).toHaveBeenCalledTimes(2)
    await api.getOverviewSummary({ scope: { customerId: null, siteId: 's1' } })
    expect(http.listServers).toHaveBeenCalledTimes(3)
  })

  it('does not share a failure: the next request asks again, and the failure is the panel’s own', async () => {
    const listServers = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValue(servers())
    const http = fakeHttp({ listServers } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    await expect(api.getOverviewSummary()).rejects.toThrow('503')
    await expect(api.getOverviewSummary()).resolves.toMatchObject({ servers: { total: 13 } })
    expect(listServers).toHaveBeenCalledTimes(2)
  })

  it('rejects the whole Overview when the targets cannot be read: no summary without them', async () => {
    const http = fakeHttp({
      listTargets: vi.fn().mockRejectedValue(new Error('targets down')),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    await expect(api.getOverviewSummary()).rejects.toThrow('targets down')
    await expect(api.listAttention()).rejects.toThrow('targets down')
    await expect(api.getHealthBreakdown()).rejects.toThrow('targets down')
  })

  it('rejects the whole Overview when the devices cannot be read: no summary without them, no sample', async () => {
    const http = fakeHttp({
      listDevices: vi.fn().mockRejectedValue(new Error('devices down')),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    await expect(api.getOverviewSummary()).rejects.toThrow('devices down')
    await expect(api.listAttention()).rejects.toThrow('devices down')
    await expect(api.getHealthBreakdown()).rejects.toThrow('devices down')
  })

  it('never stands in for a failed list: a failure rejects, with no summary, queue or breakdown', async () => {
    const http = fakeHttp({
      listContainers: vi.fn().mockRejectedValue(new Error('down')),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    await expect(api.getOverviewSummary()).rejects.toThrow('down')
    await expect(api.listAttention()).rejects.toThrow('down')
    await expect(api.getHealthBreakdown()).rejects.toThrow('down')
  })

  it('lets one caller stop waiting without cancelling the others', async () => {
    let release: (list: ServerList) => void = () => {}
    const listServers = vi.fn(() => new Promise<ServerList>((resolve) => (release = resolve)))
    const api = createConsoleApi(fakeHttp({ listServers } as Partial<ConsoleHttp>))
    const controller = new AbortController()
    const aborted = api.getOverviewSummary({ signal: controller.signal })
    const other = api.listAttention()
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    release(servers())
    await expect(other).resolves.toMatchObject({ items: [] })
  })

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createConsoleApi(fakeHttp()).getOverviewSummary({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes the server screens straight to the console API', async () => {
    const http = fakeHttp()
    const api = createConsoleApi(http)
    await api.listServers({ q: 'db' })
    expect(http.listServers).toHaveBeenCalledWith({ q: 'db' })
    const signal = new AbortController().signal
    await api.getScopeOptions({ signal })
    expect(http.getScopeOptions).toHaveBeenCalledWith(signal)
  })

  it('passes the container inventory straight to the console API, with its query', async () => {
    const http = fakeHttp({
      listContainers: vi.fn(async () => containers({ scopeTotal: 9 })),
    } as Partial<ConsoleHttp>)
    const api = createConsoleApi(http)
    const list = await api.listContainers({ q: 'pg', status: 'critical', server: 'srv-1' })
    expect(http.listContainers).toHaveBeenCalledExactlyOnceWith({
      q: 'pg',
      status: 'critical',
      server: 'srv-1',
    })
    expect(list.scopeTotal).toBe(9)
  })

  it('has no search index yet, and says so with an empty one rather than a made-up list', async () => {
    const index = await createConsoleApi(fakeHttp()).getEntityIndex()
    expect(index.items).toEqual([])
  })
})

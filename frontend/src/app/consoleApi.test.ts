import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleHttp } from '@/api/http'
import type { ContainerList, ServerList } from '@/api/types'
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

function fakeHttp(over: Partial<ConsoleHttp> = {}) {
  const http = {
    auth: {},
    getScopeOptions: vi.fn(async () => ({ customers: [], sites: [] })),
    listServers: vi.fn(async () => servers()),
    listContainers: vi.fn(async () => containers()),
    getServer: vi.fn(),
    getServerSeries: vi.fn(),
    getFleetLoad: vi.fn(),
    ...over,
  } as unknown as ConsoleHttp & {
    listServers: ReturnType<typeof vi.fn>
    listContainers: ReturnType<typeof vi.fn>
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
        'getServerSeries',
        'listAttention',
        'listContainers',
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
    expect(summary).not.toHaveProperty('targets')
  })

  it('asks for the worst first of servers and containers, one worst-first page of each', async () => {
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
  })

  it('answers the verdict, the queue and the health panel from one pair of requests', async () => {
    const http = fakeHttp()
    const api = createConsoleApi(http)
    await Promise.all([api.getOverviewSummary(), api.listAttention(), api.getHealthBreakdown()])
    expect(http.listServers).toHaveBeenCalledTimes(1)
    expect(http.listContainers).toHaveBeenCalledTimes(1)
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

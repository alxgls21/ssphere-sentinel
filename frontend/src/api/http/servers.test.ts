import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { getFleetLoad, getServer, getServerSeries, listServers, parseServerList } from './servers'
import { createTransport, type Transport } from './transport'

/** The shapes below are what apps/console serves (servers.py, containers.py, history.py). */
const counts = { healthy: 3, warning: 1, critical: 1, unknown: 0, idle: 0 }
const telemetry = {
  cpuPercent: 41.5,
  memoryPercent: 62,
  diskPercent: 71.2,
  memoryTotalBytes: 17179869184,
  diskTotalBytes: 536870912000,
  uptimeSeconds: 86400,
  collectedAt: '2026-10-17T10:00:00.000Z',
  receivedAt: '2026-10-17T10:00:01.000Z',
  stale: false,
}
const server = {
  id: '6f1c0d2e-5a1b-4c1d-9a55-0d6c9f6c3c11',
  name: 'ath-db-01',
  hostname: 'ath-db-01.example.net',
  ipAddress: '10.0.0.5',
  operatingSystem: 'Debian 12',
  status: 'online',
  siteId: '2a8d5f2e-7b1c-4d0e-8f3a-1b2c3d4e5f60',
  lastSeenAt: '2026-10-17T10:00:01.000Z',
  agentVersion: '0.4.2',
  telemetry,
}
const item = (over: Record<string, unknown> = {}) => ({
  server,
  health: 'healthy',
  customerName: 'Meridian',
  siteName: 'Athens DC',
  containers: { total: 2, counts },
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items: [item()],
  page: { number: 1, size: 50, total: 1, pages: 1 },
  counts,
  scopeTotal: 6,
  ...over,
})
const container = {
  container: {
    id: `${server.id}:abc123`,
    serverId: server.id,
    name: 'pgbouncer',
    image: 'edoburu/pgbouncer:1.22',
    state: 'running',
    health: 'healthy',
    startedAt: '2026-10-16T08:00:00.000Z',
  },
  status: 'healthy',
}
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: item(),
  containers: [container],
  ...over,
})
const series = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  bucketMs: 60000,
  t: [1760695200000, 1760695260000, 1760695320000],
  cpu: [10, null, 12.5],
  memory: [50, 51, null],
  disk: [70, 70, 70],
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get, post: vi.fn() } as unknown as Transport & { get: typeof get }
}

describe('servers list', () => {
  it('maps the answer onto the view-model, keeping the page, the counts and the scope total', async () => {
    const t = transport(list())
    const result = await listServers(t)({ q: ' db ' })
    expect(result.items).toHaveLength(1)
    const [first] = result.items
    expect(first?.server).toMatchObject({
      id: server.id,
      status: 'online',
      siteId: server.siteId,
      telemetry: { stale: false, receivedAt: telemetry.receivedAt },
    })
    expect(first).toMatchObject({
      health: 'healthy',
      customerName: 'Meridian',
      siteName: 'Athens DC',
    })
    expect(result.page).toEqual({ number: 1, size: 50, total: 1, pages: 1 })
    expect(result.counts).toEqual(counts)
    expect(result.scopeTotal).toBe(6)
  })

  it('trusts the health the server decided and does not work it out again', async () => {
    // 99% CPU and "healthy": the console shows the server's verdict, whatever it would have judged.
    const loud = { ...telemetry, cpuPercent: 99 }
    const result = parseServerList(
      list({ items: [item({ health: 'healthy', server: { ...server, telemetry: loud } })] }),
    )
    expect(result.items[0]?.health).toBe('healthy')
  })

  it('keeps a stale reading marked stale and an absent one absent', () => {
    const result = parseServerList(
      list({
        items: [
          item({ server: { ...server, telemetry: { ...telemetry, stale: true } } }),
          item({ server: { ...server, telemetry: null } }),
        ],
      }),
    )
    expect(result.items[0]?.server.telemetry?.stale).toBe(true)
    expect(result.items[1]?.server.telemetry).toBeNull()
  })

  it('sends only what differs from the defaults: scope, search, filter, sort, page', async () => {
    const t = transport(list())
    await listServers(t)({
      scope: { customerId: 'c1', siteId: 's1' },
      q: ' web  ',
      status: 'warning',
      sort: 'cpu',
      dir: 'asc',
      page: 3,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('servers/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: 's1',
        q: 'web',
        status: 'warning',
        sort: 'cpu',
        dir: 'asc',
        page: '3',
        pageSize: '50',
      },
    })
    await listServers(t)({ q: '   ', status: 'all' })
    expect(t.get).toHaveBeenLastCalledWith('servers/', {
      signal: undefined,
      query: expect.objectContaining({ q: undefined, status: undefined, page: undefined }),
    })
  })

  it('passes the abort signal to the request', async () => {
    const t = transport(list())
    const controller = new AbortController()
    await listServers(t)({ signal: controller.signal })
    expect(t.get).toHaveBeenCalledWith(
      'servers/',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it.each([
    ['not an object', 'nope'],
    ['no page', list({ page: undefined })],
    ['a page without a total', list({ page: { number: 1, size: 50, pages: 1 } })],
    ['a page number of zero', list({ page: { number: 0, size: 50, total: 1, pages: 1 } })],
    ['no counts', list({ counts: undefined })],
    ['a count that is not a whole number', list({ counts: { ...counts, healthy: 1.5 } })],
    ['a negative scope total', list({ scopeTotal: -1 })],
    ['items that are not a list', list({ items: {} })],
    ['an unknown health', list({ items: [item({ health: 'fine' })] })],
    ['an unknown server status', list({ items: [item({ server: { ...server, status: 'up' } })] })],
    ['a timestamp that does not parse', list({ generatedAt: 'yesterday' })],
    [
      'a stale flag that is not a boolean',
      list({ items: [item({ server: { ...server, telemetry: { ...telemetry, stale: 'no' } } })] }),
    ],
    [
      'a reading that is not a number',
      list({
        items: [item({ server: { ...server, telemetry: { ...telemetry, cpuPercent: '41' } } })],
      }),
    ],
    [
      'a reading that is not finite',
      list({
        items: [
          item({
            server: {
              ...server,
              telemetry: { ...telemetry, cpuPercent: Number.POSITIVE_INFINITY },
            },
          }),
        ],
      }),
    ],
  ])('refuses an answer with %s as an unexpected answer', async (_what, answer) => {
    const failure = await listServers(transport(answer))().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ code: 'bad_response' })
  })
})

describe('one server', () => {
  it('maps the server and its containers, and asks for the id as it is', async () => {
    const t = transport(detail())
    const result = await getServer(t)(server.id)
    expect(t.get).toHaveBeenCalledWith(`servers/${server.id}/`, { signal: undefined })
    expect(result.item.server.name).toBe('ath-db-01')
    expect(result.containers).toEqual([
      expect.objectContaining({
        status: 'healthy',
        container: expect.objectContaining({
          name: 'pgbouncer',
          state: 'running',
          health: 'healthy',
        }),
      }),
    ])
  })

  it('encodes an id that is not a plain path segment', async () => {
    const t = transport(detail())
    await getServer(t)('a/b c')
    expect(t.get).toHaveBeenCalledWith('servers/a%2Fb%20c/', { signal: undefined })
  })

  it.each([
    [
      'an unknown container state',
      detail({
        containers: [{ ...container, container: { ...container.container, state: 'zombie' } }],
      }),
    ],
    [
      'an unknown container health',
      detail({
        containers: [{ ...container, container: { ...container.container, health: 'fine' } }],
      }),
    ],
    ['containers that are not a list', detail({ containers: 'none' })],
    ['no item', detail({ item: undefined })],
  ])('refuses an answer with %s', async (_what, answer) => {
    await expect(getServer(transport(answer))('x')).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('reports a server that does not exist as the server said it, a 404', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
          status: 404,
        }),
    )
    const real = createTransport({ fetchImpl })
    await expect(getServer(real)('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })
})

describe('history', () => {
  it('asks for the range and keeps the gaps as gaps', async () => {
    const t = transport(series())
    const result = await getServerSeries(t)({ serverId: server.id, range: '6h' })
    expect(t.get).toHaveBeenCalledWith(`servers/${server.id}/series/`, {
      signal: undefined,
      query: { range: '6h' },
    })
    expect(result.cpu).toEqual([10, null, 12.5])
    expect(result.memory).toEqual([50, 51, null])
    expect(result.t).toHaveLength(3)
  })

  it('accepts a host that never reported: empty arrays, nothing invented', async () => {
    const empty = series({ t: [], cpu: [], memory: [], disk: [] })
    const result = await getServerSeries(transport(empty))({ serverId: 'x', range: '1h' })
    expect(result).toMatchObject({ t: [], cpu: [], memory: [], disk: [] })
  })

  it.each([
    ['a metric shorter than the time axis', series({ cpu: [1, 2] })],
    ['a sample that is not a number', series({ cpu: [1, 'x', 3] })],
    ['a time that is not a number', series({ t: [1, 'x', 3] })],
    ['no bucket size', series({ bucketMs: undefined })],
  ])('refuses %s', async (_what, answer) => {
    await expect(
      getServerSeries(transport(answer))({ serverId: 'x', range: '1h' }),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('fleet load', () => {
  const row = (id: string, name: string, cpu: number, over: Record<string, unknown> = {}) =>
    item({
      server: {
        ...server,
        id,
        name,
        ...over,
        telemetry:
          over.telemetry === undefined ? { ...telemetry, cpuPercent: cpu } : over.telemetry,
      },
    })

  it('asks the list for the busiest by the metric, one page of the size wanted', async () => {
    const t = transport(list({ items: [row('a', 'a', 90)] }))
    await getFleetLoad(t)({ metric: 'memory', limit: 5, scope: { customerId: 'c1', siteId: null } })
    expect(t.get).toHaveBeenCalledWith('servers/', {
      signal: undefined,
      query: expect.objectContaining({
        sort: 'memory',
        dir: 'desc',
        page: '1',
        pageSize: '5',
        customer: 'c1',
      }),
    })
  })

  it('ranks the servers as the list ordered them and reads the percent of the metric', async () => {
    const t = transport(list({ items: [row('a', 'busy', 91), row('b', 'calm', 12)] }))
    const result = await getFleetLoad(t)({ metric: 'cpu' })
    expect(result.rows.map(({ name, percent }) => [name, percent])).toEqual([
      ['busy', 91],
      ['calm', 12],
    ])
    expect(result.excluded).toEqual([])
  })

  it('never ranks a stale reading, an offline host or a silent one: it names them as excluded', async () => {
    const t = transport(
      list({
        items: [
          row('a', 'fresh', 70),
          row('b', 'stale', 99, { telemetry: { ...telemetry, cpuPercent: 99, stale: true } }),
          row('c', 'gone', 95, { status: 'offline' }),
          row('d', 'new', 0, { status: 'unknown', telemetry: null }),
        ],
      }),
    )
    const result = await getFleetLoad(t)({ metric: 'cpu' })
    expect(result.rows.map((r) => r.name)).toEqual(['fresh'])
    expect(result.excluded).toEqual(['gone', 'new', 'stale'])
  })
})

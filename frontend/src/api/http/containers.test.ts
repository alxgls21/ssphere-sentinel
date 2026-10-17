import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { listContainers, parseContainerList } from './containers'
import type { Transport } from './transport'

/** The shape below is what apps/console serves for `containers/` (containers.py). */
const counts = { healthy: 2, warning: 1, critical: 1, unknown: 0, idle: 1 }
const row = (over: Record<string, unknown> = {}) => ({
  container: {
    id: 'srv-1:abc123',
    serverId: 'srv-1',
    name: 'pgbouncer',
    image: 'edoburu/pgbouncer:1.22',
    state: 'running',
    health: 'unhealthy',
    startedAt: '2026-10-16T08:00:00.000Z',
  },
  status: 'critical',
  serverName: 'ath-db-01',
  customerName: 'Meridian',
  siteName: 'Athens DC',
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items: [row()],
  page: { number: 1, size: 200, total: 5, pages: 1 },
  counts,
  scopeTotal: 5,
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get, post: vi.fn() } as unknown as Transport & { get: typeof get }
}

describe('containers list', () => {
  it('maps the answer onto the view-model: the container, its status, the host and the place', async () => {
    const result = await listContainers(transport(list()))()
    expect(result.items[0]).toMatchObject({
      container: { id: 'srv-1:abc123', serverId: 'srv-1', name: 'pgbouncer', state: 'running' },
      status: 'critical',
      serverName: 'ath-db-01',
      customerName: 'Meridian',
      siteName: 'Athens DC',
    })
    expect(result.page).toEqual({ number: 1, size: 200, total: 5, pages: 1 })
    expect(result.counts).toEqual(counts)
    expect(result.scopeTotal).toBe(5)
  })

  it('leaves the place out when the server sent none, instead of making one up', () => {
    const { customerName: _customer, siteName: _site, ...bare } = row()
    const [first] = parseContainerList(list({ items: [bare] })).items
    expect(first).not.toHaveProperty('customerName')
    expect(first).not.toHaveProperty('siteName')
  })

  it('trusts the status the server decided', () => {
    const [first] = parseContainerList(list({ items: [row({ status: 'healthy' })] })).items
    expect(first?.status).toBe('healthy')
  })

  it('sends only what differs from the defaults: scope, filter, sort, page', async () => {
    const t = transport(list())
    await listContainers(t)({
      scope: { customerId: 'c1', siteId: null },
      status: 'warning',
      sort: 'status',
      dir: 'desc',
      page: 1,
      pageSize: 200,
    })
    expect(t.get).toHaveBeenCalledWith('containers/', {
      signal: undefined,
      query: {
        customer: 'c1',
        site: undefined,
        server: undefined,
        q: undefined,
        status: 'warning',
        sort: 'status',
        dir: 'desc',
        page: '1',
        pageSize: '200',
      },
    })
    await listContainers(t)({ status: 'all' })
    expect(t.get).toHaveBeenLastCalledWith('containers/', {
      signal: undefined,
      query: expect.objectContaining({ status: undefined, page: undefined }),
    })
  })

  it('sends the search words and the one server, trimmed, only when there are some', async () => {
    const t = transport(list())
    await listContainers(t)({ q: '  pg   bouncer ', server: 'srv-1' })
    expect(t.get).toHaveBeenLastCalledWith('containers/', {
      signal: undefined,
      query: expect.objectContaining({ q: 'pg   bouncer', server: 'srv-1' }),
    })
    await listContainers(t)({ q: '   ', server: '' })
    expect(t.get).toHaveBeenLastCalledWith('containers/', {
      signal: undefined,
      query: expect.objectContaining({ q: undefined, server: undefined }),
    })
  })

  it('passes the abort signal on', async () => {
    const t = transport(list())
    const controller = new AbortController()
    await listContainers(t)({ signal: controller.signal })
    expect(t.get).toHaveBeenCalledWith(
      'containers/',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it.each([
    ['a missing item field', list({ items: [row({ serverName: undefined })] })],
    ['a container without a state', list({ items: [row({ container: {} })] })],
    ['counts that are not numbers', list({ counts: { ...counts, healthy: 'many' } })],
    ['no page', list({ page: undefined })],
    ['a scope total that is not a whole number', list({ scopeTotal: 1.5 })],
    ['something that is not an object', 'oops'],
  ])('refuses %s as a bad response, not a guess', (_name, answer) => {
    expect(() => parseContainerList(answer)).toThrow(ApiError)
    try {
      parseContainerList(answer)
    } catch (error) {
      expect(error).toMatchObject({ code: 'bad_response' })
    }
  })
})

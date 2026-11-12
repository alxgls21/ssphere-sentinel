import { describe, expect, it, vi } from 'vitest'
import {
  createCustomer,
  createSite,
  deleteCustomer,
  deleteSite,
  getCustomer,
  getSite,
  listCustomers,
  listSites,
  parseCustomerDetail,
  updateCustomer,
  updateSite,
} from './customers'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (customers.py). */
const customer = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Meridian',
  notes: 'first customer',
  sites: 2,
  servers: 5,
  devices: 1,
  targets: 3,
  domains: 0,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...over,
})
const site = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  customerId: 'c1',
  customerName: 'Meridian',
  name: 'Athens DC',
  description: '',
  servers: 5,
  devices: 1,
  targets: 3,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...over,
})
const list = (items: unknown[]) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  scopeTotal: 4,
})
const customerDetail = {
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: customer(),
  sites: [site()],
}
const siteDetail = { generatedAt: '2026-10-17T10:00:05.000Z', item: site() }
const deleted = { generatedAt: '2026-10-17T10:00:05.000Z', deleted: { id: 'c1', name: 'Meridian' } }

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  const patch = vi.fn(async () => answer)
  const del = vi.fn(async () => answer)
  return { get, post, patch, delete: del } as unknown as Transport & {
    get: typeof get
    post: typeof post
    patch: typeof patch
    delete: typeof del
  }
}

describe('customers', () => {
  it('lists them with the page and the scope total, sending only what differs from the defaults', async () => {
    const t = transport(list([customer()]))
    const result = await listCustomers(t)({ q: ' meri ', sort: 'created', dir: 'desc', page: 2 })
    expect(result.items[0]).toMatchObject({ id: 'c1', name: 'Meridian', sites: 2, domains: 0 })
    expect(result.page.total).toBe(1)
    expect(result.scopeTotal).toBe(4)
    expect(t.get).toHaveBeenCalledWith('customers/', {
      signal: undefined,
      query: { q: 'meri', sort: 'created', dir: 'desc', page: '2', pageSize: undefined },
    })
  })

  it('reads one with its sites, encoding the id', async () => {
    const t = transport(customerDetail)
    const result = await getCustomer(t)('a/b')
    expect(result.item.name).toBe('Meridian')
    expect(result.sites.map((entry) => entry.name)).toEqual(['Athens DC'])
    expect(t.get).toHaveBeenCalledWith('customers/a%2Fb/', { signal: undefined })
  })

  it('creates and changes one with the fields named, and nothing else', async () => {
    const t = transport(customerDetail)
    await createCustomer(t)({ name: 'Meridian', notes: 'n' })
    expect(t.post).toHaveBeenCalledWith(
      'customers/',
      { name: 'Meridian', notes: 'n' },
      { signal: undefined },
    )
    await updateCustomer(t)('c1', { notes: 'changed' })
    expect(t.patch).toHaveBeenCalledWith(
      'customers/c1/',
      { notes: 'changed' },
      { signal: undefined },
    )
    await updateCustomer(t)('c1', { ...({ id: 'other', sites: 9 } as object), name: 'M' })
    expect(t.patch).toHaveBeenLastCalledWith('customers/c1/', { name: 'M' }, { signal: undefined })
  })

  it('deletes one with no body and reads what was deleted', async () => {
    const t = transport(deleted)
    expect((await deleteCustomer(t)('c1')).deleted).toEqual({ id: 'c1', name: 'Meridian' })
    expect(t.delete).toHaveBeenCalledWith('customers/c1/', { signal: undefined })
  })

  it.each([
    ['a count missing', { ...customerDetail, item: customer({ sites: undefined }) }],
    ['a count that is not whole', { ...customerDetail, item: customer({ servers: 1.5 }) }],
    ['notes that are not text', { ...customerDetail, item: customer({ notes: null }) }],
    ['sites that are not a list', { ...customerDetail, sites: null }],
    [
      'a time that does not parse',
      { ...customerDetail, item: customer({ createdAt: 'yesterday' }) },
    ],
  ])('refuses an answer with %s', (_what, answer) => {
    expect(() => parseCustomerDetail(answer)).toThrow(/unexpected answer/)
  })
})

describe('sites', () => {
  it('lists them, of one customer when asked', async () => {
    const t = transport(list([site()]))
    const result = await listSites(t)({ customer: 'c1', q: 'ath' })
    expect(result.items[0]).toMatchObject({ id: 's1', customerName: 'Meridian', servers: 5 })
    expect(t.get).toHaveBeenCalledWith('sites/', {
      signal: undefined,
      query: {
        q: 'ath',
        sort: undefined,
        dir: undefined,
        page: undefined,
        pageSize: undefined,
        customer: 'c1',
      },
    })
  })

  it('reads, creates, moves and deletes one', async () => {
    const t = transport(siteDetail)
    expect((await getSite(t)('s1')).item.name).toBe('Athens DC')
    await createSite(t)({ customerId: 'c1', name: 'Athens DC', description: 'd' })
    expect(t.post).toHaveBeenCalledWith(
      'sites/',
      { customerId: 'c1', name: 'Athens DC', description: 'd' },
      { signal: undefined },
    )
    await updateSite(t)('s1', { customerId: 'c2' })
    expect(t.patch).toHaveBeenCalledWith('sites/s1/', { customerId: 'c2' }, { signal: undefined })
    const gone = transport({ ...deleted, deleted: { id: 's1', name: 'Athens DC' } })
    expect((await deleteSite(gone)('s1')).deleted.name).toBe('Athens DC')
    expect(gone.delete).toHaveBeenCalledWith('sites/s1/', { signal: undefined })
  })
})

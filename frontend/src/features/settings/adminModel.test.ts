import { describe, expect, it } from 'vitest'
import {
  agentChoices,
  customerChoices,
  customerHolds,
  nextRecordsSort,
  parseRecordsQuery,
  recordsRequest,
  siteChoices,
  siteHolds,
  wholeField,
  writeRecordsQuery,
} from './adminModel'

const scope = {
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [
    { id: 's1', customerId: 'c1', name: 'Athens DC' },
    { id: 's2', customerId: 'c9', name: 'Orphan' },
  ],
}

describe('the query of a list of records', () => {
  it('reads the search, the sort and the page from the URL, falling back to the defaults', () => {
    expect(parseRecordsQuery(new URLSearchParams(''))).toEqual({
      q: '',
      sort: 'name',
      dir: 'asc',
      page: 1,
    })
    expect(parseRecordsQuery(new URLSearchParams('q=me&sort=created&page=3'))).toEqual({
      q: 'me',
      sort: 'created',
      dir: 'desc',
      page: 3,
    })
    expect(parseRecordsQuery(new URLSearchParams('sort=size&dir=up&page=x'))).toEqual({
      q: '',
      sort: 'name',
      dir: 'asc',
      page: 1,
    })
  })

  it('writes only what differs from the defaults, and keeps the other parameters', () => {
    const written = writeRecordsQuery(new URLSearchParams('customer=acme'), {
      q: 'me ',
      sort: 'created',
      dir: 'desc',
      page: 2,
    })
    expect(Object.fromEntries(written)).toEqual({
      customer: 'acme',
      q: 'me ',
      sort: 'created',
      page: '2',
    })
    expect(
      writeRecordsQuery(new URLSearchParams('q=x&page=4'), {
        q: '',
        sort: 'name',
        dir: 'asc',
        page: 1,
      }).toString(),
    ).toBe('')
  })

  it('flips the direction of the current column and starts a new one in its own', () => {
    const query = { q: '', sort: 'name' as const, dir: 'asc' as const, page: 1 }
    expect(nextRecordsSort(query, 'name')).toEqual({ sort: 'name', dir: 'desc' })
    expect(nextRecordsSort(query, 'created')).toEqual({ sort: 'created', dir: 'desc' })
  })

  it('asks the API for the page with the settled search', () => {
    expect(recordsRequest({ q: 'typed', sort: 'name', dir: 'asc', page: 2 }, 'settled')).toEqual({
      q: 'settled',
      sort: 'name',
      dir: 'asc',
      page: 2,
      pageSize: 50,
    })
  })
})

describe('the choices of a form', () => {
  it('names each site with its customer, an unknown customer said so', () => {
    expect(siteChoices(scope, 'No site')).toEqual([
      { value: '', label: 'No site' },
      { value: 's1', label: 'Meridian / Athens DC' },
      { value: 's2', label: 'Unknown customer / Orphan' },
    ])
    expect(customerChoices(scope)).toEqual([
      { value: '', label: 'Choose a customer' },
      { value: 'c1', label: 'Meridian' },
    ])
  })

  it('names each agent by its server and says when it is disabled or not reporting', () => {
    const agent = (over: object) => ({
      id: 'a1',
      name: 'probe',
      enabled: true,
      status: 'online' as const,
      lastSeenAt: null,
      serverId: 's1',
      serverName: 'host-1',
      ...over,
    })
    expect(
      agentChoices([agent({}), agent({ id: 'a2', enabled: false, status: 'offline' })]),
    ).toEqual([
      { value: '', label: 'No agent (nothing measures it)' },
      { value: 'a1', label: 'host-1 (probe)' },
      { value: 'a2', label: 'host-1 (probe, disabled, offline)' },
    ])
  })
})

describe('what is typed and what still belongs', () => {
  it('reads a whole number within its bounds and refuses anything else', () => {
    expect(wholeField(' 60 ', 10, 86400)).toEqual({ value: 60 })
    for (const bad of ['', '9', '86401', '6e1', '-5', '1.5', 'sixty']) {
      expect(wholeField(bad, 10, 86400).error).toBe('Expected a whole number from 10 to 86400.')
    }
  })

  it('says what a customer or a site still holds', () => {
    const customer = {
      id: 'c1',
      name: 'M',
      notes: '',
      sites: 2,
      servers: 3,
      devices: 0,
      targets: 0,
      domains: 1,
      createdAt: '',
      updatedAt: '',
    }
    expect(customerHolds(customer)).toBe('2 sites, 1 monitored domain')
    expect(customerHolds({ ...customer, sites: 0, domains: 0 })).toBe('')
    const site = {
      id: 's1',
      customerId: 'c1',
      customerName: 'M',
      name: 'HQ',
      description: '',
      servers: 1,
      devices: 0,
      targets: 3,
      createdAt: '',
      updatedAt: '',
    }
    expect(siteHolds(site)).toBe('1 server, 3 network targets')
    expect(siteHolds({ ...site, servers: 0, targets: 0 })).toBe('')
  })
})

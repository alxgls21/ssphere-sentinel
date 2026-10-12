import { describe, expect, it } from 'vitest'
import { ALL_SCOPE } from '@/api/types'
import { SCOPE_OPTIONS } from '../testing'
import { ALL, buildScopeChoices, scopeSegments, scopeWithCustomer, scopeWithSite } from './scope'

describe('buildScopeChoices', () => {
  it('offers all customers and, with no customer chosen, every site named with its customer', () => {
    const { customers, sites } = buildScopeChoices(SCOPE_OPTIONS, ALL_SCOPE)
    expect(customers.map((c) => c.label)).toEqual(['All customers', 'Acme', 'Globex'])
    expect(sites.map((s) => s.label)).toEqual([
      'All sites',
      'Acme / Athens DC',
      'Acme / Patras',
      'Globex / Thess-1',
    ])
  })

  it('narrows the sites to the chosen customer', () => {
    const { sites } = buildScopeChoices(SCOPE_OPTIONS, { customerId: 'globex', siteId: null })
    expect(sites.map((s) => s.label)).toEqual(['All sites', 'Thess-1'])
  })

  it('keeps an id from the URL selectable before the options have loaded', () => {
    const { customers, sites } = buildScopeChoices(undefined, {
      customerId: 'acme',
      siteId: 'athens',
    })
    expect(customers.map((c) => c.value)).toEqual([ALL, 'acme'])
    expect(sites.map((s) => s.value)).toEqual([ALL, 'athens'])
  })
})

describe('scopeWithCustomer', () => {
  it('chooses the customer and keeps a site that belongs to it', () => {
    expect(
      scopeWithCustomer(SCOPE_OPTIONS, { customerId: null, siteId: 'athens' }, 'acme'),
    ).toEqual({
      customerId: 'acme',
      siteId: 'athens',
    })
  })

  it('drops a site that belongs to another customer', () => {
    expect(
      scopeWithCustomer(SCOPE_OPTIONS, { customerId: 'acme', siteId: 'athens' }, 'globex'),
    ).toEqual({
      customerId: 'globex',
      siteId: null,
    })
  })

  it('clears everything for all customers', () => {
    expect(scopeWithCustomer(SCOPE_OPTIONS, { customerId: 'acme', siteId: 'athens' }, ALL)).toEqual(
      ALL_SCOPE,
    )
  })
})

describe('scopeWithSite', () => {
  it('chooses the site’s customer too, so the pair cannot disagree', () => {
    expect(scopeWithSite(SCOPE_OPTIONS, ALL_SCOPE, 'thess')).toEqual({
      customerId: 'globex',
      siteId: 'thess',
    })
  })

  it('keeps the customer when the site is cleared', () => {
    expect(scopeWithSite(SCOPE_OPTIONS, { customerId: 'acme', siteId: 'athens' }, ALL)).toEqual({
      customerId: 'acme',
      siteId: null,
    })
  })
})

describe('scopeSegments', () => {
  it('names the chosen customer and site for the breadcrumb', () => {
    expect(scopeSegments(SCOPE_OPTIONS, { customerId: 'acme', siteId: 'athens' })).toEqual([
      'acme',
      'athens-dc',
    ])
    expect(scopeSegments(SCOPE_OPTIONS, { customerId: 'globex', siteId: null })).toEqual(['globex'])
    expect(scopeSegments(SCOPE_OPTIONS, ALL_SCOPE)).toEqual([])
  })

  it('says nothing about ids it cannot name yet', () => {
    expect(scopeSegments(undefined, { customerId: 'acme', siteId: null })).toEqual([])
  })
})

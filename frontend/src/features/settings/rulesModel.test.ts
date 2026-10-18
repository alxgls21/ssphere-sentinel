import { describe, expect, it } from 'vitest'
import { rule } from './testing'
import {
  conditionOf,
  DEFAULT_QUERY,
  isDefaultView,
  nextSort,
  parseQuery,
  requestOf,
  RULES_PAGE_SIZE,
  scopeText,
  timingOf,
  writeQuery,
} from './rulesModel'

const params = (text: string) => new URLSearchParams(text)

describe('the list query in the URL', () => {
  it('is the default for an empty URL', () => {
    expect(parseQuery(params(''))).toEqual(DEFAULT_QUERY)
  })

  it('reads every part of a link someone shared', () => {
    expect(
      parseQuery(
        params(
          'q=core&enabled=disabled&kind=device&severity=warning&scope=site&sort=updated&dir=asc&page=3',
        ),
      ),
    ).toEqual({
      q: 'core',
      enabled: 'disabled',
      kind: 'device',
      severity: 'warning',
      scope: 'site',
      sort: 'updated',
      dir: 'asc',
      page: 3,
    })
  })

  it.each([
    ['enabled=maybe'],
    ['kind=router'],
    ['severity=info'],
    ['scope=planet'],
    ['sort=price'],
    ['dir=sideways'],
    ['page=0'],
    ['page=-2'],
    ['page=abc'],
    ['page=99999'],
  ])('falls back to the default for a value no one should send: %s', (text) => {
    expect(parseQuery(params(text))).toEqual(DEFAULT_QUERY)
  })

  it('takes the first direction of a sort when none is given: the newest updated first', () => {
    expect(parseQuery(params('sort=updated')).dir).toBe('desc')
    expect(parseQuery(params('sort=name')).dir).toBe('asc')
  })

  it('writes only what differs from the defaults, and keeps other parameters', () => {
    const next = writeQuery(params('keep=1&q=old'), {
      ...DEFAULT_QUERY,
      q: ' core ',
      enabled: 'enabled',
      page: 2,
    })
    expect(Object.fromEntries(next)).toEqual({
      keep: '1',
      q: 'core',
      enabled: 'enabled',
      page: '2',
    })
    expect(writeQuery(next, DEFAULT_QUERY).toString()).toBe('keep=1')
  })

  it('writes a direction only when it is not the sort’s first', () => {
    expect(
      writeQuery(params(''), { ...DEFAULT_QUERY, sort: 'updated', dir: 'desc' }).toString(),
    ).toBe('sort=updated')
    expect(
      writeQuery(params(''), { ...DEFAULT_QUERY, sort: 'updated', dir: 'asc' }).toString(),
    ).toBe('sort=updated&dir=asc')
  })

  it('round-trips what it writes', () => {
    const query = {
      ...DEFAULT_QUERY,
      q: 'a b',
      kind: 'server',
      severity: 'critical',
      page: 4,
    } as const
    expect(parseQuery(writeQuery(params(''), query))).toEqual(query)
  })
})

describe('sorting and the default view', () => {
  it('turns a sorted column around, and starts another at its own first direction', () => {
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: 'desc' })
    expect(nextSort(DEFAULT_QUERY, 'updated')).toEqual({ sort: 'updated', dir: 'desc' })
    expect(nextSort(DEFAULT_QUERY, 'severity')).toEqual({ sort: 'severity', dir: 'asc' })
  })

  it('is the default view until a search or a filter is set; a sort or a page is not a filter', () => {
    expect(isDefaultView(DEFAULT_QUERY)).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, sort: 'kind', page: 3 })).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: 'x' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: '   ' })).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, enabled: 'disabled' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, scope: 'global' })).toBe(false)
  })

  it('asks the API for the query, the debounced search and a page of fifty', () => {
    expect(requestOf({ ...DEFAULT_QUERY, q: 'typed', page: 2 }, 'settled')).toEqual({
      q: 'settled',
      enabled: 'all',
      kind: 'all',
      severity: 'all',
      scope: 'all',
      sort: 'name',
      dir: 'asc',
      page: 2,
      pageSize: RULES_PAGE_SIZE,
    })
    expect(RULES_PAGE_SIZE).toBe(50)
  })
})

describe('a rule in words', () => {
  it('names who a scope concerns', () => {
    expect(scopeText(rule().scope)).toBe('All customers and sites')
    expect(
      scopeText({
        type: 'customer',
        customerId: 'c',
        customerName: 'Meridian',
        siteId: null,
        siteName: null,
      }),
    ).toBe('Meridian')
    expect(
      scopeText({
        type: 'site',
        customerId: 'c',
        customerName: 'Meridian',
        siteId: 's',
        siteName: 'Athens DC',
      }),
    ).toBe('Meridian / Athens DC')
  })

  it('says what a scope is when the names are missing, rather than nothing', () => {
    expect(
      scopeText({
        type: 'customer',
        customerId: 'c',
        customerName: null,
        siteId: null,
        siteName: null,
      }),
    ).toBe('One customer')
    expect(
      scopeText({
        type: 'site',
        customerId: null,
        customerName: null,
        siteId: 's',
        siteName: null,
      }),
    ).toBe('One site')
  })

  it('says the condition and the reason it is narrowed to', () => {
    expect(conditionOf(rule())).toBe('Critical · no response to polls')
    expect(conditionOf(rule({ reason: null }))).toBe('Critical')
    expect(conditionOf(rule({ health: 'warning', reason: null }))).toBe('Warning or critical')
  })

  it('says how long a condition holds to open, and stays clear to recover', () => {
    expect(timingOf(rule())).toBe('1m 0s → 2m 0s')
    expect(timingOf(rule({ activationSeconds: 0, recoverySeconds: 3600 }))).toBe('0s → 1h 0m')
  })
})

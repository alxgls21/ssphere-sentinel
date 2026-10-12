import { describe, expect, it } from 'vitest'
import type { DomainBreakdown, HealthStatus, SiteBreakdown } from '@/api/types'
import { emptyCounts } from '@/lib/status'
import {
  MAX_STRIP_CAPACITY,
  capacityFor,
  isHealthEmpty,
  isUncounted,
  rankedSites,
  siteTarget,
  siteLabel,
} from './healthModel'

const site = (
  siteId: string,
  statuses: HealthStatus[],
  names: [customer: string, site: string] = ['Acme', siteId],
): SiteBreakdown => ({
  siteId,
  customerName: names[0],
  siteName: names[1],
  entities: statuses.map((status, index) => ({
    id: `${siteId}-${index}`,
    kind: 'server',
    name: `${siteId}-${index}`,
    status,
  })),
})

const domain = (
  id: DomainBreakdown['domain'],
  counts: Partial<Record<HealthStatus, number>>,
  planned = false,
): DomainBreakdown => ({
  domain: id,
  label: id.toUpperCase(),
  counts: { ...emptyCounts(), ...counts },
  planned,
})

describe('rankedSites', () => {
  it('puts the site with the most critical entities first, then warnings, then unknown', () => {
    const sites = [
      site('ok', ['healthy', 'healthy']),
      site('warn', ['warning', 'healthy']),
      site('crit-1', ['critical', 'healthy']),
      site('unkn', ['unknown', 'healthy']),
      site('crit-2', ['critical', 'critical']),
      site('crit-1-warn', ['critical', 'warning']),
    ]
    expect(rankedSites(sites).map((s) => s.siteId)).toEqual([
      'crit-2',
      'crit-1-warn',
      'crit-1',
      'warn',
      'unkn',
      'ok',
    ])
  })

  it('breaks a tie by customer and site name', () => {
    const sites = [
      site('b', ['warning'], ['Globex', 'Thess-1']),
      site('a', ['warning'], ['Acme', 'Patras']),
      site('c', ['warning'], ['Acme', 'Athens-DC']),
    ]
    expect(rankedSites(sites).map((s) => s.siteId)).toEqual(['c', 'a', 'b'])
  })

  it('drops a site with nothing in it and leaves the input alone', () => {
    const sites = [site('empty', []), site('crit', ['critical'])]
    const copy = [...sites]
    expect(rankedSites(sites).map((s) => s.siteId)).toEqual(['crit'])
    expect(sites).toEqual(copy)
  })
})

describe('site helpers', () => {
  it('labels a site "customer / site"', () => {
    expect(siteLabel({ customerName: 'Acme', siteName: 'Athens-DC' })).toBe('Acme / Athens-DC')
  })

  it('links to Customers & Sites filtered to the site, escaping the id', () => {
    expect(siteTarget('site-1')).toEqual({ pathname: '/customers', extra: { site: 'site-1' } })
  })
})

describe('isHealthEmpty', () => {
  it('is true when no real domain counts anything', () => {
    expect(isHealthEmpty([domain('servers', {}), domain('containers', {})])).toBe(true)
  })

  it('ignores the planned SNMP row, which only holds inventory', () => {
    expect(isHealthEmpty([domain('servers', {}), domain('snmp', { unknown: 12 }, true)])).toBe(true)
  })

  it('is false as soon as anything is counted, idle included', () => {
    expect(isHealthEmpty([domain('servers', {}), domain('containers', { idle: 1 })])).toBe(false)
  })
})

describe('isUncounted', () => {
  it('tells a zero total from a populated one', () => {
    expect(isUncounted(emptyCounts())).toBe(true)
    expect(isUncounted({ ...emptyCounts(), idle: 1 })).toBe(false)
  })
})

describe('capacityFor', () => {
  it('fits cells on a 12px pitch with a trailing 2px gap', () => {
    expect(capacityFor(238)).toBe(20)
    expect(capacityFor(237)).toBe(19)
    expect(capacityFor(215)).toBe(18)
    expect(capacityFor(100)).toBe(8)
  })

  it('never exceeds the design maximum and never goes negative', () => {
    expect(capacityFor(2000)).toBe(MAX_STRIP_CAPACITY)
    expect(capacityFor(0)).toBe(0)
    expect(capacityFor(-5)).toBe(0)
  })
})

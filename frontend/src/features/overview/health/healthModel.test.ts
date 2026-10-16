import { describe, expect, it } from 'vitest'
import type { DomainBreakdown, HealthStatus, SiteBreakdown } from '@/api/types'
import { emptyCounts } from '@/lib/status'
import {
  MAX_STRIP_CAPACITY,
  capacityFor,
  domainShares,
  isHealthEmpty,
  isUncounted,
  legendStates,
  rankedSites,
  shareText,
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

  it('ranks an offline-flagged entity as critical: it never moves a site', () => {
    const flagged = (siteId: string, offline: boolean): SiteBreakdown => ({
      siteId,
      customerName: 'Acme',
      siteName: siteId,
      entities: [
        {
          id: `${siteId}-0`,
          kind: 'server',
          name: 'a',
          status: 'critical',
          ...(offline ? { offline } : {}),
        },
        { id: `${siteId}-1`, kind: 'server', name: 'b', status: 'healthy' },
      ],
    })
    // Equal on every count that ranks, so the name decides, whether or not a server is offline.
    expect(rankedSites([flagged('b', false), flagged('a', true)]).map((s) => s.siteId)).toEqual([
      'a',
      'b',
    ])
    expect(rankedSites([flagged('a', false), flagged('b', true)]).map((s) => s.siteId)).toEqual([
      'a',
      'b',
    ])
    expect(
      rankedSites([site('warn', ['warning', 'warning']), flagged('off', true)]).map(
        (s) => s.siteId,
      ),
    ).toEqual(['off', 'warn'])
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
    expect(isUncounted({ ...emptyCounts(), critical: 1, offline: 1 })).toBe(false)
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

describe('shareText', () => {
  it('rounds to whole percent', () => {
    expect(shareText(13, 16)).toBe('81%')
    expect(shareText(1, 16)).toBe('6%')
    expect(shareText(2, 3)).toBe('67%')
    expect(shareText(1, 2)).toBe('50%')
  })

  it('never reads 0% for a state that has members', () => {
    expect(shareText(1, 124)).toBe('1%')
    expect(shareText(1, 1000)).toBe('<1%')
    expect(shareText(1, 100_000)).toBe('<1%')
  })

  it('reads 100% only for the whole total', () => {
    expect(shareText(16, 16)).toBe('100%')
    expect(shareText(1, 1)).toBe('100%')
    expect(shareText(999, 1000)).toBe('>99%')
    expect(shareText(399, 400)).toBe('>99%')
    expect(shareText(123, 124)).toBe('99%')
  })

  it('has nothing to share out of an empty total', () => {
    expect(shareText(0, 0)).toBe('0%')
    expect(shareText(0, 16)).toBe('0%')
  })
})

describe('domainShares', () => {
  it('lists every state that has members, worst first, with the total they share', () => {
    const { total, rows } = domainShares({
      ...emptyCounts(),
      critical: 2,
      warning: 1,
      idle: 3,
      healthy: 62,
    })
    expect(total).toBe(68)
    expect(rows.map(({ status, count, share }) => [status, count, share])).toEqual([
      ['critical', 2, '3%'],
      ['warning', 1, '1%'],
      ['idle', 3, '4%'],
      ['healthy', 62, '91%'],
    ])
  })

  it('lists offline apart from the critical it is part of, and counts each server once', () => {
    const { total, rows } = domainShares({ ...emptyCounts(), critical: 3, offline: 2, healthy: 13 })
    expect(total).toBe(16)
    expect(rows.map(({ status, count }) => [status, count])).toEqual([
      ['critical', 1],
      ['offline', 2],
      ['healthy', 13],
    ])
  })

  it('is empty for a domain with nothing counted', () => {
    expect(domainShares(emptyCounts())).toEqual({ total: 0, rows: [] })
  })
})

describe('legendStates', () => {
  const entity = (status: HealthStatus, offline = false): SiteBreakdown['entities'][number] => ({
    id: `${status}-${offline}`,
    kind: 'server',
    name: 'srv',
    status,
    offline,
  })
  const placed = (...entities: SiteBreakdown['entities']): SiteBreakdown => ({
    siteId: 's',
    customerName: 'Acme',
    siteName: 'Athens',
    entities,
  })

  it('always explains OK, WARN and CRIT, even for an estate with nothing wrong', () => {
    expect(legendStates([domain('servers', { healthy: 4 })], [])).toEqual([
      'healthy',
      'warning',
      'critical',
    ])
    expect(legendStates([], [])).toEqual(['healthy', 'warning', 'critical'])
  })

  it('adds a state once a domain row draws it, in the order of the legend', () => {
    const offline: DomainBreakdown = {
      domain: 'targets',
      label: 'TARGETS',
      counts: { ...emptyCounts(), critical: 1, offline: 1 },
    }
    const domains = [
      domain('servers', { healthy: 4, idle: 1 }),
      domain('containers', { unknown: 2 }),
      offline,
    ]
    expect(legendStates(domains, [])).toEqual([
      'healthy',
      'warning',
      'critical',
      'offline',
      'unknown',
      'idle',
    ])
  })

  it('adds a state a listed site draws in its strip, offline included', () => {
    expect(legendStates([], [placed(entity('critical', true), entity('healthy'))])).toEqual([
      'healthy',
      'warning',
      'critical',
      'offline',
    ])
    expect(legendStates([], [placed(entity('unknown'))])).toContain('unknown')
  })

  it('ignores the planned row: it draws no state marks', () => {
    expect(legendStates([domain('snmp', { unknown: 12, idle: 2 }, true)], [])).toEqual([
      'healthy',
      'warning',
      'critical',
    ])
  })
})

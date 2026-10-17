import { describe, expect, it } from 'vitest'
import { makeSummary } from './testing'
import { navBadge } from './navBadge'

describe('navBadge', () => {
  it('shows the worst non-OK state of the screen’s own domain, with its count', () => {
    const summary = makeSummary({
      servers: { critical: 1, warning: 2 },
      containers: { warning: 3 },
    })
    expect(navBadge('servers', summary)).toEqual({
      status: 'critical',
      count: 1,
      label: '1 critical',
    })
    expect(navBadge('docker', summary)).toEqual({ status: 'warning', count: 3, label: '3 warning' })
  })

  it('shows nothing when the domain is healthy (idle does not count)', () => {
    const summary = makeSummary({ containers: { idle: 5 } })
    expect(navBadge('servers', summary)).toBeNull()
    expect(navBadge('docker', summary)).toBeNull()
  })

  it('never counts screens whose backend does not collect anything', () => {
    const summary = makeSummary({ servers: { critical: 4 } })
    for (const id of ['network', 'snmp', 'topology', 'alerts', 'overview', 'customers'] as const) {
      expect(navBadge(id, summary), id).toBeNull()
    }
  })

  it('shows nothing before the summary has loaded', () => {
    expect(navBadge('servers', undefined)).toBeNull()
  })
})

describe('navBadge and freshness', () => {
  const summary = makeSummary({ servers: { critical: 1 }, containers: { warning: 2 } })

  it('speaks stale counts as stale', () => {
    expect(navBadge('servers', summary, 'stale')).toMatchObject({
      count: 1,
      label: '1 critical, stale',
    })
  })

  it('shows the unknown ring instead of an old count when there is no data', () => {
    // A missing badge would read as "nothing wrong": a dead dashboard must not look healthy.
    expect(navBadge('docker', summary, 'nodata')).toEqual({
      status: 'unknown',
      count: null,
      label: 'no data',
    })
    expect(navBadge('servers', undefined, 'nodata')).toMatchObject({ status: 'unknown' })
  })

  it('never invents a badge for a screen the backend cannot feed', () => {
    expect(navBadge('snmp', summary, 'nodata')).toBeNull()
    expect(navBadge('alerts', summary, 'nodata')).toBeNull()
  })
})

describe('navBadge with an offline server', () => {
  it('counts it as critical, exactly as without the flag', () => {
    const flagged = makeSummary({ servers: { critical: 2, warning: 1, offline: 1 } })
    const plain = makeSummary({ servers: { critical: 2, warning: 1 } })
    expect(navBadge('servers', flagged)).toEqual({
      status: 'critical',
      count: 2,
      label: '2 critical',
    })
    expect(navBadge('servers', flagged)).toEqual(navBadge('servers', plain))
  })

  it('shows a lone offline server as one critical, not as a state of its own', () => {
    const summary = makeSummary({ servers: { critical: 1, offline: 1 } })
    expect(navBadge('servers', summary)).toEqual({
      status: 'critical',
      count: 1,
      label: '1 critical',
    })
  })
})

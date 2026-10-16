import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from '@/config/nav'
import { counts } from './testing'
import { describeDomain, listedCounts, navPath, PROBLEM_STATUSES } from './tileText'

describe('navPath', () => {
  it('follows the navigation registry', () => {
    expect(navPath('servers')).toBe('/servers')
    expect(navPath('docker')).toBe('/docker')
    expect(navPath('network')).toBe('/network')
    for (const item of NAV_ITEMS) expect(navPath(item.id)).toBe(item.path)
  })
})

describe('describeDomain', () => {
  it('reads value of total, then problems worst first', () => {
    expect(
      describeDomain(
        { value: 15, total: 16, counts: counts({ healthy: 13, warning: 2, critical: 1 }) },
        'online',
      ),
    ).toBe('15 of 16 online, 1 critical, 2 warning')
  })

  it('names idle after the problems, and leaves out ok', () => {
    expect(
      describeDomain(
        { value: 65, total: 68, counts: counts({ healthy: 62, warning: 1, critical: 2, idle: 3 }) },
        'running',
      ),
    ).toBe('65 of 68 running, 2 critical, 1 warning, 3 idle')
  })

  it('is just the figures when nothing is wrong', () => {
    expect(describeDomain({ value: 40, total: 40, counts: counts({ healthy: 40 }) }, 'up')).toBe(
      '40 of 40 up',
    )
  })

  it('separates thousands', () => {
    expect(
      describeDomain({ value: 1200, total: 1500, counts: counts({ healthy: 1200 }) }, 'up'),
    ).toBe('1,200 of 1,500 up')
  })
})

describe('describeDomain with offline servers', () => {
  it('names offline apart from the critical it is part of', () => {
    expect(
      describeDomain(
        {
          value: 14,
          total: 16,
          counts: counts({ healthy: 11, warning: 3, critical: 2, unknown: 1, offline: 1 }),
        },
        'online',
      ),
    ).toBe('14 of 16 online, 1 critical, 1 offline, 3 warning, 1 unknown')
  })

  it('says just "offline" when it is the only critical state', () => {
    expect(
      describeDomain(
        { value: 15, total: 16, counts: counts({ healthy: 15, critical: 1, offline: 1 }) },
        'online',
      ),
    ).toBe('15 of 16 online, 1 offline')
  })
})

describe('listedCounts', () => {
  const fleet = counts({ healthy: 11, warning: 3, critical: 3, unknown: 1, idle: 2, offline: 2 })

  it('lists the marks of the statuses asked for, worst first, offline apart from critical', () => {
    expect(listedCounts(fleet, PROBLEM_STATUSES)).toEqual([
      { status: 'critical', count: 1 },
      { status: 'offline', count: 2 },
      { status: 'warning', count: 3 },
      { status: 'unknown', count: 1 },
    ])
  })

  it('leaves offline out when critical is not asked for', () => {
    expect(listedCounts(fleet, ['warning', 'healthy'])).toEqual([
      { status: 'warning', count: 3 },
      { status: 'healthy', count: 11 },
    ])
  })
})

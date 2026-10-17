import { describe, expect, it } from 'vitest'
import type { ContainerListItem, HealthStatus } from '@/api/types'
import { matchesSearch, queryContainers, sortContainers } from './containerList'

const NOW = '2026-10-17T10:00:00.000Z'

const item = (
  name: string,
  status: HealthStatus,
  host: string,
  over: Partial<ContainerListItem['container']> = {},
  place: Partial<ContainerListItem> = {},
): ContainerListItem => ({
  container: {
    id: `srv-${host}:${name}0123`,
    serverId: `srv-${host}`,
    name,
    image: `registry.example/${name}:1`,
    state: 'running',
    health: 'none',
    startedAt: '2026-10-16T08:00:00.000Z',
    ...over,
  },
  status,
  serverName: host,
  customerName: 'Meridian',
  siteName: 'Athens DC',
  ...place,
})

const FLEET = [
  item('nginx', 'healthy', 'web-01'),
  item('pgbouncer', 'critical', 'db-01', { health: 'unhealthy' }),
  item('worker', 'warning', 'web-01', { state: 'restarting' }),
  item('certbot', 'idle', 'web-01', { state: 'exited', startedAt: null }),
  item(
    'redis',
    'unknown',
    'pir-01',
    { state: 'unknown', health: 'unknown' },
    { siteName: 'Piraeus' },
  ),
  item('cache', 'healthy', 'db-01', { startedAt: '2026-10-10T08:00:00.000Z' }),
]
const names = (items: readonly ContainerListItem[]) => items.map((entry) => entry.container.name)

describe('matchesSearch', () => {
  it('needs every word, anywhere: name, image, Docker id, host, site or customer', () => {
    expect(matchesSearch(FLEET[1]!, 'pgbouncer db-01')).toBe(true)
    expect(matchesSearch(FLEET[1]!, 'registry.example athens')).toBe(true)
    expect(matchesSearch(FLEET[1]!, 'MERIDIAN')).toBe(true)
    expect(matchesSearch(FLEET[1]!, 'pgbouncer0123')).toBe(true)
    expect(matchesSearch(FLEET[1]!, 'pgbouncer web-01')).toBe(false)
    expect(matchesSearch(FLEET[1]!, '   ')).toBe(true)
  })
})

describe('sortContainers', () => {
  it('puts the worst first for status, desc, with ties by name', () => {
    expect(names(sortContainers(FLEET, { sort: 'status', dir: 'desc' }))).toEqual([
      'pgbouncer',
      'worker',
      'redis',
      'certbot',
      'cache',
      'nginx',
    ])
    expect(names(sortContainers(FLEET, { sort: 'status', dir: 'asc' })).at(-1)).toBe('pgbouncer')
  })

  it('sorts by name and by host, ties by name', () => {
    expect(names(sortContainers(FLEET, { sort: 'name', dir: 'asc' }))[0]).toBe('cache')
    expect(names(sortContainers(FLEET, { sort: 'name', dir: 'desc' }))[0]).toBe('worker')
    expect(names(sortContainers(FLEET, { sort: 'server', dir: 'asc' }))).toEqual([
      'cache',
      'pgbouncer',
      'redis',
      'certbot',
      'nginx',
      'worker',
    ])
  })

  it('sorts by start with the never-started last in either direction', () => {
    const newest = names(sortContainers(FLEET, { sort: 'started', dir: 'desc' }))
    expect(newest.at(-1)).toBe('certbot')
    expect(newest.at(-2)).toBe('cache')
    expect(names(sortContainers(FLEET, { sort: 'started', dir: 'asc' }))[0]).toBe('cache')
    expect(names(sortContainers(FLEET, { sort: 'started', dir: 'asc' })).at(-1)).toBe('certbot')
  })

  it('does not change the list it was given', () => {
    const before = names(FLEET)
    sortContainers(FLEET, { sort: 'name', dir: 'desc' })
    expect(names(FLEET)).toEqual(before)
  })
})

describe('queryContainers', () => {
  it('answers the default query: worst first, one page, counts and totals of the whole scope', () => {
    const list = queryContainers(FLEET, NOW)
    expect(names(list.items)[0]).toBe('pgbouncer')
    expect(list.page).toEqual({ number: 1, size: 50, total: 6, pages: 1 })
    expect(list.counts).toEqual({ healthy: 2, warning: 1, critical: 1, unknown: 1, idle: 1 })
    expect(list.scopeTotal).toBe(6)
    expect(list.generatedAt).toBe(NOW)
  })

  it('filters by status but counts by status over the search, so a chip says what it would show', () => {
    const list = queryContainers(FLEET, NOW, { status: 'healthy', q: 'web-01' })
    expect(names(list.items)).toEqual(['nginx'])
    expect(list.page.total).toBe(1)
    expect(list.counts).toEqual({ healthy: 1, warning: 1, critical: 0, unknown: 0, idle: 1 })
    expect(list.scopeTotal).toBe(6)
  })

  it('limits to one server, and scopeTotal is that server’s containers', () => {
    const list = queryContainers(FLEET, NOW, { server: 'srv-db-01' })
    expect(names(list.items).sort()).toEqual(['cache', 'pgbouncer'])
    expect(list.scopeTotal).toBe(2)
    expect(queryContainers(FLEET, NOW, { server: 'nobody' }).items).toEqual([])
  })

  it('pages, with at most 200 a page, and a page past the end is empty yet counts the pages', () => {
    const many = Array.from({ length: 205 }, (_, n) =>
      item(`c${String(n).padStart(3, '0')}`, 'healthy', 'h'),
    )
    const first = queryContainers(many, NOW, { pageSize: 500 })
    expect(first.items).toHaveLength(200)
    expect(first.page).toEqual({ number: 1, size: 200, total: 205, pages: 2 })
    const second = queryContainers(many, NOW, { pageSize: 200, page: 2 })
    expect(second.items).toHaveLength(5)
    const past = queryContainers(many, NOW, { pageSize: 200, page: 9 })
    expect(past.items).toEqual([])
    expect(past.page.pages).toBe(2)
  })

  it('answers an empty inventory with zero counts and one empty page', () => {
    const list = queryContainers([], NOW)
    expect(list.items).toEqual([])
    expect(list.scopeTotal).toBe(0)
    expect(list.page).toEqual({ number: 1, size: 50, total: 0, pages: 1 })
    expect(list.counts).toEqual({ healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 })
  })
})

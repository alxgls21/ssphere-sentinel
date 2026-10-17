import { describe, expect, it } from 'vitest'
import type { HealthStatus, ServerListItem, ServerStatus, ServerTelemetry } from '@/api/types'
import { queryServers, readingOf, reportsLoad, loadOf, uptimeOf } from './serverList'

const telemetry = (over: Partial<ServerTelemetry> = {}): ServerTelemetry => ({
  cpuPercent: 40,
  memoryPercent: 50,
  diskPercent: 60,
  memoryTotalBytes: 1,
  diskTotalBytes: 1,
  uptimeSeconds: 3600,
  collectedAt: '2026-10-17T10:00:00Z',
  ...over,
})

function item(
  name: string,
  over: {
    status?: ServerStatus
    health?: HealthStatus
    telemetry?: ServerTelemetry | null
    site?: string
  } = {},
): ServerListItem {
  return {
    server: {
      id: name,
      name,
      hostname: `${name}.example.net`,
      ipAddress: null,
      operatingSystem: 'Linux',
      status: over.status ?? 'online',
      siteId: null,
      lastSeenAt: '2026-10-17T10:00:00Z',
      agentVersion: '1',
      telemetry: over.telemetry === undefined ? telemetry() : over.telemetry,
    },
    health: over.health ?? 'healthy',
    ...(over.site ? { siteName: over.site, customerName: 'Acme' } : {}),
    containers: { total: 0, counts: { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 } },
  }
}

describe('what a reading is', () => {
  it.each([
    ['a fresh reading of a reporting host', item('a'), 'current'],
    ['demo data, which carries no freshness', item('a', { telemetry: telemetry({}) }), 'current'],
    [
      'an old one beside live heartbeats',
      item('a', { telemetry: telemetry({ stale: true }) }),
      'stale',
    ],
    ['heartbeats without telemetry', item('a', { telemetry: null }), 'missing'],
    ['an agent that stopped', item('a', { status: 'offline' }), 'offline'],
    ['a host that never reported', item('a', { status: 'unknown', telemetry: null }), 'never'],
  ] as const)('is %s: %s', (_what, row, reading) => {
    expect(readingOf(row)).toBe(reading)
  })

  it('shows a load only for a current reading', () => {
    expect(reportsLoad(item('a'))).toBe(true)
    expect(loadOf(item('a'), 'cpu')).toBe(40)
    const stale = item('a', { telemetry: telemetry({ stale: true }) })
    expect(reportsLoad(stale)).toBe(false)
    expect(loadOf(stale, 'cpu')).toBeNull()
    expect(uptimeOf(stale)).toBeNull()
  })

  it('shows no load for an offline host even though its last reading is kept', () => {
    expect(loadOf(item('a', { status: 'offline' }), 'disk')).toBeNull()
  })
})

describe('queryServers', () => {
  const fleet = Array.from({ length: 7 }, (_, index) =>
    item(`web-${index + 1}`, {
      health: index === 0 ? 'critical' : index < 3 ? 'warning' : 'healthy',
      site: index % 2 ? 'Athens' : 'Munich',
      telemetry: telemetry({ cpuPercent: index * 10 }),
    }),
  )
  const at = '2026-10-17T10:00:00Z'

  it('answers one page of the matches, with the totals that go with it', () => {
    const answer = queryServers(fleet, at, { pageSize: 3, page: 2 })
    expect(answer.items.map((row) => row.server.name)).toEqual(['web-4', 'web-5', 'web-6'])
    expect(answer.page).toEqual({ number: 2, size: 3, total: 7, pages: 3 })
    expect(answer.scopeTotal).toBe(7)
    expect(answer.generatedAt).toBe(at)
  })

  it('answers an empty page, and still the page count, past the last page', () => {
    const answer = queryServers(fleet, at, { pageSize: 3, page: 9 })
    expect(answer.items).toEqual([])
    expect(answer.page).toMatchObject({ number: 9, total: 7, pages: 3 })
  })

  it('has one page, never zero, when nothing matches', () => {
    const answer = queryServers(fleet, at, { q: 'nothing like it' })
    expect(answer.page).toMatchObject({ total: 0, pages: 1 })
    expect(answer.scopeTotal).toBe(7)
  })

  it('counts by status over the search, not over the status filter, so the chips stay true', () => {
    const answer = queryServers(fleet, at, { status: 'warning' })
    expect(answer.items).toHaveLength(2)
    expect(answer.counts).toEqual({ healthy: 4, warning: 2, critical: 1, unknown: 0, idle: 0 })
    const searched = queryServers(fleet, at, { q: 'athens', status: 'warning' })
    expect(searched.counts).toEqual({ healthy: 2, warning: 1, critical: 0, unknown: 0, idle: 0 })
  })

  it('keeps the scope total whatever the search says', () => {
    expect(queryServers(fleet, at, { q: 'athens' }).scopeTotal).toBe(7)
    expect(queryServers(fleet, at, { q: 'athens' }).page.total).toBe(3)
  })

  it('orders by the sort and the direction, the worst first by default', () => {
    expect(queryServers(fleet, at).items[0]?.server.name).toBe('web-1')
    const byCpu = queryServers(fleet, at, { sort: 'cpu', dir: 'desc' })
    expect(byCpu.items.map((row) => row.server.name).slice(0, 2)).toEqual(['web-7', 'web-6'])
  })

  it('puts a server with no current reading last in either direction of a load sort', () => {
    const rows = [
      item('fresh', { telemetry: telemetry({ cpuPercent: 10 }) }),
      item('stale', { telemetry: telemetry({ cpuPercent: 99, stale: true }) }),
    ]
    for (const dir of ['asc', 'desc'] as const) {
      const names = queryServers(rows, at, { sort: 'cpu', dir }).items.map((row) => row.server.name)
      expect(names).toEqual(['fresh', 'stale'])
    }
  })

  it('caps a page at what the console API serves and ignores a page size it cannot use', () => {
    expect(queryServers(fleet, at, { pageSize: 5000 }).page.size).toBe(200)
    expect(queryServers(fleet, at, { pageSize: 0 }).page.size).toBe(50)
    expect(queryServers(fleet, at, { page: -2 }).page.number).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { HealthStatus, ServerListItem, ServerStatus } from '@/api/types'
import {
  DEFAULT_QUERY,
  countByHealth,
  filterServers,
  loadOf,
  matchesSearch,
  nextSort,
  parseQuery,
  sortServers,
  stateWord,
  writeQuery,
} from './serversModel'

function item(
  name: string,
  over: {
    status?: ServerStatus
    health?: HealthStatus
    cpu?: number
    mem?: number
    disk?: number
    uptime?: number
    seen?: string | null
    site?: string
    customer?: string
    os?: string
    ip?: string
    telemetry?: boolean
  } = {},
): ServerListItem {
  const status = over.status ?? 'online'
  return {
    server: {
      id: `srv-${name}`,
      name,
      hostname: `${name}.internal`,
      ipAddress: over.ip ?? '10.0.0.1',
      operatingSystem: over.os ?? 'Debian 13',
      status,
      siteId: null,
      lastSeenAt: over.seen === undefined ? '2026-10-12T14:00:00Z' : over.seen,
      agentVersion: '0.4.2',
      telemetry:
        over.telemetry === false
          ? null
          : {
              cpuPercent: over.cpu ?? 10,
              memoryPercent: over.mem ?? 20,
              diskPercent: over.disk ?? 30,
              memoryTotalBytes: 1,
              diskTotalBytes: 1,
              uptimeSeconds: over.uptime ?? 1000,
              collectedAt: '2026-10-12T14:00:00Z',
            },
    },
    health: over.health ?? 'healthy',
    ...(over.site ? { siteName: over.site } : {}),
    ...(over.customer ? { customerName: over.customer } : {}),
    containers: { total: 0, counts: { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 } },
  }
}

const names = (rows: readonly ServerListItem[]) => rows.map((row) => row.server.name)

describe('query in the URL', () => {
  it('reads defaults from an empty URL and ignores garbage', () => {
    expect(parseQuery(new URLSearchParams())).toEqual(DEFAULT_QUERY)
    expect(parseQuery(new URLSearchParams('status=bogus&sort=bogus&dir=sideways'))).toEqual(
      DEFAULT_QUERY,
    )
  })

  it('round-trips a query and keeps the view params', () => {
    const query = { q: ' db ', status: 'warning', sort: 'cpu', dir: 'asc' } as const
    const written = writeQuery(new URLSearchParams('range=6h&customer=acme'), query)
    expect(written.get('range')).toBe('6h')
    expect(written.get('customer')).toBe('acme')
    expect(parseQuery(written)).toEqual({ ...query, q: 'db' })
  })

  it('omits defaults, so a link to the plain list stays plain', () => {
    expect(writeQuery(new URLSearchParams('q=x&sort=cpu'), DEFAULT_QUERY).toString()).toBe('')
  })

  it('omits a direction that is the column’s natural one', () => {
    const written = writeQuery(new URLSearchParams(), {
      ...DEFAULT_QUERY,
      sort: 'name',
      dir: 'asc',
    })
    expect(written.has('dir')).toBe(false)
    expect(parseQuery(written).dir).toBe('asc')
  })

  it('starts a new column at its natural direction and flips the same one', () => {
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'cpu')).toEqual({ sort: 'cpu', dir: 'desc' })
    expect(nextSort({ ...DEFAULT_QUERY, sort: 'cpu', dir: 'desc' }, 'cpu')).toEqual({
      sort: 'cpu',
      dir: 'asc',
    })
  })
})

describe('search and filter', () => {
  const rows = [
    item('ath-db-01', { site: 'Athens DC', customer: 'Meridian Logistics', ip: '10.20.2.10' }),
    item('fra-web-02', {
      site: 'Frankfurt DC',
      customer: 'Northwind Retail',
      os: 'Rocky Linux 9.4',
    }),
    item('core-ci-01', { health: 'unknown', status: 'unknown', telemetry: false, seen: null }),
  ]

  it('needs every word to match somewhere: name, address, OS, site or customer', () => {
    expect(matchesSearch(rows[0]!, 'db')).toBe(true)
    expect(matchesSearch(rows[0]!, '10.20.2')).toBe(true)
    expect(matchesSearch(rows[1]!, 'rocky')).toBe(true)
    expect(matchesSearch(rows[1]!, 'north frankfurt')).toBe(true)
    expect(matchesSearch(rows[1]!, 'north athens')).toBe(false)
    expect(matchesSearch(rows[0]!, '  ')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(names(filterServers(rows, { q: 'MERIDIAN', status: 'all' }))).toEqual(['ath-db-01'])
  })

  it('narrows by status, and counts every status', () => {
    expect(names(filterServers(rows, { q: '', status: 'unknown' }))).toEqual(['core-ci-01'])
    expect(countByHealth(rows)).toMatchObject({ healthy: 2, unknown: 1 })
  })
})

describe('sorting', () => {
  const rows = [
    item('b-ok', { cpu: 20, uptime: 500, seen: '2026-10-12T13:59:00Z' }),
    item('a-warn', { health: 'warning', cpu: 85, uptime: 900, seen: '2026-10-12T13:59:50Z' }),
    item('c-off', { status: 'offline', health: 'critical', seen: '2026-10-12T13:40:00Z' }),
    item('d-never', { status: 'unknown', health: 'unknown', telemetry: false, seen: null }),
  ]

  it('puts the worst first by default and breaks ties by name', () => {
    expect(names(sortServers(rows, { sort: 'status', dir: 'desc' }))).toEqual([
      'c-off',
      'a-warn',
      'd-never',
      'b-ok',
    ])
    expect(names(sortServers(rows, { sort: 'status', dir: 'asc' }))).toEqual([
      'b-ok',
      'd-never',
      'a-warn',
      'c-off',
    ])
  })

  it('sorts names naturally, A to Z', () => {
    const numbered = [item('web-10'), item('web-2'), item('web-1')]
    expect(names(sortServers(numbered, { sort: 'name', dir: 'asc' }))).toEqual([
      'web-1',
      'web-2',
      'web-10',
    ])
  })

  it('keeps rows with no reading last in either direction', () => {
    expect(names(sortServers(rows, { sort: 'cpu', dir: 'desc' }))).toEqual([
      'a-warn',
      'b-ok',
      'c-off',
      'd-never',
    ])
    expect(names(sortServers(rows, { sort: 'cpu', dir: 'asc' }))).toEqual([
      'b-ok',
      'a-warn',
      'c-off',
      'd-never',
    ])
  })

  it('leads with the longest silence when sorting heartbeats descending', () => {
    expect(names(sortServers(rows, { sort: 'seen', dir: 'desc' }))[0]).toBe('c-off')
  })

  it('does not mutate its input', () => {
    const copy = [...rows]
    sortServers(rows, { sort: 'name', dir: 'asc' })
    expect(rows).toEqual(copy)
  })
})

describe('what a row says', () => {
  it('reads no load from a host that stopped reporting', () => {
    const offline = item('c-off', { status: 'offline', health: 'critical', cpu: 99 })
    expect(loadOf(offline, 'cpu')).toBeNull()
    expect(loadOf(item('ok', { cpu: 12 }), 'cpu')).toBe(12)
  })

  it('names the problem, not only its severity', () => {
    expect(stateWord(item('a'))).toBe('ONLINE')
    expect(stateWord(item('a', { status: 'offline', health: 'critical' }))).toBe('OFFLINE')
    expect(stateWord(item('a', { health: 'unknown', status: 'unknown' }))).toBe('UNKNOWN')
    expect(stateWord(item('a', { health: 'warning', cpu: 83 }))).toBe('HIGH CPU')
    expect(stateWord(item('a', { health: 'critical', cpu: 83, mem: 97 }))).toBe('HIGH MEM')
    expect(stateWord(item('a', { health: 'warning', disk: 91 }))).toBe('DISK')
  })
})

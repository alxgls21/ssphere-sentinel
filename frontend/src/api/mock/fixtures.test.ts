import { describe, expect, it } from 'vitest'
import type { HealthStatus } from '@/api/types'
import { buildEstate, scopeEstate, type Estate, type FleetProfile } from './fixtures'
import { containerHealthOf, serverHealthOf } from './lookup'
import { HOUR, MINUTE } from './time'

const ANCHOR = Date.UTC(2026, 9, 12, 14, 5, 12)
const clockAt = (now: number) => ({ now, anchor: ANCHOR })
const story = () => buildEstate('story', clockAt(ANCHOR))

function healthMap({ fleet }: Estate): Record<string, HealthStatus> {
  return {
    ...Object.fromEntries(fleet.servers.map((s) => [s.id, serverHealthOf(s)])),
    ...Object.fromEntries(fleet.containers.map((c) => [c.id, containerHealthOf(c)])),
  }
}

describe('the story estate', () => {
  const { fleet } = story()

  it('has the planned scale', () => {
    expect(fleet.servers).toHaveLength(16)
    expect(fleet.containers.length).toBeGreaterThanOrEqual(50)
    expect(fleet.containers.length).toBeLessThanOrEqual(60)
  })

  it('gives every entity a unique id and a known site', () => {
    const ids = [...fleet.servers, ...fleet.containers].map((entity) => entity.id)
    expect(new Set(ids).size).toBe(ids.length)
    const siteIds = new Set(fleet.sites.map((site) => site.id))
    for (const entity of fleet.servers) {
      expect(siteIds.has(entity.siteId as string)).toBe(true)
    }
    for (const container of fleet.containers) {
      expect(fleet.servers.some((server) => server.id === container.serverId)).toBe(true)
    }
  })

  it('covers every container state the UI has to render', () => {
    const states = (state: string) => fleet.containers.filter((c) => c.state === state)
    expect(states('restarting')).toHaveLength(1)
    expect(states('dead')).toHaveLength(1)
    expect(fleet.containers.filter((c) => c.health === 'unhealthy')).toHaveLength(2)
    expect(states('exited').length).toBeGreaterThan(0)
    expect(states('created').length).toBeGreaterThan(0)
    expect(states('paused').length).toBeGreaterThan(0)
    const idle = fleet.containers.filter((c) => containerHealthOf(c) === 'idle')
    expect(idle.length).toBeGreaterThanOrEqual(3)
  })

  it('cannot observe the containers of the offline host', () => {
    const offline = fleet.servers.find((server) => server.status === 'offline')
    expect(offline?.name).toBe('pir-fs-01')
    const onIt = fleet.containers.filter((c) => c.serverId === offline?.id)
    expect(onIt.length).toBeGreaterThanOrEqual(3)
    for (const container of onIt) expect(container.state).toBe('unknown')
  })

  it('pins the outage to the story anchor', () => {
    const server = fleet.servers.find((s) => s.name === 'pir-fs-01')
    expect(Date.parse(server?.lastSeenAt as string)).toBe(ANCHOR - 14.5 * MINUTE)
  })

  it('classifies the story entities as designed', () => {
    const health = healthMap(story())
    expect(health['srv-pir-fs-01']).toBe('critical')
    expect(health['srv-ath-db-01']).toBe('warning')
    expect(health['srv-hc-bkp-01']).toBe('warning')
    expect(health['srv-fra-web-02']).toBe('warning')
    expect(health['srv-core-ci-01']).toBe('unknown')
    expect(health['ctr-ath-db-01-pgbouncer']).toBe('critical')
    expect(health['ctr-fra-web-02-queue-worker']).toBe('warning')
  })
})

describe('determinism and drift', () => {
  it('builds the same estate for the same clock', () => {
    expect(buildEstate('story', clockAt(ANCHOR + 90 * MINUTE))).toEqual(
      buildEstate('story', clockAt(ANCHOR + 90 * MINUTE)),
    )
  })

  it.each(['story', 'calm', 'partial'] as const)(
    'lets values drift while every status stays put (%s)',
    (profile) => {
      const first = buildEstate(profile, clockAt(ANCHOR))
      const baseline = healthMap(first)
      let drifted = false
      for (let step = 1; step <= 300; step += 1) {
        const later = buildEstate(profile, clockAt(ANCHOR + step * 17 * MINUTE))
        expect(healthMap(later)).toEqual(baseline)
        const cpu = (estate: Estate) =>
          estate.fleet.servers.find((s) => s.name === 'ath-app-01')?.telemetry?.cpuPercent
        if (cpu(first) !== cpu(later)) drifted = true
      }
      expect(drifted).toBe(true)
    },
  )

  it('keeps an offline host frozen', () => {
    const earlier = story().fleet
    const later = buildEstate('story', clockAt(ANCHOR + 3 * HOUR)).fleet
    const pick = (fleet: typeof earlier) => fleet.servers.find((s) => s.name === 'pir-fs-01')
    expect(pick(later)?.lastSeenAt).toBe(pick(earlier)?.lastSeenAt)
    expect(pick(later)?.telemetry).toEqual(pick(earlier)?.telemetry)
  })

  it('stamps heartbeats relative to the injected clock', () => {
    const now = ANCHOR + 5 * HOUR
    const { fleet } = buildEstate('story', clockAt(now))
    const online = fleet.servers.filter((s) => s.status === 'online')
    for (const server of online) {
      const age = (now - Date.parse(server.lastSeenAt as string)) / 1000
      expect(age).toBeGreaterThan(0)
      expect(age).toBeLessThan(45)
    }
  })
})

describe('profiles', () => {
  const profileHealth = (profile: FleetProfile) =>
    Object.values(healthMap(buildEstate(profile, clockAt(ANCHOR))))

  it('calm has nothing wrong and nothing unobserved', () => {
    for (const status of profileHealth('calm')) {
      expect(['healthy', 'idle']).toContain(status)
    }
    const { fleet } = buildEstate('calm', clockAt(ANCHOR))
    expect(fleet.servers.every((s) => s.status === 'online')).toBe(true)
  })

  it('partial has unknown entities but no warning or critical one', () => {
    const statuses = profileHealth('partial')
    expect(statuses).toContain('unknown')
    expect(statuses).not.toContain('critical')
    expect(statuses).not.toContain('warning')
    const { fleet } = buildEstate('partial', clockAt(ANCHOR))
    expect(fleet.servers.filter((server) => server.status === 'unknown')).toHaveLength(1)
  })

  it('empty monitors nothing', () => {
    const { fleet } = buildEstate('empty', clockAt(ANCHOR))
    expect(Object.values(fleet).every((list) => list.length === 0)).toBe(true)
  })
})

describe('scopeEstate', () => {
  const estate = story()
  const scope = (customerId: string | null, siteId: string | null) =>
    scopeEstate(estate, { customerId, siteId })

  it('passes everything through without a scope', () => {
    expect(scopeEstate(estate)).toBe(estate)
    expect(scope(null, null)).toBe(estate)
  })

  it('narrows to a site and lets containers follow their server', () => {
    const { fleet } = scope(null, 'site-fra-dc')
    expect(fleet.sites.map((site) => site.id)).toEqual(['site-fra-dc'])
    expect(fleet.customers.map((customer) => customer.id)).toEqual(['cus-northwind'])
    expect(fleet.servers.length).toBeGreaterThan(0)
    expect(fleet.servers.every((s) => s.siteId === 'site-fra-dc')).toBe(true)
    const serverIds = new Set(fleet.servers.map((s) => s.id))
    expect(fleet.containers.length).toBeGreaterThan(0)
    expect(fleet.containers.every((c) => serverIds.has(c.serverId))).toBe(true)
  })

  it('narrows to a customer: the union of its sites', () => {
    const { fleet } = scope('cus-meridian', null)
    expect(fleet.sites.map((s) => s.id).sort()).toEqual(['site-ath-dc', 'site-pir-depot'])
    expect(new Set(fleet.servers.map((s) => s.siteId))).toEqual(
      new Set(['site-ath-dc', 'site-pir-depot']),
    )
  })

  it('selects nothing for a site that belongs to another customer, or an unknown id', () => {
    for (const { fleet } of [scope('cus-halcyon', 'site-fra-dc'), scope('cus-nope', null)]) {
      expect(Object.values(fleet).every((list) => list.length === 0)).toBe(true)
    }
  })
})

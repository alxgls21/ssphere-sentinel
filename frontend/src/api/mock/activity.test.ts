import { describe, expect, it } from 'vitest'
import type { SentinelApi } from '@/api/client'
import type { Alert, SentinelEvent } from '@/api/types'
import { createMockApi } from './client'
import type { MockScenario } from './scenario'
import { DAY, HOUR, MINUTE } from './time'

const NOW = Date.UTC(2026, 9, 12, 14, 5, 12)

const apiFor = (scenario: MockScenario = 'normal'): SentinelApi =>
  createMockApi({ scenario, now: () => NOW, delayMs: 0 })

describe('alerts (planned: sample data derived from the same entities)', () => {
  it('exist exactly where an entity is critical or warning', async () => {
    const api = apiFor()
    const [alerts, attention, index] = await Promise.all([
      api.listAlerts(),
      api.listAttention(),
      api.getEntityIndex(),
    ])
    const subjects = new Set(alerts.map((alert) => alert.subject.id))
    const problems = attention.items.filter(
      (item) => item.severity === 'critical' || item.severity === 'warning',
    )
    for (const item of problems) expect(subjects.has(item.id), item.name).toBe(true)
    // ...and an unknown or idle entity asserts nothing, so it never alerts.
    for (const item of attention.items.filter((entry) => entry.severity === 'unknown')) {
      expect(subjects.has(item.id), item.name).toBe(false)
    }
    // Devices are the one extra source: their sample SNMP state.
    const known = new Set(index.items.map((item) => item.id))
    const extra = alerts.filter((alert) => !problems.some((item) => item.id === alert.subject.id))
    expect(extra.length).toBeGreaterThan(0)
    for (const alert of extra) {
      expect(['device', 'interface']).toContain(alert.subject.kind)
      expect(alert.subject.id.startsWith('dev-')).toBe(true)
      expect(known.has(alert.subject.id) || alert.subject.kind === 'interface').toBe(true)
    }
  })

  it('agree with the attention queue on severity', async () => {
    const api = apiFor()
    const [alerts, attention] = await Promise.all([api.listAlerts(), api.listAttention()])
    const severity = new Map(attention.items.map((item) => [item.id, item.severity]))
    for (const alert of alerts) {
      const expected = severity.get(alert.subject.id)
      if (expected) expect(alert.severity, alert.subject.name).toBe(expected)
    }
  })

  it('are critical first, then newest first, with unique ids', async () => {
    const alerts = await apiFor().listAlerts()
    const ids = alerts.map((alert) => alert.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (let i = 1; i < alerts.length; i += 1) {
      const a = alerts[i - 1] as Alert
      const b = alerts[i] as Alert
      if (a.severity === b.severity) {
        expect(Date.parse(a.since)).toBeGreaterThanOrEqual(Date.parse(b.since))
      } else {
        expect([a.severity, b.severity]).toEqual(['critical', 'warning'])
      }
    }
  })

  it('began before now and belong to the site of their subject', async () => {
    const api = apiFor()
    const alerts = await api.listAlerts()
    for (const alert of alerts) {
      expect(Date.parse(alert.since), alert.subject.name).toBeLessThan(NOW)
      expect(alert.siteId).not.toBeNull()
    }
    const pir = alerts.filter((alert) => alert.siteId === 'site-pir-depot')
    expect(pir.map((alert) => alert.subject.name).sort()).toEqual([
      'pir-fs-01',
      'pir-gateway',
      'pir-sw1',
      'pir-vpn',
    ])
  })

  it('tell the story with the numbers the other panels show', async () => {
    const alerts = await apiFor().listAlerts()
    const byName = (name: string) => alerts.find((alert) => alert.subject.name === name)
    expect(byName('ath-db-01')).toMatchObject({
      rule: 'server.disk.high',
      message: '91% used (limit 80%)',
    })
    expect(byName('fra-isp-a')).toMatchObject({ rule: 'probe.loss.high', severity: 'warning' })
    expect(byName('pir-fs-01')).toMatchObject({
      rule: 'server.heartbeat.missing',
      severity: 'critical',
    })
    expect(byName('hc-bkp-01')?.state).toBe('acknowledged')
  })

  it('can be filtered by state and limited', async () => {
    const api = apiFor()
    const all = await api.listAlerts()
    const active = await api.listAlerts({ state: 'active' })
    const acknowledged = await api.listAlerts({ state: 'acknowledged' })
    expect(active.length + acknowledged.length).toBe(all.length)
    expect(acknowledged.length).toBeGreaterThan(0)
    expect(active.every((alert) => alert.state === 'active')).toBe(true)
    expect(await api.listAlerts({ limit: 3 })).toEqual(all.slice(0, 3))
    expect(await api.listAlerts({ state: 'active', limit: 2 })).toEqual(active.slice(0, 2))
  })

  it('do not exist when nothing is wrong or nothing is monitored', async () => {
    for (const scenario of ['healthy', 'partial', 'empty'] as const) {
      expect(await apiFor(scenario).listAlerts(), scenario).toEqual([])
    }
  })
})

describe('events (planned: sample data)', () => {
  const eventsOf = (scenario?: MockScenario) => apiFor(scenario).listEvents()

  it('are listed newest first, all in the past, within a day', async () => {
    const events = await eventsOf()
    expect(events.length).toBeGreaterThan(20)
    for (let i = 1; i < events.length; i += 1) {
      expect(Date.parse((events[i - 1] as SentinelEvent).at)).toBeGreaterThanOrEqual(
        Date.parse((events[i] as SentinelEvent).at),
      )
    }
    for (const event of events) {
      expect(Date.parse(event.at)).toBeLessThanOrEqual(NOW)
      expect(Date.parse(event.at)).toBeGreaterThan(NOW - DAY)
    }
    const ids = events.map((event) => event.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('nest each recovery under the failure it resolves', async () => {
    const events = await eventsOf()
    const byId = new Map(events.map((event) => [event.id, event]))
    const recoveries = events.filter((event) => event.parentId !== undefined)
    expect(recoveries.length).toBeGreaterThan(5)
    for (const recovery of recoveries) {
      const parent = byId.get(recovery.parentId as string)
      expect(parent, recovery.message).toBeDefined()
      expect(Date.parse((parent as SentinelEvent).at)).toBeLessThan(Date.parse(recovery.at))
      expect((parent as SentinelEvent).subject.id).toBe(recovery.subject.id)
    }
    const resolved = recoveries.filter((event) => event.level === 'healthy')
    expect(resolved.length).toBeGreaterThan(3)
    for (const event of resolved) {
      expect(['warning', 'critical']).toContain(byId.get(event.parentId as string)?.level)
    }
  })

  it('open with an event for every alert, at the moment it began', async () => {
    const api = apiFor()
    const [alerts, events] = await Promise.all([api.listAlerts(), api.listEvents()])
    for (const alert of alerts) {
      const began = events.find(
        (event) =>
          event.subject.id === alert.subject.id &&
          event.at === alert.since &&
          event.level === alert.severity,
      )
      expect(began, alert.subject.name).toBeDefined()
    }
  })

  it('narrate the Piraeus outage in order', async () => {
    const events = await eventsOf()
    const piraeus = events.filter(
      (event) =>
        event.at >= new Date(NOW - 20 * MINUTE).toISOString() &&
        /^(pir|Piraeus)/.test(event.subject.name),
    )
    expect(piraeus.map((event) => event.subject.name)).toContain('Piraeus Depot')
    const marker = piraeus.find((event) => event.subject.kind === 'site')
    const firstFailure = piraeus.filter((event) => event.level === 'critical').at(-1)
    expect(Date.parse(marker?.at as string)).toBeLessThan(Date.parse(firstFailure?.at as string))
  })

  it('can be limited to a range and a count', async () => {
    const api = apiFor()
    const all = await api.listEvents()
    const lastHour = await api.listEvents({ range: '1h' })
    expect(lastHour.length).toBeGreaterThan(0)
    expect(lastHour.length).toBeLessThan(all.length)
    for (const event of lastHour) expect(Date.parse(event.at)).toBeGreaterThanOrEqual(NOW - HOUR)
    expect(await api.listEvents({ range: '24h' })).toEqual(all)
    expect(await api.listEvents({ limit: 5 })).toEqual(all.slice(0, 5))
  })

  it('keep their ids when the clock moves on, so nothing old ever looks new', async () => {
    let clock = NOW
    const api = createMockApi({ now: () => clock, delayMs: 0 })
    const before = (await api.listEvents()).map((event) => event.id)
    clock += 5 * HOUR
    const after = (await api.listEvents()).map((event) => event.id)
    expect(after).toEqual(before)
    const alertsBefore = (await createMockApi({ now: () => NOW, delayMs: 0 }).listAlerts()).map(
      (a) => a.id,
    )
    expect((await api.listAlerts()).map((alert) => alert.id)).toEqual(alertsBefore)
  })

  it('stay calm when nothing is wrong: history only, no open problem', async () => {
    const events = await eventsOf('healthy')
    expect(events.length).toBeGreaterThan(5)
    const open = events.filter(
      (event) =>
        (event.level === 'warning' || event.level === 'critical') &&
        !events.some((other) => other.parentId === event.id),
    )
    expect(open).toEqual([])
  })
})

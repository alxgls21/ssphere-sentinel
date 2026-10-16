import { describe, expect, it } from 'vitest'
import {
  DISPLAY_ORDER,
  compareSeverity,
  containerHealth,
  countEntities,
  countStatuses,
  deviceHealth,
  displayCounts,
  displayStatus,
  healthOf,
  isIssue,
  needsAttention,
  serverHealth,
  targetHealth,
  serverHealthWithResources,
  worstOf,
  worstStatus,
} from './status'
import { resourceLevel } from './thresholds'

describe('status mapping', () => {
  it('maps server states', () => {
    expect(serverHealth('online')).toBe('healthy')
    expect(serverHealth('warning')).toBe('warning')
    expect(serverHealth('offline')).toBe('critical')
    expect(serverHealth('unknown')).toBe('unknown')
  })

  it('treats stopped containers as idle, not as incidents (the backend cannot tell an exit from a crash)', () => {
    expect(containerHealth('exited', 'none')).toBe('idle')
    expect(containerHealth('created', 'none')).toBe('idle')
    expect(containerHealth('paused', 'none')).toBe('idle')
    expect(containerHealth('running', 'starting')).toBe('idle')
  })

  it('maps real container problems', () => {
    expect(containerHealth('running', 'unhealthy')).toBe('critical')
    expect(containerHealth('dead', 'none')).toBe('critical')
    expect(containerHealth('restarting', 'none')).toBe('warning')
    expect(containerHealth('running', 'none')).toBe('healthy')
    expect(containerHealth('running', 'healthy')).toBe('healthy')
    expect(containerHealth('unknown', 'unknown')).toBe('unknown')
  })

  it('classifies probe targets with the UI-default thresholds', () => {
    const t = (over: object) => ({
      status: 'up' as const,
      consecutiveFailures: 0,
      latencyMs: 20,
      packetLossPercent: 0,
      ...over,
    })
    expect(targetHealth(t({}))).toBe('healthy')
    expect(targetHealth(t({ latencyMs: 150 }))).toBe('healthy')
    expect(targetHealth(t({ latencyMs: 151 }))).toBe('warning')
    expect(targetHealth(t({ packetLossPercent: 2 }))).toBe('warning')
    expect(targetHealth(t({ status: 'degraded' }))).toBe('warning')
    expect(targetHealth(t({ status: 'down', consecutiveFailures: 2 }))).toBe('warning')
    expect(targetHealth(t({ status: 'down', consecutiveFailures: 3 }))).toBe('critical')
    expect(targetHealth(t({ status: 'unknown', latencyMs: null }))).toBe('unknown')
  })

  it('derives device health from reachability and interfaces', () => {
    expect(deviceHealth(false, 0)).toBe('critical')
    expect(deviceHealth(true, 2)).toBe('warning')
    expect(deviceHealth(true, 0)).toBe('healthy')
  })

  it('raises a server by its resource samples using the UI-default thresholds', () => {
    const sample = (cpu: number, mem = 10, disk = 10) => ({
      cpuPercent: cpu,
      memoryPercent: mem,
      diskPercent: disk,
    })
    expect(serverHealthWithResources('online', sample(79.4))).toBe('healthy')
    expect(serverHealthWithResources('online', sample(80))).toBe('warning')
    expect(serverHealthWithResources('online', sample(10, 10, 95))).toBe('critical')
    expect(serverHealthWithResources('warning', sample(10))).toBe('warning')
    expect(serverHealthWithResources('offline', sample(10))).toBe('critical')
    expect(serverHealthWithResources('unknown', null)).toBe('unknown')
    expect(serverHealthWithResources('online', null)).toBe('healthy')
  })

  it('orders severity worst first, with unknown before idle before healthy', () => {
    const order = ['healthy', 'idle', 'critical', 'unknown', 'warning'] as const
    expect([...order].sort(compareSeverity)).toEqual([
      'critical',
      'warning',
      'unknown',
      'idle',
      'healthy',
    ])
  })

  it('picks the worst status of a collection', () => {
    expect(worstStatus([])).toBe('unknown')
    expect(worstStatus(['idle', 'healthy'])).toBe('healthy')
    expect(worstStatus(['idle', 'idle'])).toBe('idle')
    expect(worstStatus(['healthy', 'critical', 'warning'])).toBe('critical')
    expect(worstStatus(['healthy', 'unknown'])).toBe('unknown')
  })

  it('says what needs attention and what is an issue', () => {
    expect(
      needsAttention('warning') && needsAttention('critical') && needsAttention('unknown'),
    ).toBe(true)
    expect(needsAttention('healthy') || needsAttention('idle')).toBe(false)
    expect(isIssue('warning') && isIssue('critical')).toBe(true)
    expect(isIssue('unknown') || isIssue('idle') || isIssue('healthy')).toBe(false)
  })

  it('counts statuses and reports the worst present', () => {
    const counts = countStatuses(['healthy', 'healthy', 'warning', 'idle', 'unknown'])
    expect(counts).toEqual({ healthy: 2, warning: 1, critical: 0, unknown: 1, idle: 1 })
    expect(worstOf(counts)).toBe('warning')
    expect(worstOf(countStatuses(['healthy', 'idle']))).toBeNull()
    expect(worstOf(countStatuses(['unknown']))).toBe('unknown')
  })
})

describe('thresholds judge the value as displayed', () => {
  it('classifies a resource by the whole percent the operator reads', () => {
    expect(resourceLevel(79.4)).toBe('ok')
    expect(resourceLevel(79.5)).toBe('warn') // prints "80%"
    expect(resourceLevel(94.4)).toBe('warn')
    expect(resourceLevel(94.5)).toBe('crit') // prints "95%"
  })

  it('classifies a probe by the latency and loss it prints', () => {
    const probe = (latencyMs: number, packetLossPercent = 0) => ({
      status: 'up' as const,
      consecutiveFailures: 0,
      latencyMs,
      packetLossPercent,
    })
    expect(targetHealth(probe(150.4))).toBe('healthy') // prints "150 ms"
    expect(targetHealth(probe(150.5))).toBe('warning') // prints "151 ms"
    expect(targetHealth(probe(20, 1.94))).toBe('healthy') // prints "1.9%"
    expect(targetHealth(probe(20, 1.95))).toBe('warning') // prints "2.0%"
  })
})

describe('offline is a presentation of critical', () => {
  it('shows a critical entity flagged offline as offline, and nothing else', () => {
    expect(displayStatus('critical', true)).toBe('offline')
    expect(displayStatus('critical')).toBe('critical')
    expect(displayStatus('critical', false)).toBe('critical')
    // The flag only ever refines critical: a stray flag on another status changes nothing.
    for (const status of ['healthy', 'warning', 'unknown', 'idle'] as const)
      expect(displayStatus(status, true)).toBe(status)
  })

  it('counts a shown state as the health status it is part of', () => {
    expect(healthOf('offline')).toBe('critical')
    for (const status of ['healthy', 'warning', 'critical', 'unknown', 'idle'] as const)
      expect(healthOf(status)).toBe(status)
  })

  it('lists the shown states worst first, offline directly after critical', () => {
    expect(DISPLAY_ORDER).toEqual(['critical', 'offline', 'warning', 'unknown', 'idle', 'healthy'])
    // The same order as severity, with offline slotted in: nothing ranks differently.
    expect(DISPLAY_ORDER.filter((status) => status !== 'offline')).toEqual(
      (['healthy', 'idle', 'critical', 'unknown', 'warning'] as const).toSorted(compareSeverity),
    )
  })

  it('splits critical into critical-without-offline and offline for display, totals unchanged', () => {
    const counts = { healthy: 11, warning: 3, critical: 3, unknown: 1, idle: 2, offline: 2 }
    const shown = displayCounts(counts)
    expect(shown).toEqual({
      healthy: 11,
      warning: 3,
      critical: 1,
      offline: 2,
      unknown: 1,
      idle: 2,
    })
    const total = (values: Record<string, number>) =>
      Object.values(values).reduce((sum, value) => sum + value, 0)
    expect(total(shown)).toBe(total({ ...counts, offline: 0 }))
  })

  it('has no offline members without the field, and never more than critical holds', () => {
    expect(displayCounts(countStatuses(['critical', 'healthy'])).offline).toBe(0)
    expect(displayCounts({ ...countStatuses(['critical']), offline: 5 })).toMatchObject({
      critical: 0,
      offline: 1,
    })
    expect(displayCounts({ ...countStatuses(['healthy']), offline: -3 }).offline).toBe(0)
  })

  it('counts entities by health status and notes the offline ones only when there are any', () => {
    const plain = countEntities([{ status: 'critical' }, { status: 'healthy' }])
    expect(plain).toEqual({ healthy: 1, warning: 0, critical: 1, unknown: 0, idle: 0 })
    expect('offline' in plain).toBe(false)

    const mixed = countEntities([
      { status: 'critical', offline: true },
      { status: 'critical' },
      { status: 'healthy' },
    ])
    expect(mixed).toEqual({ healthy: 1, warning: 0, critical: 2, unknown: 0, idle: 0, offline: 1 })
  })

  it('counts a flag on an entity that is not critical as nothing: offline only refines critical', () => {
    const stray = countEntities([
      { status: 'critical' },
      { status: 'warning', offline: true },
      { status: 'healthy', offline: true },
    ])
    expect(stray).toEqual({ healthy: 1, warning: 1, critical: 1, unknown: 0, idle: 0 })
    expect('offline' in stray).toBe(false)
  })

  it('keeps critical the worst status present in counts that carry offline members', () => {
    expect(worstOf({ ...countStatuses(['critical', 'healthy']), offline: 1 })).toBe('critical')
  })
})

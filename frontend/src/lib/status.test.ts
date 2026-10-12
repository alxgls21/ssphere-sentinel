import { describe, expect, it } from 'vitest'
import {
  compareSeverity,
  containerHealth,
  countStatuses,
  deviceHealth,
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

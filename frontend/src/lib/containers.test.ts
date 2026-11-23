import { describe, expect, it } from 'vitest'
import type { ContainerHealth, ContainerState, HealthStatus, ServerContainer } from '@/api/types'
import { containerWord, endedText, sortContainers, startedText } from './containers'

const row = (
  name: string,
  state: ContainerState,
  health: ContainerHealth,
  status: HealthStatus,
  startedAt: string | null = '2026-10-12T12:00:00Z',
): ServerContainer => ({
  container: {
    id: name,
    serverId: 's',
    name,
    image: 'img',
    state,
    health,
    startedAt,
    exitCode: null,
    oomKilled: null,
    finishedAt: null,
  },
  status,
})

describe('containerWord', () => {
  it('names what the container is doing', () => {
    expect(containerWord(row('a', 'running', 'healthy', 'healthy'))).toBe('RUNNING')
    expect(containerWord(row('a', 'running', 'unhealthy', 'critical'))).toBe('UNHEALTHY')
    expect(containerWord(row('a', 'running', 'starting', 'idle'))).toBe('STARTING')
    expect(containerWord(row('a', 'exited', 'none', 'idle'))).toBe('STOPPED')
    expect(containerWord(row('a', 'restarting', 'none', 'warning'))).toBe('RESTARTING')
    expect(containerWord(row('a', 'unknown', 'unknown', 'unknown'))).toBe('UNKNOWN')
  })

  it('says an exited container crashed when the server judged it critical, and OOM when the kernel killed it', () => {
    const crashed = row('a', 'exited', 'none', 'critical')
    expect(containerWord(crashed)).toBe('CRASHED')
    const killed = row('a', 'exited', 'none', 'critical')
    killed.container.oomKilled = true
    expect(containerWord(killed)).toBe('OOM KILLED')
    expect(containerWord(row('a', 'exited', 'none', 'idle'))).toBe('STOPPED')
  })
})

describe('endedText', () => {
  it('says how an exited container ended, and nothing for one that runs or whose end is not known', () => {
    const exited = row('a', 'exited', 'none', 'critical')
    exited.container.exitCode = 1
    expect(endedText(exited)).toBe('exited with code 1')
    exited.container.exitCode = 0
    expect(endedText(exited)).toBe('exited normally (code 0)')
    exited.container.oomKilled = true
    expect(endedText(exited)).toBe('killed by the kernel for memory')
    expect(endedText(row('a', 'exited', 'none', 'idle'))).toBeNull()
    expect(endedText(row('a', 'running', 'healthy', 'healthy'))).toBeNull()
  })
})

describe('sortContainers', () => {
  it('leads with the broken ones, then by name, without touching its input', () => {
    const rows = [
      row('web-10', 'running', 'healthy', 'healthy'),
      row('web-2', 'running', 'healthy', 'healthy'),
      row('api', 'running', 'unhealthy', 'critical'),
      row('job', 'exited', 'none', 'idle'),
    ]
    expect(sortContainers(rows).map((r) => r.container.name)).toEqual([
      'api',
      'job',
      'web-2',
      'web-10',
    ])
    expect(rows[0]?.container.name).toBe('web-10')
  })
})

describe('startedText', () => {
  const now = Date.parse('2026-10-12T14:00:00Z')
  it('says how long ago, and a dash when it cannot know', () => {
    expect(startedText(row('a', 'running', 'healthy', 'healthy'), now)).toBe('2h')
    expect(startedText(row('a', 'created', 'none', 'idle', null), now)).toBe('—')
    expect(startedText(row('a', 'unknown', 'unknown', 'unknown'), now)).toBe('—')
  })
})

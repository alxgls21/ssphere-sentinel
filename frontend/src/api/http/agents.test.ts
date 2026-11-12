import { describe, expect, it, vi } from 'vitest'
import { listAgents, parseAgentOptionList } from './agents'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (agents.py). */
const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'ath-probe',
  enabled: true,
  status: 'online',
  lastSeenAt: '2026-10-17T10:00:00.000Z',
  serverId: 's1',
  serverName: 'ath-probe-01',
  ...over,
})
const list = (items: unknown[]) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
})

describe('the agents to choose from', () => {
  it('lists them with their server and state, sending the search and the page', async () => {
    const get = vi.fn(async () =>
      list([agent(), agent({ id: 'a2', status: 'unknown', lastSeenAt: null, enabled: false })]),
    )
    const t = { get } as unknown as Transport
    const result = await listAgents(t)({ q: ' probe ', page: 2, pageSize: 100 })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      id: 'a1',
      serverName: 'ath-probe-01',
      status: 'online',
    })
    expect(result.items[1]).toMatchObject({ status: 'unknown', lastSeenAt: null, enabled: false })
    expect(get).toHaveBeenCalledWith('agents/', {
      signal: undefined,
      query: { q: 'probe', page: '2', pageSize: '100' },
    })
  })

  it('never carries a token or a hash, even if an answer held one', () => {
    const parsed = parseAgentOptionList(list([agent({ token: 'x', tokenHash: 'y' })]))
    expect(JSON.stringify(parsed)).not.toMatch(/token/i)
  })

  it.each([
    ['a status it does not know', agent({ status: 'sleeping' })],
    ['a server without a name', agent({ serverName: null })],
  ])('refuses an agent with %s', (_what, raw) => {
    expect(() => parseAgentOptionList(list([raw]))).toThrow(/unexpected answer/)
  })
})

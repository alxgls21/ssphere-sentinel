import { describe, expect, it } from 'vitest'
import { DEFAULT_TARGET_LIMITS, type TargetLimits } from '@/lib/targets'
import {
  DEFAULT_QUERY,
  NETWORK_PAGE_SIZE,
  agentServerPath,
  agentText,
  isDefaultView,
  latencyCell,
  lossCell,
  nextSort,
  parseQuery,
  requestOf,
  targetPath,
  writeQuery,
} from './networkModel'
import { NOW, item, iso, measurement } from './testing'

const parse = (search: string) => parseQuery(new URLSearchParams(search))
const LIMITS: TargetLimits = { ...DEFAULT_TARGET_LIMITS, critFailures: 3 }

describe('the query', () => {
  it('reads the defaults from an empty URL, and every field the API supports', () => {
    expect(parse('')).toEqual(DEFAULT_QUERY)
    expect(parse('q=gate&status=idle&sort=measured&dir=asc&page=3')).toEqual({
      q: 'gate',
      status: 'idle',
      sort: 'measured',
      dir: 'asc',
      page: 3,
    })
  })

  it('ignores a status, sort, direction or page the API would refuse', () => {
    expect(parse('status=down&sort=jitter&dir=up&page=0')).toEqual(DEFAULT_QUERY)
    expect(parse('page=10001').page).toBe(1)
    expect(parse('page=banana').page).toBe(1)
  })

  it('takes the natural direction of a column when none is given', () => {
    expect(parse('sort=name').dir).toBe('asc')
    for (const sort of ['status', 'latency', 'loss', 'measured']) {
      expect(parse(`sort=${sort}`).dir).toBe('desc')
    }
  })

  it('writes without defaults, keeps other params and round-trips', () => {
    const base = new URLSearchParams('range=6h')
    expect(writeQuery(base, DEFAULT_QUERY).toString()).toBe('range=6h')
    const query = {
      q: 'x',
      status: 'warning' as const,
      sort: 'loss' as const,
      dir: 'asc' as const,
      page: 2,
    }
    expect(writeQuery(base, query).toString()).toBe(
      'range=6h&q=x&status=warning&sort=loss&dir=asc&page=2',
    )
    expect(parseQuery(writeQuery(new URLSearchParams(), query))).toEqual(query)
  })

  it('flips the active column and starts another at its natural direction', () => {
    expect(nextSort(DEFAULT_QUERY, 'status')).toEqual({ sort: 'status', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'measured')).toEqual({ sort: 'measured', dir: 'desc' })
  })

  it('sends the query, the debounced search and the page size, and says what the default view is', () => {
    expect(requestOf({ ...DEFAULT_QUERY, status: 'idle', page: 2 }, 'gw')).toEqual({
      q: 'gw',
      status: 'idle',
      sort: 'status',
      dir: 'desc',
      page: 2,
      pageSize: NETWORK_PAGE_SIZE,
    })
    expect(isDefaultView({ ...DEFAULT_QUERY, page: 4, sort: 'name' })).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: 'x' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, status: 'idle' })).toBe(false)
  })

  it('links to a target and to an agent’s server, encoded', () => {
    expect(targetPath('a b')).toBe('/network/a%20b')
    expect(agentServerPath('s/1')).toBe('/servers/s%2F1')
  })
})

describe('the readings of a row', () => {
  it('shows latency and loss for a current reading, in the protocol’s words', () => {
    const icmp = item({ latest: measurement({ latencyMs: 12.4, lossPercent: 2 }) })
    expect(latencyCell(icmp, NOW, LIMITS)).toEqual({ text: '12 ms' })
    expect(lossCell(icmp, NOW, LIMITS)).toEqual({ text: '2.0% lost' })
    const tcp = item({ protocol: 'tcp', latest: measurement({ lossPercent: 2 }) })
    expect(lossCell(tcp, NOW, LIMITS)).toEqual({ text: '2.0% failed' })
  })

  it('says "no answer" for a current failed measurement, not a latency', () => {
    const failed = item({
      reason: 'failed',
      latest: measurement({ success: false, latencyMs: null, lossPercent: 100 }),
    })
    expect(latencyCell(failed, NOW, LIMITS).text).toBe('no answer')
    expect(lossCell(failed, NOW, LIMITS).text).toBe('100% lost')
  })

  it.each(['stale', 'agent_offline', 'disabled', 'no_agent'] as const)(
    'shows no value and the reason for a %s target, never its last number as current',
    (reason) => {
      const entry = item({
        reason,
        agent: reason === 'no_agent' ? 'none' : 'online',
        latest: measurement({ measuredAt: iso(7200), latencyMs: 12.4, lossPercent: 0 }),
      })
      const latency = latencyCell(entry, NOW, LIMITS)
      expect(latency.text).toBe('—')
      expect(latency.note).toMatch(/^Not a current reading\./)
      // The last measurement is named as the last, with its age, and as such only.
      expect(latency.note).toMatch(/Last measurement 2h ago: 12 ms/)
      expect(lossCell(entry, NOW, LIMITS).text).toBe('—')
    },
  )

  it('shows nothing and no "last measurement" for a target never measured', () => {
    const entry = item({ reason: 'no_measurement' })
    const cell = latencyCell(entry, NOW, LIMITS)
    expect(cell.text).toBe('—')
    expect(cell.note).toBe('Not a current reading. Nothing has been measured yet.')
  })

  it('names the agent as the API lets it be named', () => {
    expect(agentText(item({ agent: 'online' }))).toBe('ath-probe')
    expect(agentText(item({ agent: 'offline' }))).toBe('ath-probe (offline)')
    expect(agentText(item({ agent: 'hidden' }))).toBe('assigned')
    expect(agentText(item({ agent: 'none' }))).toBe('none assigned')
  })
})

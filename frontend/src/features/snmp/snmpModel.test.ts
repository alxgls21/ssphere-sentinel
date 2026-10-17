import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUERY,
  SNMP_PAGE_SIZE,
  agentServerPath,
  devicePath,
  isDefaultView,
  nextSort,
  parseQuery,
  requestOf,
  responseCell,
  writeQuery,
} from './snmpModel'
import { item } from './testing'

const parse = (search: string) => parseQuery(new URLSearchParams(search))

describe('the query', () => {
  it('reads the defaults from an empty URL, and every field the API supports', () => {
    expect(parse('')).toEqual(DEFAULT_QUERY)
    expect(parse('q=core&status=idle&sort=polled&dir=asc&page=3')).toEqual({
      q: 'core',
      status: 'idle',
      sort: 'polled',
      dir: 'asc',
      page: 3,
    })
  })

  it('ignores a status, sort, direction or page the API would refuse', () => {
    expect(parse('status=down&sort=ports&dir=up&page=0')).toEqual(DEFAULT_QUERY)
    expect(parse('page=10001').page).toBe(1)
    expect(parse('page=banana').page).toBe(1)
  })

  it('takes the natural direction of a column when none is given', () => {
    expect(parse('sort=name').dir).toBe('asc')
    for (const sort of ['status', 'response', 'polled'])
      expect(parse(`sort=${sort}`).dir).toBe('desc')
  })

  it('writes without defaults, keeps other params and round-trips', () => {
    const base = new URLSearchParams('range=6h')
    expect(writeQuery(base, DEFAULT_QUERY).toString()).toBe('range=6h')
    const query = {
      q: 'x',
      status: 'critical' as const,
      sort: 'response' as const,
      dir: 'asc' as const,
      page: 2,
    }
    expect(writeQuery(base, query).toString()).toBe(
      'range=6h&q=x&status=critical&sort=response&dir=asc&page=2',
    )
    expect(parseQuery(writeQuery(new URLSearchParams(), query))).toEqual(query)
  })

  it('keeps the chosen interface of a device page when the list query is written elsewhere', () => {
    const next = writeQuery(new URLSearchParams('interface=12'), { ...DEFAULT_QUERY, q: 'x' })
    expect(next.get('interface')).toBe('12')
  })

  it('flips the active column and starts another at its natural direction', () => {
    expect(nextSort(DEFAULT_QUERY, 'status')).toEqual({ sort: 'status', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'polled')).toEqual({ sort: 'polled', dir: 'desc' })
  })

  it('sends the query, the debounced search and the page size, and says what the default view is', () => {
    expect(requestOf({ ...DEFAULT_QUERY, status: 'idle', page: 2 }, 'sw')).toEqual({
      q: 'sw',
      status: 'idle',
      sort: 'status',
      dir: 'desc',
      page: 2,
      pageSize: SNMP_PAGE_SIZE,
    })
    expect(isDefaultView({ ...DEFAULT_QUERY, page: 4, sort: 'name' })).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: 'x' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, status: 'idle' })).toBe(false)
  })

  it('links to a device and to an agent’s server, encoded', () => {
    expect(devicePath('a b')).toBe('/snmp/a%20b')
    expect(agentServerPath('s/1')).toBe('/servers/s%2F1')
  })
})

describe('the response of a row', () => {
  it('is the present value only for a reachable device with a current poll', () => {
    expect(responseCell(item())).toEqual({ text: '12 ms' })
  })

  it.each(['stale', 'agent_offline', 'disabled', 'no_agent', 'no_poll', 'unreachable'] as const)(
    'is a dash with the reason for a %s device',
    (reason) => {
      const cell = responseCell(item({ reason, responseMs: 9 }))
      expect(cell.text).toBe('—')
      expect(cell.note).toBeTruthy()
    },
  )
})

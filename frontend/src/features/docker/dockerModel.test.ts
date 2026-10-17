import { describe, expect, it } from 'vitest'
import type { ContainerListItem } from '@/api/types'
import {
  DEFAULT_QUERY,
  DOCKER_PAGE_SIZE,
  dockerIdOf,
  hasNoState,
  healthText,
  hostPath,
  isDefaultView,
  nextSort,
  parseQuery,
  requestOf,
  serverOf,
  serverOfId,
  writeQuery,
} from './dockerModel'

const parse = (search: string) => parseQuery(new URLSearchParams(search))

const item = (over: Partial<ContainerListItem['container']> = {}): ContainerListItem => ({
  container: {
    id: 'srv-1:abc',
    serverId: 'srv-1',
    name: 'web',
    image: 'nginx:1',
    state: 'running',
    health: 'healthy',
    startedAt: null,
    ...over,
  },
  status: 'healthy',
  serverName: 'host',
})

describe('parseQuery', () => {
  it('reads the defaults from an empty URL', () => {
    expect(parse('')).toEqual(DEFAULT_QUERY)
  })

  it('reads every field the API supports', () => {
    expect(
      parse('q=pg&status=idle&sort=started&dir=asc&page=3&server=srv-1&focus=srv-1:abc'),
    ).toEqual({
      q: 'pg',
      status: 'idle',
      sort: 'started',
      dir: 'asc',
      page: 3,
      server: 'srv-1',
      focus: 'srv-1:abc',
    })
  })

  it('ignores a status, sort, direction, page or host the API would refuse', () => {
    expect(parse('status=offline&sort=cpu&dir=up&page=0&server=not%20an%20id')).toEqual(
      DEFAULT_QUERY,
    )
    expect(parse('page=10001').page).toBe(1)
    expect(parse('page=banana').page).toBe(1)
    expect(parse(`server=${'a'.repeat(37)}`).server).toBeNull()
  })

  it('takes the natural direction of a column when none is given', () => {
    expect(parse('sort=name').dir).toBe('asc')
    expect(parse('sort=server').dir).toBe('asc')
    expect(parse('sort=started').dir).toBe('desc')
    expect(parse('sort=status').dir).toBe('desc')
  })
})

describe('writeQuery', () => {
  it('omits defaults and keeps other params', () => {
    const base = new URLSearchParams('range=6h')
    expect(writeQuery(base, DEFAULT_QUERY).toString()).toBe('range=6h')
    const next = writeQuery(base, {
      ...DEFAULT_QUERY,
      q: ' pg ',
      status: 'critical',
      sort: 'name',
      dir: 'asc',
      page: 2,
      server: 'srv-1',
    })
    expect(next.toString()).toBe('range=6h&q=pg&status=critical&sort=name&page=2&server=srv-1')
  })

  it('round-trips through parseQuery', () => {
    const query = {
      ...DEFAULT_QUERY,
      q: 'x',
      status: 'warning' as const,
      sort: 'server' as const,
      dir: 'desc' as const,
      page: 4,
    }
    expect(parseQuery(writeQuery(new URLSearchParams(), query))).toEqual(query)
  })
})

describe('the host of a query', () => {
  it('is the host asked for, else the host a pointed-at container runs on', () => {
    expect(serverOf({ ...DEFAULT_QUERY, server: 'a' })).toBe('a')
    expect(serverOf({ ...DEFAULT_QUERY, focus: 'srv-9:abc' })).toBe('srv-9')
    expect(serverOf({ ...DEFAULT_QUERY, server: 'a', focus: 'srv-9:abc' })).toBe('a')
    expect(serverOf(DEFAULT_QUERY)).toBeNull()
  })

  it('names no host for an id without one', () => {
    expect(serverOfId('abc')).toBeNull()
    expect(serverOfId(':abc')).toBeNull()
    expect(serverOfId('has space:abc')).toBeNull()
    expect(serverOfId('srv-1:abc:def')).toBe('srv-1')
  })

  it('splits a container id into the Docker part', () => {
    expect(dockerIdOf('srv-1:abcdef123456')).toBe('abcdef123456')
    expect(dockerIdOf('plain')).toBe('plain')
  })

  it('links to the page of the host, encoded', () => {
    expect(hostPath('a b')).toBe('/servers/a%20b')
  })
})

describe('requestOf', () => {
  it('sends the query, the debounced search and the page size, and a host only when there is one', () => {
    expect(requestOf({ ...DEFAULT_QUERY, status: 'warning', page: 2 }, 'pg')).toEqual({
      q: 'pg',
      status: 'warning',
      sort: 'status',
      dir: 'desc',
      page: 2,
      pageSize: DOCKER_PAGE_SIZE,
    })
    expect(requestOf({ ...DEFAULT_QUERY, focus: 'srv-9:abc' }, '')).toMatchObject({
      server: 'srv-9',
    })
  })
})

describe('nextSort and isDefaultView', () => {
  it('flips the active column and starts another at its natural direction', () => {
    expect(nextSort(DEFAULT_QUERY, 'status')).toEqual({ sort: 'status', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'started')).toEqual({ sort: 'started', dir: 'desc' })
  })

  it('is the default view only without search, filter, host or pointer', () => {
    expect(isDefaultView(DEFAULT_QUERY)).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, page: 3, sort: 'name' })).toBe(true)
    for (const patch of [
      { q: 'x' },
      { status: 'idle' as const },
      { server: 'a' },
      { focus: 'a:b' },
    ]) {
      expect(isDefaultView({ ...DEFAULT_QUERY, ...patch })).toBe(false)
    }
  })
})

describe('the words of a row', () => {
  it('says a container has no current state only for the unknown state the API serves', () => {
    expect(hasNoState(item({ state: 'unknown', health: 'unknown' }))).toBe(true)
    expect(hasNoState(item({ state: 'exited', health: 'none' }))).toBe(false)
  })

  it('gives the health as the API does, naming "none" as no check', () => {
    expect(healthText(item({ health: 'unhealthy' }))).toBe('unhealthy')
    expect(healthText(item({ health: 'none' }))).toBe('no check')
    expect(healthText(item({ state: 'unknown', health: 'unknown' }))).toBe('unknown')
  })
})

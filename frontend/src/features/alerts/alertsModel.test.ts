import { describe, expect, it } from 'vitest'
import {
  ALERTS_PAGE_SIZE,
  DEFAULT_QUERY,
  FIRST_DIR,
  KIND_FILTERS,
  SORT_KEYS,
  STATUS_FILTERS,
  filterCount,
  isDefaultView,
  lastChange,
  nextSort,
  parseQuery,
  requestOf,
  writeQuery,
  type AlertsQuery,
} from './alertsModel'
import { incident, NOW } from './testing'

const parse = (search: string) => parseQuery(new URLSearchParams(search))

describe('the query in the URL', () => {
  it('opens on what is open, the worst first', () => {
    expect(parse('')).toEqual(DEFAULT_QUERY)
    expect(DEFAULT_QUERY).toMatchObject({ status: 'open', sort: 'severity', dir: 'desc', page: 1 })
  })

  it('reads every part of a link', () => {
    expect(
      parse('q=core&status=ended&severity=warning&kind=interface&sort=name&dir=desc&page=4'),
    ).toEqual({
      q: 'core',
      status: 'ended',
      severity: 'warning',
      kind: 'interface',
      sort: 'name',
      dir: 'desc',
      page: 4,
    })
  })

  it('falls back on the default for anything it does not know, and on the first page for a bad page', () => {
    expect(parse('status=resolved&severity=major&kind=site&sort=age&dir=up&page=0')).toEqual(
      DEFAULT_QUERY,
    )
    for (const page of ['-1', 'x', '1.5', '10001', '123456789']) {
      expect(parse(`page=${page}`).page, page).toBe(1)
    }
    expect(parse('page=10000').page).toBe(10_000)
  })

  it('gives a sort its natural direction when none is named: newest and worst first, names A to Z', () => {
    expect(parse('sort=opened').dir).toBe('desc')
    expect(parse('sort=started').dir).toBe('desc')
    expect(parse('sort=name').dir).toBe('asc')
    expect(parse('sort=status').dir).toBe('desc')
  })

  it('accepts every status, kind and sort the API takes', () => {
    for (const status of STATUS_FILTERS) expect(parse(`status=${status}`).status).toBe(status)
    for (const kind of KIND_FILTERS) expect(parse(`kind=${kind}`).kind).toBe(kind)
    for (const sort of SORT_KEYS) expect(parse(`sort=${sort}`).sort).toBe(sort)
  })

  it('writes only what differs from the defaults, keeps other parameters, and round-trips', () => {
    expect(writeQuery(new URLSearchParams('customer=c1'), DEFAULT_QUERY).toString()).toBe(
      'customer=c1',
    )
    const query: AlertsQuery = {
      q: ' core ',
      status: 'acknowledged',
      severity: 'critical',
      kind: 'server',
      sort: 'name',
      dir: 'desc',
      page: 2,
    }
    const written = writeQuery(new URLSearchParams('site=s1'), query)
    expect(written.get('site')).toBe('s1')
    expect(written.get('q')).toBe('core')
    expect(parseQuery(written)).toEqual({ ...query, q: 'core' })
  })

  it('does not write the default direction of a sort', () => {
    const written = writeQuery(new URLSearchParams(), {
      ...DEFAULT_QUERY,
      sort: 'name',
      dir: 'asc',
    })
    expect(written.has('dir')).toBe(false)
    expect(written.get('sort')).toBe('name')
  })

  it('flips the direction on the same column and starts another at its natural one', () => {
    expect(nextSort(DEFAULT_QUERY, 'severity')).toEqual({ sort: 'severity', dir: 'asc' })
    expect(nextSort(DEFAULT_QUERY, 'name')).toEqual({ sort: 'name', dir: FIRST_DIR.name })
    expect(nextSort(DEFAULT_QUERY, 'opened')).toEqual({ sort: 'opened', dir: 'desc' })
  })

  it('knows the opening view from a narrowed one', () => {
    expect(isDefaultView(DEFAULT_QUERY)).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: ' ' })).toBe(true)
    expect(isDefaultView({ ...DEFAULT_QUERY, q: 'x' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, status: 'all' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, severity: 'critical' })).toBe(false)
    expect(isDefaultView({ ...DEFAULT_QUERY, kind: 'device' })).toBe(false)
    // Sort and page do not narrow anything.
    expect(isDefaultView({ ...DEFAULT_QUERY, sort: 'name', page: 3 })).toBe(true)
  })

  it('asks for one bounded page, with the query and the debounced search', () => {
    expect(requestOf({ ...DEFAULT_QUERY, q: 'typed', page: 2 }, 'settled')).toEqual({
      q: 'settled',
      status: 'open',
      severity: 'all',
      kind: 'all',
      sort: 'severity',
      dir: 'desc',
      page: 2,
      pageSize: ALERTS_PAGE_SIZE,
    })
    expect(ALERTS_PAGE_SIZE).toBeLessThanOrEqual(200)
  })
})

describe('the numbers on the status chips', () => {
  const counts = { active: 3, acknowledged: 2, recovered: 7, closed: 5 }

  it('are the API’s counts: open is active and acknowledged, history is recovered and closed', () => {
    expect(filterCount('open', counts)).toBe(5)
    expect(filterCount('active', counts)).toBe(3)
    expect(filterCount('acknowledged', counts)).toBe(2)
    expect(filterCount('ended', counts)).toBe(12)
    expect(filterCount('recovered', counts)).toBe(7)
    expect(filterCount('closed', counts)).toBe(5)
    expect(filterCount('all', counts)).toBe(17)
  })
})

describe('the latest change of an incident', () => {
  it('says an active incident is not acknowledged yet', () => {
    expect(lastChange(incident(), NOW, 'utc')).toMatchObject({
      text: '—',
      title: 'Not acknowledged yet.',
    })
  })

  it('says who acknowledged and when, and that it is still open', () => {
    const change = lastChange(incident({ status: 'acknowledged' }), NOW, 'utc')
    expect(change.text).toBe('maria · 9m ago')
    expect(change.title).toMatch(/Acknowledged by maria at .* Still open\./)
  })

  it('says when it recovered, and when it closed and why', () => {
    expect(lastChange(incident({ status: 'recovered' }), NOW, 'utc').text).toBe('recovered 1m ago')
    const closed = lastChange(
      incident({ status: 'closed', closeReason: 'entity_disabled' }),
      NOW,
      'utc',
    )
    expect(closed.text).toBe('closed 30s ago')
    expect(closed.title).toMatch(/^The object was disabled or stopped\./)
  })
})

import { Server } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import type { EntityIndexItem } from '@/api/types'
import {
  GROUP_LIMIT,
  PROBLEM_LIMIT,
  buildGroups,
  entityItem,
  helpItems,
  problemItems,
  screenItems,
  screenOf,
  type PaletteItem,
  type PaletteSource,
} from './model'
import type { Scope } from './query'

const entity = (
  item: Pick<EntityIndexItem, 'id' | 'kind' | 'name' | 'status'> & Partial<EntityIndexItem>,
): PaletteItem => entityItem({ detail: '', ...item }, vi.fn())

const action = (id: string, title: string, keywords?: string[]): PaletteItem => ({
  id,
  group: 'actions',
  title,
  icon: Server,
  keywords,
  run: vi.fn(),
})

function source(overrides: Partial<PaletteSource> = {}): PaletteSource {
  return {
    entities: [],
    sites: [],
    'go-to': screenItems(vi.fn(), true),
    actions: [action('a1', 'Refresh now')],
    scenario: [],
    planned: [{ ...action('p1', 'Acknowledge alert'), group: 'planned', run: null }],
    help: helpItems(vi.fn()),
    ...overrides,
  }
}

const query = (text: string, scope: Scope = 'all') => ({ scope, text })
const ids = (groups: ReturnType<typeof buildGroups>) =>
  groups.map((group) => [group.id, group.items.map((item) => item.title)])

describe('entityItem', () => {
  it('describes a server by kind, detail and site, in mono', () => {
    const item = entity({
      id: '1',
      kind: 'server',
      name: 'edge-gw-02',
      detail: '10.20.0.2',
      status: 'critical',
      siteName: 'Piraeus',
      customerName: 'Acme',
    })
    expect(item).toMatchObject({
      group: 'entities',
      title: 'edge-gw-02',
      subtitle: 'server · 10.20.0.2 · Piraeus',
      status: 'critical',
    })
    expect(item.prose).toBeFalsy()
  })

  it('carries the offline flag of a server that stopped reporting, and no other', () => {
    const offline = entity({
      id: '1',
      kind: 'server',
      name: 'pir-fs-01',
      status: 'critical',
      offline: true,
    })
    expect(offline).toMatchObject({ status: 'critical', offline: true })
    const plain = entity({ id: '2', kind: 'server', name: 'edge-gw-02', status: 'critical' })
    expect(plain.offline).toBeUndefined()
    expect('offline' in plain).toBe(false)
  })

  it('treats sites and customers as prose and does not repeat their own name', () => {
    const site = entity({
      id: 's',
      kind: 'site',
      name: 'Piraeus Port',
      detail: '2 servers',
      status: 'warning',
      siteName: 'Piraeus Port',
      customerName: 'Acme',
    })
    const customer = entity({
      id: 'c',
      kind: 'customer',
      name: 'Acme',
      detail: '3 sites',
      status: 'healthy',
      customerName: 'Acme',
    })
    expect(site).toMatchObject({ group: 'sites', prose: true, subtitle: 'site · 2 servers · Acme' })
    expect(customer).toMatchObject({ group: 'sites', prose: true, subtitle: 'customer · 3 sites' })
  })

  it('opens the entity it came from', () => {
    const open = vi.fn()
    const raw: EntityIndexItem = {
      id: '1',
      kind: 'target',
      name: 'wan',
      detail: '',
      status: 'warning',
    }
    entityItem(raw, open).run?.()
    expect(open).toHaveBeenCalledWith(raw)
  })

  it('maps every kind to the screen that owns it', () => {
    expect(
      (['server', 'container', 'target', 'device', 'site', 'customer'] as const).map(
        (kind) => screenOf(kind).path,
      ),
    ).toEqual(['/servers', '/docker', '/network', '/snmp', '/customers', '/customers'])
  })
})

describe('screenItems', () => {
  it('lists all eight screens with g-key hints', () => {
    const items = screenItems(vi.fn(), true)
    expect(items.map((item) => item.title)).toHaveLength(8)
    expect(items.find((item) => item.title === 'Servers')?.hint).toEqual(['g', 's'])
  })

  it('tags the screens whose feature the backend does not implement (not SNMP, which it supports), and only those', () => {
    const planned = screenItems(vi.fn(), true)
      .filter((item) => item.badge === 'plan')
      .map((item) => item.title)
    expect(planned).toEqual(['Topology', 'Alerts'])
  })

  it('drops the hints when single-key shortcuts are off', () => {
    expect(screenItems(vi.fn(), false).every((item) => item.hint === undefined)).toBe(true)
  })

  it('opens the screen it names', () => {
    const open = vi.fn()
    screenItems(open, true)[1]?.run?.()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'servers' }))
  })
})

describe('problemItems', () => {
  const critical = entity({ id: '1', kind: 'server', name: 'crit-server', status: 'critical' })
  const warning = entity({ id: '2', kind: 'container', name: 'warn-container', status: 'warning' })
  const unknown = entity({ id: '3', kind: 'container', name: 'unknown-box', status: 'unknown' })

  it('lists critical, then warning, then unknown, whatever the input order', () => {
    expect(problemItems([unknown, warning, critical]).map((item) => item.title)).toEqual([
      'crit-server',
      'warn-container',
      'unknown-box',
    ])
  })

  it('ranks and keeps an offline server as critical', () => {
    const offline = entity({
      id: '9',
      kind: 'server',
      name: 'pir-fs-01',
      status: 'critical',
      offline: true,
    })
    expect(problemItems([unknown, warning, offline]).map((item) => item.title)).toEqual([
      'pir-fs-01',
      'warn-container',
      'unknown-box',
    ])
    // Critical entities, offline or not, tie: the order they came in decides.
    expect(problemItems([critical, offline]).map((item) => item.title)).toEqual([
      'crit-server',
      'pir-fs-01',
    ])
    expect(problemItems([offline, critical]).map((item) => item.title)).toEqual([
      'pir-fs-01',
      'crit-server',
    ])
    expect(problemItems([offline])[0]).toMatchObject({ status: 'critical', offline: true })
  })

  it('leaves out healthy and idle entities', () => {
    const healthy = entity({ id: '4', kind: 'server', name: 'fine', status: 'healthy' })
    const idle = entity({ id: '5', kind: 'container', name: 'stopped', status: 'idle' })
    expect(problemItems([healthy, idle, critical])).toHaveLength(1)
  })

  it('lists an SNMP device that needs attention, but not sites and customers (roll-ups)', () => {
    const device = entity({ id: '6', kind: 'device', name: 'switch', status: 'critical' })
    const site = entity({ id: '7', kind: 'site', name: 'Site', status: 'critical' })
    const customer = entity({ id: '8', kind: 'customer', name: 'Customer', status: 'critical' })
    expect(problemItems([device, site, customer, warning]).map((item) => item.title)).toEqual([
      'switch',
      'warn-container',
    ])
  })

  it('lists a probe target that needs attention like a server or a container', () => {
    const target = entity({ id: '5', kind: 'target', name: 'wan', status: 'critical' })
    expect(problemItems([warning, target]).map((item) => item.title)).toEqual([
      'wan',
      'warn-container',
    ])
  })

  it('keeps the worst few and gives them ids that cannot collide with the entity list', () => {
    const many = Array.from({ length: PROBLEM_LIMIT + 3 }, (_, n) =>
      entity({ id: String(n), kind: 'server', name: `server-${n}`, status: 'warning' }),
    )
    const problems = problemItems(many)
    expect(problems).toHaveLength(PROBLEM_LIMIT)
    expect(problems.every((item) => item.group === 'problems')).toBe(true)
    expect(problems[0]?.id).toBe('problem:server:0')
  })
})

describe('buildGroups with an empty query', () => {
  const entities = [
    entity({ id: '1', kind: 'server', name: 'fine', status: 'healthy' }),
    entity({ id: '2', kind: 'server', name: 'broken', status: 'critical' }),
  ]

  it('lists the groups of the scope in a fixed order and omits the empty ones', () => {
    expect(ids(buildGroups(source({ entities }), query('')))).toEqual([
      ['problems', ['broken']],
      ['go-to', expect.arrayContaining(['Overview', 'Alerts'])],
      ['actions', ['Refresh now']],
      ['planned', ['Acknowledge alert']],
    ])
  })

  it('has no problems group when nothing needs attention', () => {
    const groups = buildGroups(source({ entities: [entities[0] as PaletteItem] }), query(''))
    expect(groups.map((group) => group.id)).toEqual(['go-to', 'actions', 'planned'])
  })

  it('lists each scope its own groups', () => {
    const groupIds = (scope: Scope) =>
      buildGroups(source({ entities, sites: [] }), query('', scope)).map((group) => group.id)
    expect(groupIds('goto')).toEqual(['go-to'])
    expect(groupIds('actions')).toEqual(['actions', 'planned'])
    expect(groupIds('entities')).toEqual(['entities'])
    expect(groupIds('help')).toEqual(['help'])
    expect(groupIds('sites')).toEqual([])
  })

  it('lists entities worst first when browsing them', () => {
    const groups = buildGroups(source({ entities }), query('', 'entities'))
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['broken', 'fine'])
  })

  it('caps a group so the whole fleet is never rendered', () => {
    const fleet = Array.from({ length: GROUP_LIMIT + 20 }, (_, n) =>
      entity({ id: String(n), kind: 'server', name: `server-${n}`, status: 'healthy' }),
    )
    const groups = buildGroups(source({ entities: fleet }), query('', 'entities'))
    expect(groups[0]?.items).toHaveLength(GROUP_LIMIT)
  })
})

describe('buildGroups with text', () => {
  it('breaks equal scores by severity: ed lists edge-gw-02 (critical) before edge-gw-01 (healthy)', () => {
    const entities = [
      entity({ id: '1', kind: 'server', name: 'edge-gw-01', status: 'healthy' }),
      entity({ id: '2', kind: 'server', name: 'edge-gw-02', status: 'critical' }),
      entity({ id: '3', kind: 'server', name: 'edge-gw-03', status: 'warning' }),
    ]
    const [group] = buildGroups(source({ entities }), query('ed', 'entities'))
    expect(group?.items.map((item) => item.title)).toEqual([
      'edge-gw-02',
      'edge-gw-03',
      'edge-gw-01',
    ])
  })

  it('ranks a better match above a worse one regardless of severity', () => {
    const entities = [
      entity({ id: '1', kind: 'server', name: 'fed-core', status: 'critical' }),
      entity({ id: '2', kind: 'server', name: 'edge-gw-01', status: 'healthy' }),
    ]
    const [group] = buildGroups(source({ entities }), query('ed', 'entities'))
    expect(group?.items.map((item) => item.title)).toEqual(['edge-gw-01', 'fed-core'])
  })

  it('matches detail, site and customer, but ranks a name match above them', () => {
    const entities = [
      entity({
        id: '1',
        kind: 'server',
        name: 'alpha',
        detail: 'host 10.9.9.9',
        status: 'healthy',
        siteName: 'Piraeus',
        customerName: 'Acme',
      }),
      entity({ id: '2', kind: 'server', name: 'piraeus-gw', status: 'healthy' }),
    ]
    const titles = (text: string) =>
      buildGroups(source({ entities }), query(text, 'entities'))[0]?.items.map((i) => i.title)
    expect(titles('10.9')).toEqual(['alpha'])
    expect(titles('acme')).toEqual(['alpha'])
    expect(titles('piraeus')).toEqual(['piraeus-gw', 'alpha'])
  })

  it('puts the group with the best match first', () => {
    const entities = [entity({ id: '1', kind: 'server', name: 'refresher', status: 'healthy' })]
    const exact = buildGroups(source({ entities }), query('refresh now'))
    expect(exact.map((group) => group.id)[0]).toBe('actions')
    const entityFirst = buildGroups(source({ entities }), query('refresher'))
    expect(entityFirst.map((group) => group.id)[0]).toBe('entities')
  })

  it('searches only the scope it is given', () => {
    const entities = [entity({ id: '1', kind: 'server', name: 'servers-gw', status: 'healthy' })]
    expect(buildGroups(source({ entities }), query('serv', 'goto')).map((g) => g.id)).toEqual([
      'go-to',
    ])
    expect(buildGroups(source({ entities }), query('serv', 'entities')).map((g) => g.id)).toEqual([
      'entities',
    ])
  })

  it('includes disabled planned items, so they can be found and explained', () => {
    const groups = buildGroups(source(), query('acknowledge'))
    expect(ids(groups)).toEqual([['planned', ['Acknowledge alert']]])
    expect(groups[0]?.items[0]?.run).toBeNull()
  })

  it('finds an action through its keywords', () => {
    const groups = buildGroups(
      source({ actions: [action('a', 'Next time range', ['window'])] }),
      query('window'),
    )
    expect(ids(groups)).toEqual([['actions', ['Next time range']]])
  })

  it('returns nothing when nothing matches', () => {
    expect(buildGroups(source(), query('qqqqqq'))).toEqual([])
  })

  it('filters the help rows too', () => {
    const groups = buildGroups(source(), query('sites', 'help'))
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['Sites and customers'])
  })
})

describe('helpItems', () => {
  it('has one row per prefix, which types that prefix and keeps the palette open', () => {
    const choose = vi.fn()
    const rows = helpItems(choose)
    expect(rows.map((row) => row.hint)).toEqual([['>'], ['@'], ['#']])
    expect(rows.every((row) => row.keepOpen)).toBe(true)
    rows[1]?.run?.()
    expect(choose).toHaveBeenCalledWith('@')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../errors'
import { getTopology, includeList, parseTopology } from './topology'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (topology.py). */
type Raw = Record<string, unknown>
const node = (data: Raw) => ({ data })
const C = 'c0ffee00-0000-4000-8000-000000000001'
const S = 'c0ffee00-0000-4000-8000-000000000002'
const SRV = 'c0ffee00-0000-4000-8000-000000000003'
const T = 'c0ffee00-0000-4000-8000-000000000004'
const D = 'c0ffee00-0000-4000-8000-000000000005'
const LOOSE = 'c0ffee00-0000-4000-8000-000000000006'

const agent = {
  id: 'a1',
  name: 'ath-probe',
  version: '1.4.0',
  status: 'online',
  lastSeenAt: '2026-10-17T10:00:00+00:00',
}
const customer = node({ id: `customer:${C}`, kind: 'customer', label: 'Meridian', ref: C })
const site = node({
  id: `site:${S}`,
  kind: 'site',
  label: 'Athens DC',
  ref: S,
  parent: `customer:${C}`,
})
const server = (over: Raw = {}) =>
  node({
    id: `server:${SRV}`,
    kind: 'server',
    label: 'ath-probe-01',
    health: 'healthy',
    ref: SRV,
    agent,
    parent: `site:${S}`,
    ...over,
  })
const target = node({
  id: `target:${T}`,
  kind: 'target',
  label: 'gw-ath',
  health: 'critical',
  ref: T,
  parent: `site:${S}`,
})
const device = node({
  id: `device:${D}`,
  kind: 'device',
  label: 'ath-core-sw',
  health: 'warning',
  ref: D,
  parent: `site:${S}`,
})
const group = node({ id: 'group:unassigned', kind: 'group', label: 'No site', synthetic: true })
const loose = node({
  id: `server:${LOOSE}`,
  kind: 'server',
  label: 'lab-01',
  health: 'unknown',
  ref: LOOSE,
  agent: null,
  parent: 'group:unassigned',
})
const container = node({
  id: `container:${SRV}:abc123`,
  kind: 'container',
  label: 'pgbouncer',
  health: 'idle',
  ref: `${SRV}:abc123`,
  parent: `server:${SRV}`,
})
const iface = node({
  id: `interface:${D}:12`,
  kind: 'interface',
  label: 'Gi1/0/12',
  health: 'warning',
  ref: `${D}:12`,
  parent: `device:${D}`,
})
const probes = {
  data: {
    id: `monitors:target:${T}`,
    source: `server:${SRV}`,
    target: `target:${T}`,
    category: 'monitoring',
    kind: 'probes',
  },
}
const polls = {
  data: {
    id: `polls:device:${D}`,
    source: `server:${SRV}`,
    target: `device:${D}`,
    category: 'monitoring',
    kind: 'polls',
  },
}
const all = (n: number) => ({ visible: n, returned: n })

const answer = (over: Raw = {}): Raw => ({
  generatedAt: '2026-10-17T10:00:00+00:00',
  physicalLinksKnown: false,
  elements: { nodes: [customer, site, server(), target, device], edges: [probes, polls] },
  counts: { server: all(1), target: all(1), device: all(1), site: all(1), customer: all(1) },
  truncated: false,
  ...over,
})

const transport = (body: unknown) => {
  const get = vi.fn(async () => body)
  return { get, post: vi.fn() } as unknown as Transport & { get: typeof get }
}

const refused = (raw: unknown, include: Parameters<typeof parseTopology>[1] = []) => {
  try {
    parseTopology(raw, include)
  } catch (error) {
    return error instanceof ApiError && error.code === 'bad_response'
  }
  return false
}

describe('the topology contract', () => {
  it('maps every node and edge, keeping parents, health, refs and the agent', () => {
    const topology = parseTopology(answer())
    expect(topology.physicalLinksKnown).toBe(false)
    expect(topology.truncated).toBe(false)
    expect(topology.nodes.map((entry) => [entry.id, entry.kind, entry.parent])).toEqual([
      [`customer:${C}`, 'customer', null],
      [`site:${S}`, 'site', `customer:${C}`],
      [`server:${SRV}`, 'server', `site:${S}`],
      [`target:${T}`, 'target', `site:${S}`],
      [`device:${D}`, 'device', `site:${S}`],
    ])
    const [cust, , srv, tgt] = topology.nodes
    expect(cust).toMatchObject({ health: null, ref: C, agent: null, synthetic: false })
    expect(srv).toMatchObject({ health: 'healthy', ref: SRV, agent })
    expect(tgt?.health).toBe('critical')
    expect(topology.edges).toEqual([
      {
        id: `monitors:target:${T}`,
        source: `server:${SRV}`,
        target: `target:${T}`,
        kind: 'probes',
      },
      { id: `polls:device:${D}`, source: `server:${SRV}`, target: `device:${D}`, kind: 'polls' },
    ])
    expect(topology.counts.server).toEqual({ visible: 1, returned: 1 })
  })

  it('reads the optional kinds: the no-site group, a server without agent, containers, interfaces', () => {
    const topology = parseTopology(
      answer({
        elements: {
          nodes: [customer, site, server(), device, group, loose, container, iface],
          edges: [polls],
        },
        counts: {
          server: all(2),
          target: all(0),
          device: all(1),
          site: all(1),
          customer: all(1),
          container: all(1),
          interface: all(1),
          group: all(1),
        },
      }),
      ['containers', 'interfaces'],
    )
    const byId = new Map(topology.nodes.map((entry) => [entry.id, entry]))
    expect(byId.get('group:unassigned')).toMatchObject({
      kind: 'group',
      label: 'No site',
      synthetic: true,
      ref: null,
      health: null,
    })
    expect(byId.get(`server:${LOOSE}`)).toMatchObject({ agent: null, parent: 'group:unassigned' })
    expect(byId.get(`container:${SRV}:abc123`)?.parent).toBe(`server:${SRV}`)
    expect(byId.get(`interface:${D}:12`)?.parent).toBe(`device:${D}`)
  })

  it('reads an empty scope: no nodes, no edges', () => {
    const none = { visible: 0, returned: 0 }
    const topology = parseTopology(
      answer({
        elements: { nodes: [], edges: [] },
        counts: { server: none, target: none, device: none, site: none, customer: none },
      }),
    )
    expect(topology.nodes).toEqual([])
    expect(topology.edges).toEqual([])
  })

  it('reads a truncated answer with counts that say what was left out', () => {
    const topology = parseTopology(
      answer({
        elements: { nodes: [customer, site, target], edges: [] },
        counts: {
          server: { visible: 3, returned: 0 },
          target: { visible: 5, returned: 1 },
          device: { visible: 2, returned: 0 },
          site: all(1),
          customer: all(1),
        },
        truncated: true,
      }),
    )
    expect(topology.truncated).toBe(true)
    expect(topology.counts.target).toEqual({ visible: 5, returned: 1 })
  })

  describe('refuses a graph that does not hold together, rather than repairing it', () => {
    const withNodes = (nodes: unknown[], over: Raw = {}) =>
      answer({ elements: { nodes, edges: [] }, ...over })

    it.each([
      ['an unknown kind', [customer, site, node({ ...server().data, kind: 'router' })]],
      ['an id that is not its kind', [customer, site, server({ id: `device:${SRV}` })]],
      ['an id that is not its ref', [customer, site, server({ ref: 'other' })]],
      ['a parent that is not in the answer', [customer, server()]],
      ['a parent of a kind that cannot hold it', [customer, server({ parent: `customer:${C}` })]],
      ['a site with no customer', [node({ ...site.data, parent: undefined }), server()]],
      ['a health on a holder', [node({ ...customer.data, health: 'healthy' }), site, server()]],
      ['an entity without its health', [customer, site, server({ health: undefined })]],
      ['a health the console does not have', [customer, site, server({ health: 'offline' })]],
      [
        'a server that does not say whether it has an agent',
        [customer, site, server({ agent: undefined })],
      ],
      ['an agent on what is not a server', [customer, node({ ...site.data, agent }), server()]],
      ['the same id twice', [customer, site, server(), server()]],
    ])('%s', (_, nodes) => {
      expect(refused(withNodes(nodes))).toBe(true)
    })

    it('a group that is not the synthetic no-site group', () => {
      const fake = node({ id: 'group:other', kind: 'group', label: 'x', synthetic: true })
      const counts = { ...(answer().counts as Raw), group: all(1) }
      expect(refused(withNodes([customer, site, server(), target, device, fake], { counts }))).toBe(
        true,
      )
      const real = node({ ...group.data, synthetic: undefined })
      expect(refused(withNodes([customer, site, server(), target, device, real], { counts }))).toBe(
        true,
      )
    })

    it('a container on a server its id does not name', () => {
      const elsewhere = node({ ...container.data, parent: `server:${LOOSE}` })
      const nodes = [customer, site, server(), target, device, group, loose, elsewhere]
      const counts = {
        ...(answer().counts as Raw),
        server: all(2),
        container: all(1),
        group: all(1),
      }
      expect(refused(withNodes(nodes, { counts }), ['containers'])).toBe(true)
    })

    it('an interface whose ifIndex is not a number', () => {
      const bad = node({ ...iface.data, id: `interface:${D}:x`, ref: `${D}:x` })
      const counts = { ...(answer().counts as Raw), interface: all(1) }
      expect(
        refused(withNodes([customer, site, server(), target, device, bad], { counts }), [
          'interfaces',
        ]),
      ).toBe(true)
    })

    it.each([
      ['a category other than monitoring', { ...probes.data, category: 'physical' }],
      ['an edge kind the console does not have', { ...probes.data, kind: 'cabled' }],
      ['an end that is not in the answer', { ...probes.data, target: 'target:missing' }],
      ['a source that is not a server', { ...probes.data, source: `device:${D}` }],
      ['probes that end at a device', { ...probes.data, target: `device:${D}` }],
      ['polls that end at a target', { ...polls.data, target: `target:${T}` }],
      ['an edge id that is a node id', { ...probes.data, id: `site:${S}` }],
    ])('%s', (_, data) => {
      const raw = answer()
      const elements = raw.elements as Raw
      expect(refused({ ...raw, elements: { ...elements, edges: [{ data }] } })).toBe(true)
    })

    it('counts that disagree with the nodes, or with truncated', () => {
      const counts = answer().counts as Raw
      expect(refused(answer({ counts: { ...counts, server: all(2) } }))).toBe(true)
      expect(refused(answer({ counts: { ...counts, server: { visible: 0, returned: 1 } } }))).toBe(
        true,
      )
      expect(refused(answer({ truncated: true }))).toBe(true)
      expect(refused(answer({ counts: { ...counts, server: { visible: 9, returned: 1 } } }))).toBe(
        true,
      )
      const { site: _site, ...noSites } = counts
      expect(refused(answer({ counts: noSites }))).toBe(true)
      expect(refused(answer({ counts: { ...counts, router: all(0) } }))).toBe(true)
    })

    it('kinds that were not asked for, and asked-for kinds that are not counted', () => {
      const counts = { ...(answer().counts as Raw), container: all(1) }
      const raw = withNodes([customer, site, server(), target, device, container], { counts })
      expect(refused(raw)).toBe(true)
      expect(refused(raw, ['containers'])).toBe(false)
      expect(refused(answer(), ['interfaces'])).toBe(true)
    })

    it('a top level that is not the contract', () => {
      expect(refused(null)).toBe(true)
      expect(refused(answer({ elements: { nodes: [] } }))).toBe(true)
      expect(refused(answer({ physicalLinksKnown: 'no' }))).toBe(true)
      expect(refused(answer({ generatedAt: 'yesterday' }))).toBe(true)
    })
  })
})

describe('the topology request', () => {
  it('sends the scope, the kinds asked for (once each, in order) and the limit', async () => {
    const counts = {
      ...(answer().counts as Raw),
      container: all(0),
      interface: all(0),
    }
    const t = transport(answer({ counts }))
    const signal = new AbortController().signal
    await getTopology(t)({
      scope: { customerId: C, siteId: S },
      include: ['interfaces', 'containers', 'interfaces'],
      limit: 500,
      signal,
    })
    expect(t.get).toHaveBeenCalledWith('topology/', {
      signal,
      query: { customer: C, site: S, include: 'containers,interfaces', limit: '500' },
    })
  })

  it('sends nothing it was not given: the console API applies its defaults', async () => {
    const t = transport(answer())
    await getTopology(t)()
    expect(t.get).toHaveBeenCalledWith('topology/', {
      signal: undefined,
      query: { customer: undefined, site: undefined, include: undefined, limit: undefined },
    })
  })

  it('validates the answer against the kinds it asked for', async () => {
    await expect(
      getTopology(transport(answer()))({ include: ['containers'] }),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('passes an API error through untouched', async () => {
    const get = vi.fn(async () => {
      throw new ApiError('Not found.', 404, 'not_found')
    })
    const t = { get, post: vi.fn() } as unknown as Transport
    await expect(
      getTopology(t)({ scope: { customerId: 'hidden', siteId: null } }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('lists the kinds once each, in the API order', () => {
    expect(includeList(['interfaces', 'containers', 'containers'])).toEqual([
      'containers',
      'interfaces',
    ])
    expect(includeList()).toEqual([])
  })
})

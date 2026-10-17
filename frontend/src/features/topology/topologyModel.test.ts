import cytoscape from 'cytoscape'
import { describe, expect, it } from 'vitest'
import { graphStyle, nodeData, toElements, type GraphTokens } from './graph'
import { EDGES, NODES, node, topology } from './testing'
import { layoutPositions } from './topologyLayout'
import {
  DEFAULT_QUERY,
  detailLinkOf,
  dimmedIds,
  healthCounts,
  includeOf,
  parseQuery,
  sameShape,
  shortKinds,
  writeQuery,
} from './topologyModel'

const byId = (id: string) => NODES.find((entry) => entry.id === id)!

describe('the query in the URL', () => {
  it('defaults to no containers, no interfaces, 1000 nodes, nothing picked out, the map', () => {
    expect(parseQuery(new URLSearchParams())).toEqual(DEFAULT_QUERY)
    expect(includeOf(DEFAULT_QUERY)).toEqual([])
  })

  it('round-trips, writing only what differs from the default and keeping the scope', () => {
    const query = {
      containers: true,
      interfaces: true,
      limit: 250,
      health: 'critical',
      view: 'list',
    } as const
    const params = writeQuery(new URLSearchParams('customer=c1&site=s1'), query)
    expect(params.toString()).toBe(
      'customer=c1&site=s1&containers=1&interfaces=1&limit=250&health=critical&view=list',
    )
    expect(parseQuery(params)).toEqual(query)
    expect(includeOf(query)).toEqual(['containers', 'interfaces'])
    expect(writeQuery(params, DEFAULT_QUERY).toString()).toBe('customer=c1&site=s1')
  })

  it('ignores what it does not offer: an arbitrary limit, an unknown health', () => {
    const query = parseQuery(new URLSearchParams('limit=99999&health=offline&view=3d'))
    expect(query).toEqual(DEFAULT_QUERY)
  })
})

describe('detail links: only the screens that exist', () => {
  it.each([
    ['server:srv-1', { pathname: '/servers/srv-1' }],
    ['container:srv-1:abc123', { pathname: '/docker', extra: { focus: 'srv-1:abc123' } }],
    ['target:tgt-1', { pathname: '/network/tgt-1' }],
    ['device:dev-1', { pathname: '/snmp/dev-1' }],
    ['interface:dev-1:12', { pathname: '/snmp/dev-1' }],
  ])('%s opens %o', (id, expected) => {
    expect(detailLinkOf(byId(id))).toMatchObject(expected)
  })

  it.each(['customer:cus-1', 'site:site-ath', 'group:unassigned'])('%s has none', (id) => {
    expect(detailLinkOf(byId(id))).toBeNull()
  })
})

describe('picking out a health', () => {
  const graph = topology()

  it('dims every entity of another health, and nothing that only holds others', () => {
    const dimmed = dimmedIds(graph, 'critical')
    expect(dimmed.has('target:tgt-1')).toBe(false)
    expect(dimmed.has('server:srv-1')).toBe(true)
    expect(dimmed.has('device:dev-1')).toBe(true)
    for (const holder of ['customer:cus-1', 'site:site-ath', 'group:unassigned'])
      expect(dimmed.has(holder)).toBe(false)
    // An edge stays lit while one of its ends is.
    expect(dimmed.has('monitors:target:tgt-1')).toBe(false)
    expect(dimmed.has('polls:device:dev-1')).toBe(true)
  })

  it('keeps an entity lit when it holds a match: a healthy device around a down interface', () => {
    const dimmed = dimmedIds(graph, 'warning')
    expect(dimmed.has('interface:dev-1:12')).toBe(false)
    expect(dimmed.has('device:dev-1')).toBe(false)
    expect(dimmed.has('server:srv-1')).toBe(false)
    expect(dimmed.has('server:srv-lab')).toBe(true)
  })

  it('dims nothing for All, and counts the health of the nodes shown, as served', () => {
    expect(dimmedIds(graph, 'all').size).toBe(0)
    expect(healthCounts(graph)).toEqual({
      critical: 1,
      warning: 2,
      unknown: 1,
      idle: 0,
      healthy: 2,
    })
  })
})

describe('the shape of an answer', () => {
  it('is the same when only a health or the order changed, and not when a node came, went or moved', () => {
    const before = topology()
    const recoloured = topology({
      nodes: NODES.map((entry) =>
        entry.id === 'target:tgt-1' ? { ...entry, health: 'healthy' as const } : entry,
      ),
    })
    expect(sameShape(before, recoloured)).toBe(true)
    expect(
      sameShape(before, topology({ nodes: [...NODES].reverse(), edges: [...EDGES].reverse() })),
    ).toBe(true)
    const moved = NODES.map((entry) =>
      entry.id === 'server:srv-lab' ? { ...entry, parent: 'site:site-ath' } : entry,
    )
    expect(sameShape(before, topology({ nodes: moved }))).toBe(false)
    expect(sameShape(undefined, before)).toBe(false)
    expect(sameShape(before, topology({ nodes: NODES.slice(0, -1) }))).toBe(false)
    expect(sameShape(before, topology({ edges: EDGES.slice(1) }))).toBe(false)
  })

  it('names the kinds that were left out, and only those', () => {
    const partial = topology({
      counts: {
        ...topology().counts,
        server: { visible: 40, returned: 2 },
        container: { visible: 300, returned: 1 },
      },
      truncated: true,
    })
    expect(shortKinds(partial)).toEqual([
      { kind: 'server', visible: 40, returned: 2 },
      { kind: 'container', visible: 300, returned: 1 },
    ])
    expect(shortKinds(topology())).toEqual([])
  })
})

describe('the layout', () => {
  it('places every leaf, and leaves every holder to Cytoscape', () => {
    const positions = layoutPositions(NODES)
    const holders = new Set(NODES.flatMap((entry) => (entry.parent ? [entry.parent] : [])))
    for (const entry of NODES)
      expect(positions.has(entry.id), entry.id).toBe(!holders.has(entry.id))
    const points = [...positions.values()].map((point) => `${point.x},${point.y}`)
    expect(new Set(points).size).toBe(points.length)
  })

  it('is the same for the same graph, whatever the order and the health', () => {
    const shuffled = [...NODES]
      .reverse()
      .map((entry) => (entry.health === null ? entry : { ...entry, health: 'critical' as const }))
    expect(layoutPositions(shuffled)).toEqual(layoutPositions(NODES))
  })

  it('keeps what two sites hold apart', () => {
    const nodes = [
      node('customer', 'c', 'C', null),
      node('site', 'a', 'A', 'customer:c'),
      node('site', 'b', 'B', 'customer:c'),
      ...Array.from({ length: 9 }, (_, i) => node('server', `a${i}`, `a${i}`, 'site:a')),
      ...Array.from({ length: 4 }, (_, i) => node('target', `b${i}`, `b${i}`, 'site:b')),
    ]
    const positions = layoutPositions(nodes)
    const box = (site: string) => {
      const points = nodes
        .filter((entry) => entry.parent === site)
        .map((entry) => positions.get(entry.id)!)
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      return {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
      }
    }
    const a = box('site:a')
    const b = box('site:b')
    const apart = a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top
    expect(apart).toBe(true)
  })
})

describe('the Cytoscape graph', () => {
  const graph = topology()
  const cy = cytoscape({
    headless: true,
    elements: toElements(graph, layoutPositions(graph.nodes)),
  })

  it('makes every parent a compound parent, not an edge', () => {
    expect(cy.getElementById('server:srv-1').parent().first().id()).toBe('site:site-ath')
    expect(cy.getElementById('site:site-ath').parent().first().id()).toBe('customer:cus-1')
    expect(cy.getElementById('container:srv-1:abc123').parent().first().id()).toBe('server:srv-1')
    expect(cy.getElementById('interface:dev-1:12').parent().first().id()).toBe('device:dev-1')
    expect(cy.getElementById('server:srv-lab').parent().first().id()).toBe('group:unassigned')
    expect(cy.getElementById('customer:cus-1').isParent()).toBe(true)
    expect(cy.nodes()).toHaveLength(NODES.length)
  })

  it('draws only the monitoring edges, from the measuring server, labelled with what they mean', () => {
    expect(cy.edges()).toHaveLength(2)
    expect(
      cy.edges().map((entry) => [entry.source().id(), entry.target().id(), entry.data('display')]),
    ).toEqual([
      ['server:srv-1', 'target:tgt-1', 'Probes'],
      ['server:srv-1', 'device:dev-1', 'Polls'],
    ])
  })

  it('writes the API health under an entity’s name, and nothing under a holder’s', () => {
    expect(nodeData(byId('target:tgt-1'))).toMatchObject({
      display: 'gw-ath\nCRIT',
      health: 'critical',
    })
    expect(nodeData(byId('device:dev-1')).display).toBe('ath-core-sw\nOK')
    expect(nodeData(byId('site:site-ath'))).toMatchObject({ display: 'Athens DC', health: 'none' })
    expect(
      nodeData(node('server', 'x', 'a-very-long-server-name-that-goes-on', 'site:s')).display,
    ).toBe('a-very-long-server-name-t…\nOK')
  })

  it('draws an edge dashed: monitoring, not a solid network link', () => {
    const tokens = {
      health: { healthy: 'h', warning: 'w', critical: 'c', unknown: 'u', idle: 'i' },
    } as unknown as GraphTokens
    const edgeStyle = graphStyle(tokens).find(
      (block) => 'selector' in block && block.selector === 'edge',
    )
    expect(edgeStyle && 'style' in edgeStyle ? edgeStyle.style : null).toMatchObject({
      'line-style': 'dashed',
      label: 'data(display)',
    })
  })
})

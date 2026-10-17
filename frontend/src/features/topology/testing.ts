import type {
  Topology,
  TopologyAgent,
  TopologyCount,
  TopologyEdge,
  TopologyNode,
  TopologyNodeKind,
} from '@/api/types'

/** Fixtures for the Topology tests, in the shapes the console API's answer maps onto. Tests only. */

export const NOW = Date.parse('2026-10-17T10:00:00Z')

export const agent = (over: Partial<TopologyAgent> = {}): TopologyAgent => ({
  id: 'agent-1',
  name: 'ath-probe',
  version: '1.4.0',
  status: 'online',
  lastSeenAt: new Date(NOW - 30_000).toISOString(),
  ...over,
})

export function node(
  kind: TopologyNodeKind,
  ref: string,
  label: string,
  parent: string | null,
  over: Partial<TopologyNode> = {},
): TopologyNode {
  const holder = kind === 'customer' || kind === 'site' || kind === 'group'
  return {
    id: kind === 'group' ? 'group:unassigned' : `${kind}:${ref}`,
    kind,
    label,
    parent,
    health: holder ? null : 'healthy',
    ref: kind === 'group' ? null : ref,
    agent: kind === 'server' ? agent() : null,
    synthetic: kind === 'group',
    ...over,
  }
}

export const edge = (
  kind: TopologyEdge['kind'],
  server: string,
  measured: string,
): TopologyEdge => ({
  id: `${kind === 'probes' ? 'monitors' : 'polls'}:${measured}`,
  source: server,
  target: measured,
  kind,
})

/**
 * One customer with a site, a server on it that probes a target and polls a device (an interface
 * down on the device, the device itself healthy), a container on the server, and a server on no site.
 */
export const NODES: TopologyNode[] = [
  node('customer', 'cus-1', 'Meridian', null),
  node('site', 'site-ath', 'Athens DC', 'customer:cus-1'),
  node('group', '', 'No site', null),
  node('server', 'srv-1', 'ath-probe-01', 'site:site-ath'),
  node('server', 'srv-lab', 'lab-01', 'group:unassigned', { health: 'unknown', agent: null }),
  node('target', 'tgt-1', 'gw-ath', 'site:site-ath', { health: 'critical' }),
  node('device', 'dev-1', 'ath-core-sw', 'site:site-ath'),
  node('container', 'srv-1:abc123', 'pgbouncer', 'server:srv-1', { health: 'warning' }),
  node('interface', 'dev-1:12', 'Gi1/0/12', 'device:dev-1', { health: 'warning' }),
]

export const EDGES: TopologyEdge[] = [
  edge('probes', 'server:srv-1', 'target:tgt-1'),
  edge('polls', 'server:srv-1', 'device:dev-1'),
]

const tally = (nodes: readonly TopologyNode[]) => {
  const counts: Partial<Record<TopologyNodeKind, TopologyCount>> = {}
  for (const entry of nodes) {
    const count = counts[entry.kind] ?? { visible: 0, returned: 0 }
    counts[entry.kind] = { visible: count.visible + 1, returned: count.returned + 1 }
  }
  return counts
}

export function topology(over: Partial<Topology> = {}): Topology {
  const nodes = over.nodes ?? NODES
  return {
    generatedAt: new Date(NOW).toISOString(),
    physicalLinksKnown: false,
    nodes,
    edges: EDGES,
    counts: tally(nodes),
    truncated: false,
    ...over,
  }
}

export const EMPTY: Topology = topology({
  nodes: [],
  edges: [],
  counts: {
    customer: { visible: 0, returned: 0 },
    site: { visible: 0, returned: 0 },
    server: { visible: 0, returned: 0 },
    target: { visible: 0, returned: 0 },
    device: { visible: 0, returned: 0 },
  },
})

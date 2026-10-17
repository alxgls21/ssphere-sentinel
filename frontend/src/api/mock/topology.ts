import type {
  HealthStatus,
  Topology,
  TopologyAgent,
  TopologyCount,
  TopologyNode,
  TopologyNodeKind,
  TopologyOptions,
} from '../types'
import type { Fleet } from './fixtures'
import { containerHealthOf, serverHealthOf } from './lookup'
import { toIso } from './time'

/**
 * The sample fleet as the console API's topology answer, by the same rules: customers, sites,
 * servers (and their containers when asked for), each node with its ancestors, worst health first
 * up to the limit. The sample fleet monitors no network targets or SNMP devices, so it has no
 * monitoring edges.
 */

const UNASSIGNED = 'group:unassigned'
const RANK: Record<HealthStatus, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  idle: 3,
  healthy: 4,
}
const KIND_ORDER: Partial<Record<TopologyNodeKind, number>> = { server: 0, container: 3 }

function agentOf(server: Fleet['servers'][number]): TopologyAgent {
  return {
    id: `agt-${server.id}`,
    name: server.hostname,
    version: server.agentVersion || null,
    status:
      server.lastSeenAt === null ? 'unknown' : server.status === 'offline' ? 'offline' : 'online',
    lastSeenAt: server.lastSeenAt,
  }
}

const node = (
  id: string,
  kind: TopologyNodeKind,
  label: string,
  parent: string | null,
  over: Partial<TopologyNode> = {},
): TopologyNode => ({
  id,
  kind,
  label,
  parent,
  health: null,
  ref: id.slice(kind.length + 1),
  agent: null,
  synthetic: false,
  ...over,
})

export function mockTopology(fleet: Fleet, now: number, options: TopologyOptions = {}): Topology {
  const limit = options.limit ?? 2000
  const withContainers = options.include?.includes('containers') ?? false
  const withInterfaces = options.include?.includes('interfaces') ?? false

  const offered = new Map<string, TopologyNode>()
  const candidates: { rank: number; order: number; label: string; id: string }[] = []
  const offer = (entry: TopologyNode) => {
    offered.set(entry.id, entry)
    if (entry.health !== null) {
      candidates.push({
        rank: RANK[entry.health],
        order: KIND_ORDER[entry.kind] ?? 9,
        label: entry.label.toLowerCase(),
        id: entry.id,
      })
    }
  }

  for (const customer of fleet.customers) {
    offer(node(`customer:${customer.id}`, 'customer', customer.name, null))
  }
  for (const site of fleet.sites) {
    offer(node(`site:${site.id}`, 'site', site.name, `customer:${site.customerId}`))
  }
  if (fleet.servers.some((server) => server.siteId === null)) {
    offer(node(UNASSIGNED, 'group', 'No site', null, { ref: null, synthetic: true }))
  }
  for (const server of fleet.servers) {
    offer(
      node(
        `server:${server.id}`,
        'server',
        server.name,
        server.siteId === null ? UNASSIGNED : `site:${server.siteId}`,
        { health: serverHealthOf(server), agent: agentOf(server) },
      ),
    )
  }
  if (withContainers) {
    for (const container of fleet.containers) {
      offer(
        node(
          `container:${container.serverId}:${container.id}`,
          'container',
          container.name,
          `server:${container.serverId}`,
          { health: containerHealthOf(container) },
        ),
      )
    }
  }

  const chosen = new Map<string, TopologyNode>()
  const take = (id: string) => {
    const missing: TopologyNode[] = []
    let current: string | null = id
    while (current !== null && !chosen.has(current)) {
      const entry = offered.get(current)
      if (!entry) return
      missing.unshift(entry)
      current = entry.parent
    }
    if (chosen.size + missing.length > limit) return
    for (const entry of missing) chosen.set(entry.id, entry)
  }
  candidates
    .sort((a, b) => a.rank - b.rank || a.order - b.order || a.label.localeCompare(b.label))
    .forEach((candidate) => take(candidate.id))
  for (const entry of offered.values()) if (entry.kind === 'site') take(entry.id)
  for (const entry of offered.values()) if (entry.kind === 'customer') take(entry.id)

  const nodes = [...chosen.values()]
  const tally = (kind: TopologyNodeKind): TopologyCount => ({
    visible: [...offered.values()].filter((entry) => entry.kind === kind).length,
    returned: nodes.filter((entry) => entry.kind === kind).length,
  })
  const counts: Partial<Record<TopologyNodeKind, TopologyCount>> = {
    customer: tally('customer'),
    site: tally('site'),
    server: tally('server'),
    target: { visible: 0, returned: 0 },
    device: { visible: 0, returned: 0 },
    ...(withContainers ? { container: tally('container') } : {}),
    ...(withInterfaces ? { interface: { visible: 0, returned: 0 } } : {}),
    ...(offered.has(UNASSIGNED) ? { group: tally('group') } : {}),
  }
  return {
    generatedAt: toIso(now),
    physicalLinksKnown: false,
    nodes,
    edges: [],
    counts,
    truncated: Object.values(counts).some((count) => count.returned < count.visible),
  }
}

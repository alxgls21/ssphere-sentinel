import type {
  HealthStatus,
  Topology,
  TopologyInclude,
  TopologyNode,
  TopologyNodeKind,
} from '@/api/types'

/**
 * What the Topology screen asks for and how it reads the answer. Everything here is the console
 * API's: the nodes, their parents, their health and the monitoring edges are drawn as served, and
 * nothing is inferred, completed or recomputed.
 */

export interface TopologyQuery {
  containers: boolean
  interfaces: boolean
  limit: number
  /** Health to pick out on the map: the rest is dimmed, never removed. */
  health: HealthStatus | 'all'
  view: 'map' | 'list'
}

/** Node limits on offer. The console API takes 1 to 5000; a map past 2000 is unreadable. */
export const LIMITS: readonly number[] = [250, 500, 1000, 2000]
export const DEFAULT_LIMIT = 1000

export const DEFAULT_QUERY: TopologyQuery = {
  containers: false,
  interfaces: false,
  limit: DEFAULT_LIMIT,
  health: 'all',
  view: 'map',
}

export const HEALTH_FILTERS: readonly (HealthStatus | 'all')[] = [
  'all',
  'critical',
  'warning',
  'unknown',
  'idle',
  'healthy',
]

export const HEALTH_FILTER_LABEL: Record<HealthStatus | 'all', string> = {
  all: 'All',
  critical: 'Critical',
  warning: 'Warning',
  unknown: 'Unknown',
  idle: 'Idle',
  healthy: 'Healthy',
}

export function parseQuery(params: URLSearchParams): TopologyQuery {
  const limit = Number(params.get('limit'))
  const health = params.get('health')
  return {
    containers: params.get('containers') === '1',
    interfaces: params.get('interfaces') === '1',
    limit: LIMITS.includes(limit) ? limit : DEFAULT_LIMIT,
    health: HEALTH_FILTERS.includes(health as HealthStatus) ? (health as HealthStatus) : 'all',
    view: params.get('view') === 'list' ? 'list' : 'map',
  }
}

export function writeQuery(prev: URLSearchParams, query: TopologyQuery): URLSearchParams {
  const params = new URLSearchParams(prev)
  const set = (key: string, value: string, isDefault: boolean) => {
    if (isDefault) params.delete(key)
    else params.set(key, value)
  }
  set('containers', '1', !query.containers)
  set('interfaces', '1', !query.interfaces)
  set('limit', String(query.limit), query.limit === DEFAULT_LIMIT)
  set('health', query.health, query.health === 'all')
  set('view', query.view, query.view === 'map')
  return params
}

export const includeOf = (query: TopologyQuery): TopologyInclude[] => [
  ...(query.containers ? (['containers'] as const) : []),
  ...(query.interfaces ? (['interfaces'] as const) : []),
]

export const KIND_LABEL: Record<TopologyNodeKind, string> = {
  customer: 'Customer',
  site: 'Site',
  group: 'No site',
  server: 'Server',
  container: 'Container',
  target: 'Network target',
  device: 'SNMP device',
  interface: 'Interface',
}

export const KIND_PLURAL: Record<TopologyNodeKind, string> = {
  customer: 'customers',
  site: 'sites',
  group: 'no-site groups',
  server: 'servers',
  container: 'containers',
  target: 'network targets',
  device: 'SNMP devices',
  interface: 'interfaces',
}

/** The order the counts are listed in: what holds, then what is monitored. */
export const COUNT_ORDER: readonly TopologyNodeKind[] = [
  'customer',
  'site',
  'server',
  'container',
  'target',
  'device',
  'interface',
  'group',
]

/** What an edge of each kind says, on the map and in words. */
export const EDGE_LABEL = { probes: 'Probes', polls: 'Polls' } as const

/**
 * The screen of its own that a node opens, by the routes that exist: a server's page, a target's,
 * a device's (an interface's too: it is listed there), the Docker list pointed at a container.
 * Customers, sites and the group have none.
 */
export function detailLinkOf(
  node: TopologyNode,
): { pathname: string; extra?: Record<string, string>; label: string } | null {
  if (node.ref === null) return null
  const id = encodeURIComponent
  switch (node.kind) {
    case 'server':
      return { pathname: `/servers/${id(node.ref)}`, label: 'Open server' }
    case 'container':
      return { pathname: '/docker', extra: { focus: node.ref }, label: 'Open in Docker' }
    case 'target':
      return { pathname: `/network/${id(node.ref)}`, label: 'Open network target' }
    case 'device':
      return { pathname: `/snmp/${id(node.ref)}`, label: 'Open SNMP device' }
    case 'interface': {
      const device = node.ref.slice(0, node.ref.indexOf(':'))
      return { pathname: `/snmp/${id(device)}`, label: 'Open its device' }
    }
    default:
      return null
  }
}

/** The ifIndex an interface node names. */
export const ifIndexOf = (node: TopologyNode): string | null =>
  node.kind === 'interface' && node.ref !== null ? node.ref.slice(node.ref.indexOf(':') + 1) : null

/** Of the returned nodes with a health, how many have each: what the map shows, not the scope. */
export function healthCounts(topology: Topology): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = {
    critical: 0,
    warning: 0,
    unknown: 0,
    idle: 0,
    healthy: 0,
  }
  for (const node of topology.nodes) if (node.health !== null) counts[node.health] += 1
  return counts
}

/** The kinds the answer left some of out: what the truncation notice names. */
export function shortKinds(topology: Topology) {
  return COUNT_ORDER.flatMap((kind) => {
    const count = topology.counts[kind]
    return count && count.returned < count.visible ? [{ kind, ...count }] : []
  })
}

/** The nodes a node holds, by id, in the answer's order. */
export function childrenOf(topology: Topology): Map<string | null, TopologyNode[]> {
  const children = new Map<string | null, TopologyNode[]>()
  for (const node of topology.nodes) {
    const list = children.get(node.parent)
    if (list) list.push(node)
    else children.set(node.parent, [node])
  }
  return children
}

/** The monitored entities in the answer: the nodes that are not only holders. */
export const entityCount = (topology: Topology): number =>
  topology.nodes.filter((node) => node.health !== null).length

/**
 * Same nodes and edges (by id and parent), in any order: the graph can be updated in place, not
 * laid out again. The console API orders nodes worst first, so a status change reorders them.
 */
export function sameShape(a: Topology | undefined, b: Topology): boolean {
  if (!a || a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  const parents = new Map(a.nodes.map((node) => [node.id, node.parent]))
  for (const node of b.nodes) {
    if (!parents.has(node.id) || parents.get(node.id) !== node.parent) return false
  }
  const edges = new Set(a.edges.map((edge) => edge.id))
  return b.edges.every((edge) => edges.has(edge.id))
}

/**
 * What the health highlight dims: every entity of another health, unless it holds one that matches
 * (a server whose container matches stays lit around it). Holders without a health are never
 * dimmed, and nothing is removed: the map keeps every node it was given.
 */
export function dimmedIds(topology: Topology, highlight: HealthStatus | 'all'): Set<string> {
  const dimmed = new Set<string>()
  if (highlight === 'all') return dimmed
  const parentOf = new Map(topology.nodes.map((node) => [node.id, node.parent]))
  const lit = new Set<string>()
  for (const node of topology.nodes) {
    if (node.health !== highlight) continue
    for (
      let id: string | null = node.id;
      id !== null && !lit.has(id);
      id = parentOf.get(id) ?? null
    ) {
      lit.add(id)
    }
  }
  for (const node of topology.nodes) {
    if (node.health !== null && !lit.has(node.id)) dimmed.add(node.id)
  }
  for (const edge of topology.edges) {
    if (dimmed.has(edge.source) && dimmed.has(edge.target)) dimmed.add(edge.id)
  }
  return dimmed
}

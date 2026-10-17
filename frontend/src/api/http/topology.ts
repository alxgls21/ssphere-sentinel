import type { SentinelApi } from '../client'
import type {
  HealthStatus,
  Topology,
  TopologyAgent,
  TopologyCount,
  TopologyEdge,
  TopologyInclude,
  TopologyNode,
  TopologyNodeKind,
  TopologyOptions,
} from '../types'
import {
  array,
  bad,
  flag,
  nullableText,
  nullableTime,
  oneOf,
  record,
  text,
  time,
  whole,
} from './parse'
import type { Transport } from './transport'

/**
 * The console API's infrastructure graph (`topology/`). The answer is checked as a whole, not only
 * field by field: every id is its kind's, every parent is a node of the answer and of the kind that
 * can hold it, every monitoring edge runs from a server to a target or device of the answer, and
 * the counts agree with the nodes and with `truncated`. A graph that does not hold together is a
 * `bad_response` error: nothing is dropped, added or repaired to make it fit.
 */

const HEALTH: readonly HealthStatus[] = ['healthy', 'warning', 'critical', 'unknown', 'idle']
const KINDS: readonly TopologyNodeKind[] = [
  'customer',
  'site',
  'group',
  'server',
  'container',
  'target',
  'device',
  'interface',
]
const AGENT_STATUS: readonly TopologyAgent['status'][] = ['online', 'offline', 'unknown']
const EDGE_KINDS: readonly TopologyEdge['kind'][] = ['probes', 'polls']
const INCLUDES: readonly TopologyInclude[] = ['containers', 'interfaces']

/** The one synthetic node: what belongs to no site. */
export const UNASSIGNED_GROUP = 'group:unassigned'

/** The kinds a node of each kind may belong to; none for the outermost ones. */
const PARENT_KINDS: Record<TopologyNodeKind, readonly TopologyNodeKind[]> = {
  customer: [],
  group: [],
  site: ['customer'],
  server: ['site', 'group'],
  target: ['site', 'group'],
  device: ['site', 'group'],
  container: ['server'],
  interface: ['device'],
}

/** The kinds every answer counts; containers and interfaces only when asked for. */
const ALWAYS_COUNTED: readonly TopologyNodeKind[] = [
  'customer',
  'site',
  'server',
  'target',
  'device',
]
const COUNTED_WHEN: Record<TopologyInclude, TopologyNodeKind> = {
  containers: 'container',
  interfaces: 'interface',
}

/** The node a monitoring edge of each kind ends at. */
const MEASURES: Record<TopologyEdge['kind'], TopologyNodeKind> = {
  probes: 'target',
  polls: 'device',
}

const holdsOthersOnly = (kind: TopologyNodeKind) =>
  kind === 'customer' || kind === 'site' || kind === 'group'

function parseAgent(raw: unknown): TopologyAgent | null {
  if (raw === null) return null
  const row = record(raw)
  return {
    id: text(row.id),
    name: text(row.name),
    version: nullableText(row.version),
    status: oneOf(AGENT_STATUS, row.status),
    lastSeenAt: nullableTime(row.lastSeenAt),
  }
}

/** `<owner>:<rest>` refs (containers, interfaces): the owner's id, or a bad answer. */
function ownerOf(ref: string): [string, string] {
  const colon = ref.indexOf(':')
  if (colon <= 0 || colon === ref.length - 1) throw bad()
  return [ref.slice(0, colon), ref.slice(colon + 1)]
}

function parseNode(raw: unknown): TopologyNode {
  const row = record(record(raw).data)
  const id = text(row.id)
  const kind = oneOf(KINDS, row.kind)
  const label = text(row.label)
  const parent = row.parent === undefined ? null : text(row.parent)
  const synthetic = row.synthetic === undefined ? false : flag(row.synthetic)
  const holder = holdsOthersOnly(kind)
  // Health is the console's, on every monitored entity, and on nothing else.
  if (holder !== (row.health === undefined)) throw bad()
  const health = holder ? null : oneOf(HEALTH, row.health)
  // The agent is a server's, and every server says whether it has one.
  if ((kind === 'server') !== 'agent' in row) throw bad()
  const agent = kind === 'server' ? parseAgent(row.agent) : null

  let ref: string | null
  if (kind === 'group') {
    if (id !== UNASSIGNED_GROUP || !synthetic || row.ref !== undefined) throw bad()
    ref = null
  } else {
    ref = text(row.ref)
    if (synthetic || ref === '' || id !== `${kind}:${ref}`) throw bad()
  }
  // A container is on the server its id names; an interface on its device, by its ifIndex.
  if (ref !== null && (kind === 'container' || kind === 'interface')) {
    const [owner, rest] = ownerOf(ref)
    if (parent !== `${kind === 'container' ? 'server' : 'device'}:${owner}`) throw bad()
    if (kind === 'interface' && !/^\d+$/.test(rest)) throw bad()
  }
  return { id, kind, label, parent, health, ref, agent, synthetic }
}

function parseEdge(raw: unknown): TopologyEdge {
  const row = record(record(raw).data)
  if (row.category !== 'monitoring') throw bad()
  return {
    id: text(row.id),
    source: text(row.source),
    target: text(row.target),
    kind: oneOf(EDGE_KINDS, row.kind),
  }
}

function parseCount(raw: unknown): TopologyCount {
  const row = record(raw)
  const count = { visible: whole(row.visible), returned: whole(row.returned) }
  if (count.returned > count.visible) throw bad()
  return count
}

/** Validates the answer against the request it answers: `include` decides which kinds it may hold. */
export function parseTopology(raw: unknown, include: readonly TopologyInclude[] = []): Topology {
  const row = record(raw)
  const elements = record(row.elements)
  const nodes = array(elements.nodes).map(parseNode)
  const edges = array(elements.edges).map(parseEdge)
  const truncated = flag(row.truncated)

  // One id per element, nodes and edges together: Cytoscape keys both by it.
  const byId = new Map<string, TopologyNode>()
  for (const node of nodes) {
    if (byId.has(node.id)) throw bad()
    byId.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (byId.has(edge.id) || edgeIds.has(edge.id)) throw bad()
    edgeIds.add(edge.id)
  }

  for (const node of nodes) {
    const allowed = PARENT_KINDS[node.kind]
    if (node.parent === null) {
      if (allowed.length > 0) throw bad()
      continue
    }
    const parent = byId.get(node.parent)
    if (parent === undefined || !allowed.includes(parent.kind)) throw bad()
  }

  for (const edge of edges) {
    if (byId.get(edge.source)?.kind !== 'server') throw bad()
    if (byId.get(edge.target)?.kind !== MEASURES[edge.kind]) throw bad()
  }

  const rawCounts = record(row.counts)
  const counts: Partial<Record<TopologyNodeKind, TopologyCount>> = {}
  for (const [kind, value] of Object.entries(rawCounts)) {
    counts[oneOf(KINDS, kind)] = parseCount(value)
  }
  const expected = new Set<TopologyNodeKind>(ALWAYS_COUNTED)
  for (const asked of include) expected.add(COUNTED_WHEN[asked])
  for (const kind of expected) if (counts[kind] === undefined) throw bad()
  // Kinds beyond those: the "No site" group, and only it.
  for (const kind of Object.keys(counts) as TopologyNodeKind[]) {
    if (!expected.has(kind) && kind !== 'group') throw bad()
  }

  const returned = new Map<TopologyNodeKind, number>()
  for (const node of nodes) returned.set(node.kind, (returned.get(node.kind) ?? 0) + 1)
  for (const kind of KINDS) {
    const count = counts[kind]
    if ((count?.returned ?? 0) !== (returned.get(kind) ?? 0)) throw bad()
    if (count === undefined && returned.has(kind)) throw bad()
  }
  const short = Object.values(counts).some((count) => count.returned < count.visible)
  if (short !== truncated) throw bad()

  return {
    generatedAt: time(row.generatedAt),
    physicalLinksKnown: flag(row.physicalLinksKnown),
    nodes,
    edges,
    counts,
    truncated,
  }
}

/** The kinds asked for, once each, in the console API's order. */
export const includeList = (include: readonly TopologyInclude[] = []): TopologyInclude[] =>
  INCLUDES.filter((kind) => include.includes(kind))

export const getTopology =
  (transport: Transport): SentinelApi['getTopology'] =>
  async ({ scope, include, limit, signal }: TopologyOptions = {}) => {
    const asked = includeList(include)
    return parseTopology(
      await transport.get('topology/', {
        signal,
        query: {
          customer: scope?.customerId ?? undefined,
          site: scope?.siteId ?? undefined,
          include: asked.length > 0 ? asked.join(',') : undefined,
          limit: limit === undefined ? undefined : String(limit),
        },
      }),
      asked,
    )
  }

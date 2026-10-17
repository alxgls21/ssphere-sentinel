import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { Scope, Topology, TopologyAgent, TopologyEdge, TopologyNode } from '@/api/types'
import { useViewTo } from '@/app/viewSearch'
import { formatAge, formatInteger } from '@/lib/format'
import { Button } from '@/ui/controls'
import { EmptyState } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { EDGE_LABEL, KIND_LABEL, detailLinkOf, ifIndexOf } from './topologyModel'

const AGENT_TAG: Record<
  TopologyAgent['status'],
  { status: 'healthy' | 'offline' | 'unknown'; word: string }
> = {
  online: { status: 'healthy', word: 'ONLINE' },
  offline: { status: 'offline', word: 'OFFLINE' },
  unknown: { status: 'unknown', word: 'NEVER SEEN' },
}

const ago = (age: string) => (age === 'now' ? 'just now' : `${age} ago`)

interface TopologyDetailsProps {
  topology: Topology
  selected: string | null
  onSelect: (id: string | null) => void
  onScope: (scope: Scope) => void
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <dt className="type-label w-24 shrink-0 text-fg-faint">{term}</dt>
      <dd className="type-data min-w-0 flex-1 break-words text-fg">{children}</dd>
    </div>
  )
}

/** A node named by a button that selects it, or plain text when it is not on the map. */
function NodeRef({
  node,
  onSelect,
}: {
  node: TopologyNode | undefined
  onSelect: (id: string) => void
}) {
  if (!node) return <span className="text-fg-faint">not on the map</span>
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className="text-left text-primary underline-offset-2 hover:text-primary-hover hover:underline"
    >
      {node.label}
    </button>
  )
}

/**
 * What is selected, in words: its kind, its health as the console API judged it, where it belongs,
 * what monitors it or what it monitors, and the screen of its own when it has one. An edge says what
 * it is: monitoring responsibility, not a connection.
 */
export function TopologyDetails({ topology, selected, onSelect, onScope }: TopologyDetailsProps) {
  const viewTo = useViewTo()
  if (selected === null) {
    return (
      <EmptyState
        title="Nothing selected"
        hint="Select a node or a monitoring edge on the map, or a node in the list."
      />
    )
  }
  const byId = new Map(topology.nodes.map((node) => [node.id, node]))
  const node = byId.get(selected)
  const edge = node ? undefined : topology.edges.find((entry) => entry.id === selected)
  if (!node && !edge) {
    return (
      <EmptyState
        title="No longer on the map"
        hint="The latest answer from the console API does not include what was selected."
      />
    )
  }
  return node ? (
    <NodeDetails
      topology={topology}
      node={node}
      byId={byId}
      onSelect={onSelect}
      onScope={onScope}
      viewTo={viewTo}
    />
  ) : (
    <EdgeDetails edge={edge as TopologyEdge} byId={byId} onSelect={onSelect} />
  )
}

function EdgeDetails({
  edge,
  byId,
  onSelect,
}: {
  edge: TopologyEdge
  byId: Map<string, TopologyNode>
  onSelect: (id: string) => void
}) {
  const server = byId.get(edge.source)
  const measured = byId.get(edge.target)
  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <p className="type-label text-fg-faint">Monitoring edge</p>
        <h3 className="type-title text-fg">{EDGE_LABEL[edge.kind]}</h3>
      </div>
      <dl className="flex flex-col gap-1.5">
        <Row term="Server">
          <NodeRef node={server} onSelect={onSelect} />
        </Row>
        <Row term={edge.kind === 'probes' ? 'Target' : 'Device'}>
          <NodeRef node={measured} onSelect={onSelect} />
        </Row>
      </dl>
      <p className="type-body text-fg-muted">
        The agent on this server is the one assigned to{' '}
        {edge.kind === 'probes' ? 'probe this network target' : 'poll this SNMP device'}. The edge
        is monitoring responsibility, not a network connection: Sentinel records no cabling or
        routing, so it says nothing about how the two are linked.
      </p>
    </div>
  )
}

function NodeDetails({
  topology,
  node,
  byId,
  onSelect,
  onScope,
  viewTo,
}: {
  topology: Topology
  node: TopologyNode
  byId: Map<string, TopologyNode>
  onSelect: (id: string) => void
  onScope: (scope: Scope) => void
  viewTo: ReturnType<typeof useViewTo>
}) {
  const nowMs = Date.parse(topology.generatedAt)
  const path: TopologyNode[] = []
  for (let id = node.parent; id !== null;) {
    const parent = byId.get(id)
    if (!parent) break
    path.unshift(parent)
    id = parent.parent
  }
  const held = topology.nodes.filter((entry) => entry.parent === node.id).length
  const monitoredBy = topology.edges.filter((edge) => edge.target === node.id)
  const monitors = topology.edges.filter((edge) => edge.source === node.id)
  const link = detailLinkOf(node)
  const ifIndex = ifIndexOf(node)

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <p className="type-label text-fg-faint">{KIND_LABEL[node.kind]}</p>
        <h3 className="type-title break-words text-fg">{node.label}</h3>
        {node.health !== null ? (
          <StatusTag status={node.health} variant="tag" className="self-start" />
        ) : null}
      </div>
      <dl className="flex flex-col gap-1.5">
        {path.length > 0 ? (
          <Row term="In">
            {path.map((parent, i) => (
              <span key={parent.id}>
                {i > 0 ? ' › ' : null}
                <NodeRef node={parent} onSelect={onSelect} />
              </span>
            ))}
          </Row>
        ) : null}
        {ifIndex !== null ? <Row term="ifIndex">{ifIndex}</Row> : null}
        {node.kind === 'server' ? (
          node.agent ? (
            <>
              <Row term="Agent">{node.agent.name}</Row>
              <Row term="Agent state">
                <StatusTag
                  status={AGENT_TAG[node.agent.status].status}
                  word={AGENT_TAG[node.agent.status].word}
                />
              </Row>
              <Row term="Version">{node.agent.version ?? 'Not reported'}</Row>
              <Row term="Last seen">
                {node.agent.lastSeenAt === null
                  ? 'Never'
                  : ago(formatAge(node.agent.lastSeenAt, nowMs))}
              </Row>
            </>
          ) : (
            <Row term="Agent">None installed</Row>
          )
        ) : null}
        {monitoredBy.map((edge) => (
          <Row key={edge.id} term={edge.kind === 'probes' ? 'Probed by' : 'Polled by'}>
            <NodeRef node={byId.get(edge.source)} onSelect={onSelect} />
          </Row>
        ))}
        {monitors.length > 0 ? (
          <Row term="Its agent">
            probes {formatInteger(monitors.filter((edge) => edge.kind === 'probes').length)} targets
            and polls {formatInteger(monitors.filter((edge) => edge.kind === 'polls').length)}{' '}
            devices on the map
          </Row>
        ) : null}
        {held > 0 ? <Row term="Holds">{formatInteger(held)} on the map</Row> : null}
      </dl>
      {node.synthetic ? (
        <p className="type-body text-fg-muted">
          Not a site: it gathers the servers, targets and devices that are placed on no site.
        </p>
      ) : null}
      {(node.kind === 'target' || node.kind === 'device') && monitoredBy.length === 0 ? (
        <p className="type-body text-fg-muted">
          No assigned agent whose server is on this map: none is assigned, or its server is out of
          this scope, hidden from you or left out by the node limit.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {link ? (
          <Link
            to={viewTo(link.pathname, link.extra)}
            className="type-data text-primary underline-offset-2 hover:text-primary-hover hover:underline"
          >
            {link.label}
          </Link>
        ) : null}
        {node.kind === 'customer' && node.ref !== null ? (
          <Button size="sm" onClick={() => onScope({ customerId: node.ref, siteId: null })}>
            Narrow the scope to this customer
          </Button>
        ) : null}
        {node.kind === 'site' && node.ref !== null ? (
          <Button
            size="sm"
            onClick={() =>
              onScope({ customerId: byId.get(node.parent ?? '')?.ref ?? null, siteId: node.ref })
            }
          >
            Narrow the scope to this site
          </Button>
        ) : null}
      </div>
    </div>
  )
}

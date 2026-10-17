import type { ElementDefinition, StylesheetJson } from 'cytoscape'
import type { HealthStatus, Topology, TopologyEdge, TopologyNode } from '@/api/types'
import { STATUS_COLOR_VAR, STATUS_WORD } from '@/ui/status'
import { EDGE_LABEL } from './topologyModel'
import type { Point } from './topologyLayout'

/**
 * The topology as Cytoscape elements, and how they are drawn. A node's `parent` becomes a compound
 * parent, a box drawn around it, never an edge; the only edges are the monitoring ones, dashed and
 * labelled with what they mean. Health is the API's, drawn as the frame's color and written under
 * the name, so it never rests on color alone.
 */

/** Long names are cut on the map; the full name is in the details and the list. */
const LABEL_CHARS = 26

const clip = (label: string) =>
  label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label

export interface NodeData {
  id: string
  /** What the map writes: the name and, for an entity, its health word. */
  display: string
  kind: TopologyNode['kind']
  /** `none` for the nodes that only hold others. */
  health: HealthStatus | 'none'
  parent?: string
}

export interface EdgeData {
  id: string
  source: string
  target: string
  kind: TopologyEdge['kind']
  display: string
}

export function nodeData(node: TopologyNode): NodeData {
  return {
    id: node.id,
    display:
      node.health === null ? clip(node.label) : `${clip(node.label)}\n${STATUS_WORD[node.health]}`,
    kind: node.kind,
    health: node.health ?? 'none',
    ...(node.parent === null ? {} : { parent: node.parent }),
  }
}

export const edgeData = (edge: TopologyEdge): EdgeData => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  kind: edge.kind,
  display: EDGE_LABEL[edge.kind],
})

/** Nodes (holders first, as served) then edges; each leaf where the layout put it. */
export function toElements(
  topology: Topology,
  positions: ReadonlyMap<string, Point>,
): ElementDefinition[] {
  return [
    ...topology.nodes.map((node): ElementDefinition => {
      const position = positions.get(node.id)
      return {
        group: 'nodes',
        data: nodeData(node),
        ...(position ? { position: { ...position } } : {}),
      }
    }),
    ...topology.edges.map((edge): ElementDefinition => ({ group: 'edges', data: edgeData(edge) })),
  ]
}

export interface GraphTokens {
  health: Record<HealthStatus, string>
  panel: string
  raised: string
  border: string
  borderStrong: string
  fg: string
  fgMuted: string
  primary: string
  font: string
}

/** The design tokens, resolved now: a canvas cannot read custom properties itself. */
export function readGraphTokens(root: HTMLElement = document.documentElement): GraphTokens {
  const style = getComputedStyle(root)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    health: {
      healthy: read(STATUS_COLOR_VAR.healthy),
      warning: read(STATUS_COLOR_VAR.warning),
      critical: read(STATUS_COLOR_VAR.critical),
      unknown: read(STATUS_COLOR_VAR.unknown),
      idle: read(STATUS_COLOR_VAR.idle),
    },
    panel: read('--color-panel'),
    raised: read('--color-raised'),
    border: read('--color-border'),
    borderStrong: read('--color-border-strong'),
    fg: read('--color-fg'),
    fgMuted: read('--color-fg-muted'),
    primary: read('--color-primary'),
    // Cytoscape takes family names in double quotes only.
    font: read('--font-mono').replaceAll("'", '"'),
  }
}

/** Mark size by kind; the shape tells kinds apart, the frame's color and word tell health. */
const MARKS = [
  { kind: 'server', shape: 'round-rectangle', size: 30 },
  { kind: 'device', shape: 'hexagon', size: 30 },
  { kind: 'target', shape: 'diamond', size: 28 },
  { kind: 'container', shape: 'rectangle', size: 20 },
  { kind: 'interface', shape: 'ellipse', size: 16 },
] as const

export function graphStyle(tokens: GraphTokens): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(display)',
        'font-family': tokens.font,
        'font-size': 11,
        color: tokens.fg,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        'text-max-width': '156px',
        'background-color': tokens.raised,
        'border-width': 2,
        'border-color': tokens.borderStrong,
        shape: 'round-rectangle',
        width: 24,
        height: 24,
      },
    },
    ...MARKS.map(({ kind, shape, size }) => ({
      selector: `node[kind = "${kind}"]`,
      style: { shape, width: size, height: size },
    })),
    // Holders: a frame around what they hold, their name on top.
    {
      selector: ':parent',
      style: {
        shape: 'round-rectangle',
        'background-color': tokens.panel,
        'background-opacity': 0.6,
        'border-width': 1,
        'border-color': tokens.border,
        'text-valign': 'top',
        'text-margin-y': -4,
        color: tokens.fgMuted,
        padding: '20px',
      },
    },
    {
      selector: 'node[kind = "customer"]',
      style: { 'border-color': tokens.borderStrong, 'font-weight': 600, color: tokens.fg },
    },
    { selector: 'node[kind = "group"]', style: { 'border-style': 'dashed' } },
    // Health: the frame's color, a heavier frame for critical, a broken one for unknown.
    ...(['healthy', 'warning', 'critical', 'unknown', 'idle'] as const).map((health) => ({
      selector: `node[health = "${health}"]`,
      style: { 'border-color': tokens.health[health], 'border-width': 2 },
    })),
    { selector: 'node[health = "critical"]', style: { 'border-width': 3 } },
    { selector: 'node[health = "unknown"]', style: { 'border-style': 'dashed' } },
    { selector: 'node[health = "idle"]', style: { 'border-style': 'dotted' } },
    // Monitoring responsibility: dashed, labelled, from the measuring server to what it measures.
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-style': 'dashed',
        'line-dash-pattern': [6, 4],
        'line-color': tokens.primary,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': tokens.primary,
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        label: 'data(display)',
        'font-family': tokens.font,
        'font-size': 10,
        color: tokens.fgMuted,
        'text-background-color': tokens.panel,
        'text-background-opacity': 1,
        'text-background-padding': '2px',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'underlay-color': tokens.primary,
        'underlay-opacity': 0.35,
        'underlay-padding': 6,
      },
    },
    { selector: 'edge:selected', style: { width: 3 } },
    { selector: '.faded', style: { opacity: 0.2 } },
  ]
}

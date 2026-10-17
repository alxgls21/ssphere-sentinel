import type { Topology, TopologyNode } from '@/api/types'
import { cn } from '@/lib/cn'
import { StatusTag } from '@/ui/status'
import { KIND_LABEL, childrenOf } from './topologyModel'

interface TopologyOutlineProps {
  topology: Topology
  selected: string | null
  onSelect: (id: string) => void
}

/**
 * The map as nested lists, in the console API's order: every node under the one that holds it, each
 * a button that selects it, with its kind, its health in words and what monitors it. What a keyboard
 * or a screen reader walks through instead of the canvas.
 */
export function TopologyOutline({ topology, selected, onSelect }: TopologyOutlineProps) {
  const children = childrenOf(topology)
  const byId = new Map(topology.nodes.map((node) => [node.id, node]))
  const monitors = new Map<string, string[]>()
  for (const edge of topology.edges) {
    const server = byId.get(edge.source)?.label ?? edge.source
    const line = `${edge.kind === 'probes' ? 'Probed' : 'Polled'} by ${server}`
    monitors.set(edge.target, [...(monitors.get(edge.target) ?? []), line])
  }

  const branch = (nodes: readonly TopologyNode[], depth: number) => (
    <ul className={cn('flex flex-col', depth > 0 && 'ml-4 border-l border-border pl-2')}>
      {nodes.map((node) => {
        const held = children.get(node.id)
        return (
          <li key={node.id}>
            <button
              type="button"
              aria-current={selected === node.id ? 'true' : undefined}
              onClick={() => onSelect(node.id)}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left hover:bg-hover',
                selected === node.id && 'bg-primary-tint',
              )}
            >
              <span className="type-body min-w-0 truncate text-fg">{node.label}</span>
              <span className="type-label shrink-0 text-fg-faint">{KIND_LABEL[node.kind]}</span>
              {node.health !== null ? (
                <StatusTag status={node.health} className="ml-auto shrink-0" />
              ) : null}
            </button>
            {(monitors.get(node.id) ?? []).map((line) => (
              <p key={line} className="type-data ml-2 px-2 text-fg-faint">
                {line}
              </p>
            ))}
            {held ? branch(held, depth + 1) : null}
          </li>
        )
      })}
    </ul>
  )

  return (
    <section aria-label="Topology list" className="max-h-[40rem] overflow-auto p-2">
      {branch(children.get(null) ?? [], 0)}
    </section>
  )
}

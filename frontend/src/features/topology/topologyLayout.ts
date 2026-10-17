import type { TopologyNode, TopologyNodeKind } from '@/api/types'

/**
 * Where each node goes: every holder (customer, site, a server with containers, a device with
 * interfaces) is a box around what it holds, its leaves in a grid and its inner boxes packed in
 * rows. One pass over the nodes, and the same answer gives the same picture: positions follow kind
 * and name, never health, so a refresh that changes a status moves nothing. Only leaves get a
 * position; Cytoscape draws each holder around its children.
 */

export interface Point {
  x: number
  y: number
}

/** A leaf's cell: the mark and its label underneath. */
export const CELL_WIDTH = 168
export const CELL_HEIGHT = 76
/** Inside a holder's frame, and room for its label at the top. */
const PADDING = 24
const TITLE = 20
/** Between boxes side by side. */
const GAP = 40

const KIND_RANK: Record<TopologyNodeKind, number> = {
  customer: 0,
  group: 1,
  site: 2,
  server: 3,
  device: 4,
  target: 5,
  container: 6,
  interface: 7,
}

interface Box {
  width: number
  height: number
  place: (x: number, y: number, out: Map<string, Point>) => void
}

const byKindThenName = (a: TopologyNode, b: TopologyNode) =>
  KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
  a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) ||
  a.id.localeCompare(b.id)

function grid(leaves: readonly TopologyNode[]): Box {
  const columns = Math.max(1, Math.ceil(Math.sqrt(leaves.length * 1.5)))
  const rows = Math.ceil(leaves.length / columns)
  return {
    width: columns * CELL_WIDTH,
    height: rows * CELL_HEIGHT,
    place: (x, y, out) =>
      leaves.forEach((leaf, i) =>
        out.set(leaf.id, {
          x: x + (i % columns) * CELL_WIDTH + CELL_WIDTH / 2,
          y: y + Math.floor(i / columns) * CELL_HEIGHT + CELL_HEIGHT / 2,
        }),
      ),
  }
}

/** Boxes in rows about as wide as they are tall together. */
function shelves(boxes: readonly Box[]): Box {
  const area = boxes.reduce((sum, box) => sum + (box.width + GAP) * (box.height + GAP), 0)
  const target = Math.max(...boxes.map((box) => box.width), Math.sqrt(area) * 1.4)
  const rows: { boxes: Box[]; width: number; height: number }[] = []
  for (const box of boxes) {
    const row = rows.at(-1)
    if (row && row.width + GAP + box.width <= target) {
      row.boxes.push(box)
      row.width += GAP + box.width
      row.height = Math.max(row.height, box.height)
    } else {
      rows.push({ boxes: [box], width: box.width, height: box.height })
    }
  }
  return {
    width: Math.max(...rows.map((row) => row.width)),
    height: rows.reduce((sum, row) => sum + row.height, 0) + GAP * (rows.length - 1),
    place: (x, y, out) => {
      let top = y
      for (const row of rows) {
        let left = x
        for (const box of row.boxes) {
          box.place(left, top, out)
          left += box.width + GAP
        }
        top += row.height + GAP
      }
    },
  }
}

export function layoutPositions(nodes: readonly TopologyNode[]): Map<string, Point> {
  const children = new Map<string | null, TopologyNode[]>()
  for (const node of nodes) {
    const list = children.get(node.parent)
    if (list) list.push(node)
    else children.set(node.parent, [node])
  }

  const pack = (members: readonly TopologyNode[]): Box => {
    const sorted = [...members].sort(byKindThenName)
    const leaves = sorted.filter((node) => !children.has(node.id))
    const boxes = sorted.filter((node) => children.has(node.id)).map(holder)
    return shelves(leaves.length > 0 ? [grid(leaves), ...boxes] : boxes)
  }

  const holder = (node: TopologyNode): Box => {
    const inner = pack(children.get(node.id) ?? [])
    return {
      width: inner.width + 2 * PADDING,
      height: inner.height + 2 * PADDING + TITLE,
      place: (x, y, out) => inner.place(x + PADDING, y + PADDING + TITLE, out),
    }
  }

  const out = new Map<string, Point>()
  const roots = children.get(null) ?? []
  if (roots.length > 0) pack(roots).place(0, 0, out)
  return out
}

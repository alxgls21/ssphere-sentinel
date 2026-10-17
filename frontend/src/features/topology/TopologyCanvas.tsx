import cytoscape, { type Core, type EventObject } from 'cytoscape'
import { Maximize, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import type { HealthStatus, Topology } from '@/api/types'
import { IconButton } from '@/ui/controls'
import { graphStyle, nodeData, readGraphTokens, toElements } from './graph'
import { layoutPositions, type Point } from './topologyLayout'
import { dimmedIds, sameShape } from './topologyModel'

const FIT_PADDING = 32
const ZOOM_STEP = 1.25
const PAN_STEP = 80

interface TopologyCanvasProps {
  topology: Topology
  /** The selected node or edge id. */
  selected: string | null
  onSelect: (id: string | null) => void
  /** Health to pick out: every other entity is dimmed. */
  highlight: HealthStatus | 'all'
}

/**
 * The map: one Cytoscape instance for the life of the screen, destroyed with it. A new answer with
 * the same nodes and edges only updates their data (a status changed), so nothing moves under the
 * operator; a different graph replaces the elements and is laid out once. Selection and the health
 * highlight change classes, never the layout.
 */
export function TopologyCanvas({ topology, selected, onSelect, highlight }: TopologyCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const shownRef = useRef<Topology | undefined>(undefined)
  const positionsRef = useRef<Map<string, Point>>(new Map())
  const onSelectRef = useRef(onSelect)
  const selectedRef = useRef(selected)
  const helpId = useId()

  useEffect(() => {
    onSelectRef.current = onSelect
    selectedRef.current = selected
  }, [onSelect, selected])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const cy = cytoscape({
      container,
      style: graphStyle(readGraphTokens()),
      layout: { name: 'preset' },
      minZoom: 0.05,
      maxZoom: 3,
      boxSelectionEnabled: false,
      selectionType: 'single',
    })
    const pick = (event: EventObject) => onSelectRef.current(event.target.id())
    const clear = (event: EventObject) => {
      if (event.target === cy) onSelectRef.current(null)
    }
    cy.on('tap', 'node, edge', pick)
    cy.on('tap', clear)
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => cy.resize())
    observer?.observe(container)
    cyRef.current = cy
    return () => {
      observer?.disconnect()
      cy.removeListener('tap')
      cy.destroy()
      cyRef.current = null
      shownRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    if (sameShape(shownRef.current, topology)) {
      cy.batch(() => {
        for (const node of topology.nodes) cy.getElementById(node.id).data(nodeData(node))
      })
    } else {
      const positions = layoutPositions(topology.nodes)
      positionsRef.current = positions
      cy.batch(() => {
        cy.elements().remove()
        cy.add(toElements(topology, positions))
        if (selectedRef.current !== null) cy.getElementById(selectedRef.current).select()
      })
      cy.fit(undefined, FIT_PADDING)
    }
    shownRef.current = topology
  }, [topology])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.batch(() => {
      cy.elements(':selected').unselect()
      if (selected !== null) cy.getElementById(selected).select()
    })
  }, [selected])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const dimmed = dimmedIds(topology, highlight)
    cy.batch(() => {
      cy.elements().removeClass('faded')
      for (const id of dimmed) cy.getElementById(id).addClass('faded')
    })
  }, [highlight, topology])

  const zoomBy = (factor: number) => {
    const cy = cyRef.current
    if (!cy) return
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
    })
  }
  const fit = () => cyRef.current?.fit(undefined, FIT_PADDING)
  const resetLayout = () => {
    const cy = cyRef.current
    if (!cy) return
    const positions = positionsRef.current
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const position = positions.get(node.id())
        if (position && node.isChildless()) node.position({ ...position })
      })
    })
    cy.fit(undefined, FIT_PADDING)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cy = cyRef.current
    if (!cy || event.metaKey || event.ctrlKey || event.altKey) return
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    }
    const by = pan[event.key]
    if (by) cy.panBy({ x: by[0], y: by[1] })
    else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP)
    else if (event.key === '-') zoomBy(1 / ZOOM_STEP)
    else if (event.key === '0') fit()
    else if (event.key === 'Escape' && selected !== null) onSelect(null)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className="relative flex min-h-[24rem] w-full flex-1 flex-col">
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a canvas widget: its keys pan and zoom */}
      <div
        ref={containerRef}
        role="application"
        aria-roledescription="topology map"
        aria-label="Topology map"
        aria-describedby={helpId}
        // The canvas has no element to focus: this stop is how a keyboard reaches its pan and zoom.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="topology-canvas"
        className="min-h-0 w-full flex-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      />
      <p id={helpId} className="sr-only">
        Arrow keys pan, plus and minus zoom, 0 fits the map, Escape clears the selection. Every node
        is also in the list view, which a keyboard or screen reader can walk through.
      </p>
      <div
        role="toolbar"
        aria-label="Map view"
        className="absolute top-2 right-2 flex flex-col gap-1"
      >
        <IconButton
          aria-label="Zoom in"
          shortcut="+"
          icon={ZoomIn}
          onClick={() => zoomBy(ZOOM_STEP)}
        />
        <IconButton
          aria-label="Zoom out"
          shortcut="-"
          icon={ZoomOut}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        />
        <IconButton aria-label="Fit to view" shortcut="0" icon={Maximize} onClick={fit} />
        <IconButton aria-label="Reset layout" icon={RotateCcw} onClick={resetLayout} />
      </div>
    </div>
  )
}

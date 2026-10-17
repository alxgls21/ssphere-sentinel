import { describe, expect, it } from 'vitest'
import { parseTopology } from '../http/topology'
import type { Topology } from '../types'
import { createMockApi } from './client'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const api = () => createMockApi({ delayMs: 0, now: () => NOW })

/** The sample answer in the console API's wire shape, to hold it to the same contract. */
const wire = (topology: Topology) => ({
  generatedAt: topology.generatedAt,
  physicalLinksKnown: topology.physicalLinksKnown,
  elements: {
    nodes: topology.nodes.map(({ parent, health, ref, agent, synthetic, ...rest }) => ({
      data: {
        ...rest,
        ...(parent === null ? {} : { parent }),
        ...(health === null ? {} : { health }),
        ...(ref === null ? {} : { ref }),
        ...(rest.kind === 'server' ? { agent } : {}),
        ...(synthetic ? { synthetic } : {}),
      },
    })),
    edges: topology.edges.map((edge) => ({ data: { ...edge, category: 'monitoring' } })),
  },
  counts: topology.counts,
  truncated: topology.truncated,
})

describe('the sample topology (demo mode only)', () => {
  it('keeps the console API contract, with and without containers', async () => {
    const plain = await api().getTopology()
    expect(() => parseTopology(wire(plain))).not.toThrow()
    expect(plain.nodes.some((node) => node.kind === 'container')).toBe(false)
    expect(plain.edges).toEqual([])
    expect(plain.physicalLinksKnown).toBe(false)

    const withContainers = await api().getTopology({ include: ['containers', 'interfaces'] })
    expect(() => parseTopology(wire(withContainers), ['containers', 'interfaces'])).not.toThrow()
    expect(withContainers.nodes.some((node) => node.kind === 'container')).toBe(true)
  })

  it('takes the worst first under a limit, each node with its ancestors, and says it is partial', async () => {
    const topology = await api().getTopology({ limit: 5 })
    expect(topology.nodes).toHaveLength(5)
    expect(topology.truncated).toBe(true)
    expect(() => parseTopology(wire(topology))).not.toThrow()
    const server = topology.nodes.find((node) => node.kind === 'server')
    expect(server?.health).toBe('critical')
  })

  it('keeps to the scope', async () => {
    const full = await api().getTopology()
    const site = full.nodes.find((node) => node.kind === 'site')
    const scoped = await api().getTopology({
      scope: { customerId: null, siteId: site?.ref ?? null },
    })
    expect(scoped.nodes.filter((node) => node.kind === 'site').map((node) => node.id)).toEqual([
      site?.id,
    ])
  })
})

import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { Topology } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import { TopologyCanvas } from './TopologyCanvas'
import TopologyPage from './TopologyPage'
import { EMPTY, NODES, topology } from './testing'

/**
 * Cytoscape draws on a canvas jsdom does not have: these tests stand a recording fake in for it,
 * and check what the screen asks of it. What Cytoscape itself makes of the elements is checked
 * headless in topologyModel.test.ts.
 */
const fake = vi.hoisted(() => {
  type Handler = (event: { target: unknown }) => void
  interface Element {
    group: 'nodes' | 'edges'
    data: { id: string; [key: string]: unknown }
  }
  function create(options: Record<string, unknown>) {
    let elements: Element[] = []
    const selected = new Set<string>()
    const classes = new Map<string, Set<string>>()
    const onElement: Handler[] = []
    const onCore: Handler[] = []
    const element = (id: string) => ({
      id: () => id,
      data: vi.fn(),
      select: () => selected.add(id),
      addClass: (name: string) => classes.set(id, new Set([...(classes.get(id) ?? []), name])),
      position: vi.fn(),
      isChildless: () => true,
    })
    const collection = (ids: string[]) => ({
      remove: () => {
        elements = elements.filter((entry) => !ids.includes(entry.data.id))
      },
      removeClass: (name: string) => ids.forEach((id) => classes.get(id)?.delete(name)),
      unselect: () => ids.forEach((id) => selected.delete(id)),
      forEach: (fn: (entry: ReturnType<typeof element>) => void) =>
        ids.forEach((id) => fn(element(id))),
    })
    const cy = {
      options,
      elementsAdded: [] as Element[][],
      selected,
      classes,
      on: vi.fn((_event: string, selectorOrHandler: string | Handler, handler?: Handler) => {
        if (typeof selectorOrHandler === 'function') onCore.push(selectorOrHandler)
        else if (handler) onElement.push(handler)
      }),
      removeListener: vi.fn(),
      destroy: vi.fn(),
      batch: (fn: () => void) => fn(),
      elements: (selector?: string) =>
        collection(
          selector === ':selected' ? [...selected] : elements.map((entry) => entry.data.id),
        ),
      nodes: () =>
        collection(elements.filter((e) => e.group === 'nodes').map((entry) => entry.data.id)),
      add: vi.fn((added: Element[]) => {
        cy.elementsAdded.push(added)
        elements = [...elements, ...added]
      }),
      getElementById: (id: string) => element(id),
      fit: vi.fn(),
      zoom: vi.fn(() => 1),
      panBy: vi.fn(),
      resize: vi.fn(),
      width: () => 800,
      height: () => 600,
      /** A tap on an element: Cytoscape calls the element handlers, then the core's. */
      tap(id: string) {
        const target = { id: () => id }
        onElement.forEach((handler) => handler({ target }))
        onCore.forEach((handler) => handler({ target }))
      },
      tapBackground() {
        onCore.forEach((handler) => handler({ target: cy }))
      },
      get current() {
        return elements
      },
    }
    return cy
  }
  const instances: ReturnType<typeof create>[] = []
  const make = (options: Record<string, unknown>) => {
    const cy = create(options)
    instances.push(cy)
    return cy
  }
  return { instances, make }
})

vi.mock('cytoscape', () => ({ default: vi.fn(fake.make) }))

const overrides = registryOverrides()
const observers: { disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  fake.instances.length = 0
  observers.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      constructor() {
        observers.push(this)
      }
    },
  )
})
afterEach(() => {
  overrides.restore()
  vi.unstubAllGlobals()
})

function Where() {
  const location = useLocation()
  return <output aria-label="location">{location.pathname + location.search}</output>
}

const served = (...answers: (Topology | Error)[]) => {
  const getTopology = vi.fn<SentinelApi['getTopology']>(async () => {
    const next = answers.length > 1 ? (answers.shift() as Topology | Error) : answers[0]
    if (next instanceof Error) throw next
    return next as Topology
  })
  return { api: createTestApi({ getTopology, source: 'http' }), getTopology }
}

const page = (route = '/topology', api: SentinelApi = served(topology()).api) =>
  renderApp(
    <>
      <Routes>
        <Route path="/topology" element={<TopologyPage />} />
      </Routes>
      <Where />
    </>,
    { api, route },
  )

const cy = () => {
  const instance = fake.instances.at(-1)
  if (!instance) throw new Error('no Cytoscape instance')
  return instance
}
const drawn = () => waitFor(() => expect(fake.instances.length).toBeGreaterThan(0))
const details = () => screen.getByRole('region', { name: 'Selection' })
const location = () => screen.getByRole('status', { name: 'location' }).textContent ?? ''

describe('the request', () => {
  it('asks for the scope in the URL, without containers or interfaces, 1000 nodes', async () => {
    const { api, getTopology } = served(topology())
    page('/topology?customer=cus-1&site=site-ath', api)
    await drawn()
    expect(getTopology).toHaveBeenCalledExactlyOnceWith({
      scope: { customerId: 'cus-1', siteId: 'site-ath' },
      include: [],
      limit: 1000,
      signal: expect.any(AbortSignal),
    })
  })

  it('asks again for containers, interfaces and another limit, and keeps them in the URL', async () => {
    const user = userEvent.setup()
    const { api, getTopology } = served(topology())
    page('/topology', api)
    await drawn()
    await user.click(screen.getByRole('button', { name: 'Containers' }))
    await waitFor(() =>
      expect(getTopology).toHaveBeenLastCalledWith(
        expect.objectContaining({ include: ['containers'] }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Interfaces' }))
    await waitFor(() =>
      expect(getTopology).toHaveBeenLastCalledWith(
        expect.objectContaining({ include: ['containers', 'interfaces'] }),
      ),
    )
    await user.selectOptions(screen.getByLabelText('Node limit'), '250')
    await waitFor(() =>
      expect(getTopology).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 250 })),
    )
    expect(location()).toBe('/topology?containers=1&interfaces=1&limit=250')
  })
})

describe('the map', () => {
  it('gives Cytoscape every node with its parent, and only the monitoring edges', async () => {
    page()
    await drawn()
    await waitFor(() => expect(cy().add).toHaveBeenCalledOnce())
    const added = cy().elementsAdded[0] ?? []
    const nodes = added.filter((entry) => entry.group === 'nodes')
    const edges = added.filter((entry) => entry.group === 'edges')
    expect(nodes.map((entry) => entry.data.id)).toEqual(NODES.map((entry) => entry.id))
    expect(nodes.find((entry) => entry.data.id === 'server:srv-1')?.data.parent).toBe(
      'site:site-ath',
    )
    expect(
      edges.map((entry) => [entry.data.source, entry.data.target, entry.data.display]),
    ).toEqual([
      ['server:srv-1', 'target:tgt-1', 'Probes'],
      ['server:srv-1', 'device:dev-1', 'Polls'],
    ])
    expect(cy().fit).toHaveBeenCalled()
    expect(screen.getByText('9 nodes, 2 monitoring edges')).toBeInTheDocument()
  })

  it('says how to read it: boxes are grouping, dashed edges are monitoring, no physical links', async () => {
    page()
    await drawn()
    const legend = screen.getByRole('region', { name: 'How to read the map' })
    expect(legend).toHaveTextContent('They are not connections')
    expect(legend).toHaveTextContent('monitoring responsibility, not network connectivity')
    expect(legend).toHaveTextContent('Physical links are not known')
  })

  it('pans, zooms and fits from the toolbar and the keyboard', async () => {
    const user = userEvent.setup()
    page()
    await drawn()
    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(cy().zoom).toHaveBeenCalledWith(expect.objectContaining({ level: 1.25 }))
    await user.click(screen.getByRole('button', { name: 'Fit to view' }))
    const canvas = screen.getByRole('application', { name: 'Topology map' })
    canvas.focus()
    await user.keyboard('{ArrowLeft}')
    expect(cy().panBy).toHaveBeenCalledWith({ x: 80, y: 0 })
    await user.keyboard('-')
    expect(cy().zoom).toHaveBeenLastCalledWith(expect.objectContaining({ level: 0.8 }))
    const fits = cy().fit.mock.calls.length
    await user.keyboard('0')
    expect(cy().fit.mock.calls.length).toBe(fits + 1)
  })

  it('puts the layout back without asking the API again', async () => {
    const user = userEvent.setup()
    const { api, getTopology } = served(topology())
    page('/topology', api)
    await drawn()
    await user.click(screen.getByRole('button', { name: 'Reset layout' }))
    expect(getTopology).toHaveBeenCalledOnce()
    expect(cy().add).toHaveBeenCalledOnce()
  })

  it('dims every other health when one is picked out, and removes nothing', async () => {
    const user = userEvent.setup()
    page()
    await drawn()
    await user.click(screen.getByRole('button', { name: /^Critical/ }))
    expect(location()).toBe('/topology?health=critical')
    expect(cy().classes.get('server:srv-1')?.has('faded')).toBe(true)
    expect(cy().classes.get('target:tgt-1')?.has('faded') ?? false).toBe(false)
    expect(cy().classes.get('site:site-ath')?.has('faded') ?? false).toBe(false)
    expect(cy().current).toHaveLength(NODES.length + 2)
    expect(screen.getByText(/the others are dimmed, not removed/)).toBeInTheDocument()
  })
})

describe('the canvas lifecycle', () => {
  const canvas = (graph: Topology) => (
    <TopologyCanvas topology={graph} selected={null} onSelect={() => {}} highlight="all" />
  )

  it('updates a changed status in place, and lays out again only for another graph', () => {
    const view = renderApp(canvas(topology()))
    expect(fake.instances).toHaveLength(1)
    expect(cy().add).toHaveBeenCalledOnce()
    const recoloured = topology({
      nodes: NODES.map((entry) =>
        entry.id === 'target:tgt-1' ? { ...entry, health: 'healthy' as const } : entry,
      ),
    })
    view.rerender(canvas(recoloured))
    expect(cy().add).toHaveBeenCalledOnce()
    // Worst first: a status change reorders the answer, and that is still the same graph.
    view.rerender(canvas(topology({ nodes: [...recoloured.nodes].reverse() })))
    expect(cy().add).toHaveBeenCalledOnce()
    expect(cy().fit).toHaveBeenCalledOnce()
    view.rerender(canvas(topology({ nodes: NODES.slice(0, 4), edges: [] })))
    expect(cy().add).toHaveBeenCalledTimes(2)
    expect(fake.instances).toHaveLength(1)
  })

  it('destroys Cytoscape and stops observing the size when it unmounts', () => {
    const view = renderApp(canvas(topology()))
    const instance = cy()
    expect(instance.on).toHaveBeenCalled()
    view.unmount()
    expect(instance.removeListener).toHaveBeenCalledWith('tap')
    expect(instance.destroy).toHaveBeenCalledOnce()
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
  })
})

describe('selection', () => {
  it('shows a server: health, where it is, its agent, what it monitors, and its page', async () => {
    page('/topology?customer=cus-1')
    await drawn()
    act(() => cy().tap('server:srv-1'))
    const panel = details()
    expect(within(panel).getByRole('heading', { name: 'ath-probe-01' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('Server')
    expect(panel).toHaveTextContent('Meridian › Athens DC')
    expect(panel).toHaveTextContent('ath-probe')
    expect(panel).toHaveTextContent('ONLINE')
    expect(panel).toHaveTextContent('1.4.0')
    expect(panel).toHaveTextContent('30s ago')
    expect(panel).toHaveTextContent('probes 1 targets and polls 1 devices on the map')
    expect(within(panel).getByRole('link', { name: 'Open server' })).toHaveAttribute(
      'href',
      '/servers/srv-1?customer=cus-1',
    )
    expect(cy().selected.has('server:srv-1')).toBe(true)
  })

  it.each([
    ['container:srv-1:abc123', 'Open in Docker', '/docker?focus=srv-1%3Aabc123'],
    ['target:tgt-1', 'Open network target', '/network/tgt-1'],
    ['device:dev-1', 'Open SNMP device', '/snmp/dev-1'],
    ['interface:dev-1:12', 'Open its device', '/snmp/dev-1'],
  ])('links %s to the screen that exists for it', async (id, name, href) => {
    page()
    await drawn()
    act(() => cy().tap(id))
    expect(within(details()).getByRole('link', { name })).toHaveAttribute('href', href)
  })

  it('keeps the API health of a device, whatever its interfaces say', async () => {
    page()
    await drawn()
    act(() => cy().tap('device:dev-1'))
    expect(details()).toHaveTextContent('OK')
    expect(details()).not.toHaveTextContent('WARN')
    expect(details()).toHaveTextContent('Polled by')
    act(() => cy().tap('interface:dev-1:12'))
    expect(details()).toHaveTextContent('WARN')
    expect(details()).toHaveTextContent('ifIndex12')
  })

  it('gives a customer and a site no page of their own, but a way to narrow the scope', async () => {
    const user = userEvent.setup()
    page()
    await drawn()
    act(() => cy().tap('site:site-ath'))
    expect(within(details()).queryByRole('link')).toBeNull()
    await user.click(
      within(details()).getByRole('button', { name: 'Narrow the scope to this site' }),
    )
    expect(location()).toBe('/topology?customer=cus-1&site=site-ath')
  })

  it('explains the no-site group and a server without agent', async () => {
    page()
    await drawn()
    act(() => cy().tap('group:unassigned'))
    expect(details()).toHaveTextContent('Not a site')
    act(() => cy().tap('server:srv-lab'))
    expect(details()).toHaveTextContent('None installed')
    expect(details()).toHaveTextContent('UNKN')
  })

  it('says an edge is monitoring responsibility, not a connection', async () => {
    page()
    await drawn()
    act(() => cy().tap('monitors:target:tgt-1'))
    const panel = details()
    expect(within(panel).getByRole('heading', { name: 'Probes' })).toBeInTheDocument()
    expect(panel).toHaveTextContent('not a network connection')
    expect(panel).toHaveTextContent('Sentinel records no cabling or routing')
  })

  it('clears on a tap on the background, and on Escape', async () => {
    const user = userEvent.setup()
    page()
    await drawn()
    act(() => cy().tap('server:srv-1'))
    act(() => cy().tapBackground())
    expect(details()).toHaveTextContent('Nothing selected')
    act(() => cy().tap('server:srv-1'))
    screen.getByRole('application', { name: 'Topology map' }).focus()
    await user.keyboard('{Escape}')
    expect(details()).toHaveTextContent('Nothing selected')
  })
})

describe('the list view', () => {
  it('nests every node under its holder, as buttons a keyboard can reach, and selects from there', async () => {
    const user = userEvent.setup()
    page('/topology?view=list')
    const list = await screen.findByRole('region', { name: 'Topology list' })
    expect(fake.instances).toHaveLength(0)
    const site = within(list).getByRole('button', { name: /^Athens DC/ })
    const nested = site.closest('li') as HTMLElement
    expect(within(nested).getByRole('button', { name: /^ath-probe-01/ })).toBeInTheDocument()
    expect(within(nested).getByRole('button', { name: /^pgbouncer/ })).toBeInTheDocument()
    expect(nested).toHaveTextContent('Probed by ath-probe-01')
    expect(screen.queryByRole('group', { name: 'Pick out by health' })).toBeNull()
    await user.click(within(list).getByRole('button', { name: /^gw-ath/ }))
    expect(within(details()).getByRole('heading', { name: 'gw-ath' })).toBeInTheDocument()
    expect(details()).toHaveTextContent('CRIT')
  })
})

describe('a partial answer', () => {
  const partial = topology({
    counts: {
      ...topology().counts,
      server: { visible: 40, returned: 2 },
      target: { visible: 12, returned: 1 },
    },
    truncated: true,
  })

  it('says so prominently, with what was returned of what, and how to see the rest', async () => {
    page('/topology?containers=1', served(partial).api)
    const notice = await screen.findByRole('region', { name: /Partial map/ })
    expect(notice).toHaveTextContent('PARTIAL')
    expect(notice).toHaveTextContent('returned 9 of 58 nodes in this scope, at a limit of 1,000')
    expect(notice).toHaveTextContent('2 of 40 servers shown')
    expect(notice).toHaveTextContent('1 of 12 network targets shown')
    expect(notice).toHaveTextContent('narrow the scope to one customer or site')
    expect(notice).toHaveTextContent('hide containers')
    expect(notice).toHaveTextContent('raise the node limit')
    expect(screen.getByText('9 nodes, 2 monitoring edges (partial)')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Map' })).toHaveTextContent('2 of 40 servers')
  })

  it('asks once: it never fetches more pages to fill the map', async () => {
    const { api, getTopology } = served(partial)
    page('/topology', api)
    await screen.findByRole('region', { name: /Partial map/ })
    expect(getTopology).toHaveBeenCalledOnce()
  })

  it('shows no notice when nothing was left out', async () => {
    page()
    await drawn()
    expect(screen.queryByRole('region', { name: /Partial map/ })).toBeNull()
    expect(screen.queryByText('PARTIAL')).toBeNull()
  })
})

describe('empty and failed', () => {
  it('says there is nothing in scope, and offers every scope when one is chosen', async () => {
    const user = userEvent.setup()
    page('/topology?site=site-x', served(EMPTY).api)
    expect(await screen.findByText('No infrastructure in this scope')).toBeInTheDocument()
    expect(fake.instances).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Show every scope' }))
    expect(location()).toBe('/topology')
  })

  it('says a hidden or unknown customer or site is out of reach, not that the estate is empty', async () => {
    page('/topology?customer=hidden', served(new ApiError('Not found.', 404, 'not_found')).api)
    const map = screen.getByRole('region', { name: 'Map' })
    expect(await within(map).findByText(/not one you may see/)).toBeInTheDocument()
    expect(screen.queryByText('No infrastructure in this scope')).toBeNull()
  })

  it('shows the API error with a retry, and never anything in place of the graph', async () => {
    const user = userEvent.setup()
    const { api, getTopology } = served(new ApiError('Service unavailable', 503), topology())
    page('/topology', api)
    const map = screen.getByRole('region', { name: 'Map' })
    expect(await within(map).findByText('Service unavailable')).toBeInTheDocument()
    expect(fake.instances).toHaveLength(0)
    expect(screen.queryByText(/nodes, \d+ monitoring edges/)).toBeNull()
    await user.click(within(map).getByRole('button', { name: 'Retry' }))
    await drawn()
    expect(getTopology).toHaveBeenCalledTimes(2)
  })

  it('refuses an answer that does not fit the contract as an error, not a guess', async () => {
    page(
      '/topology',
      served(new ApiError('The server sent an unexpected answer.', null, 'bad_response')).api,
    )
    expect(await screen.findByText('The server sent an unexpected answer.')).toBeInTheDocument()
    expect(fake.instances).toHaveLength(0)
  })
})

describe('provenance', () => {
  it('is live over the console API, mock over the sample API, never live while not connected', async () => {
    const live = page()
    await drawn()
    const map = () => screen.getByRole('region', { name: 'Map' })
    expect(within(map()).getByText(/^live/)).toBeInTheDocument()
    live.unmount()
    page('/topology', createTestApi({ getTopology: async () => topology(), source: 'mock' }))
    await waitFor(() => expect(within(map()).getByText(/^mock/)).toBeInTheDocument())
    overrides.set('topology', { connected: false })
    page('/topology', served(topology()).api)
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Map' }).length).toBe(2))
    expect(screen.queryAllByText(/^live/)).toHaveLength(0)
  })
})

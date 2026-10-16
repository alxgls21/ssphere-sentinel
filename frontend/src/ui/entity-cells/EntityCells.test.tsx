import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EntityKind, HealthStatus, SiteEntity } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import { EntityCells } from './EntityCells'

const overrides = registryOverrides()
afterEach(overrides.restore)

const entity = (id: string, status: HealthStatus, kind: EntityKind = 'server'): SiteEntity => ({
  id,
  kind,
  name: id,
  status,
})

const healthy = (count: number) =>
  Array.from({ length: count }, (_, index) => entity(`ok-${index + 1}`, 'healthy'))

const glyphs = (root: HTMLElement) => [...root.querySelectorAll('svg')]

describe('EntityCells strip', () => {
  const mixed = [
    entity('a', 'healthy'),
    entity('b', 'idle'),
    entity('c', 'critical'),
    entity('d', 'unknown'),
    entity('e', 'warning'),
    entity('f', 'healthy'),
  ]

  it('draws one glyph per entity, worst first', () => {
    const { container } = renderApp(<EntityCells variant="strip" entities={mixed} />)
    expect(glyphs(container).map((glyph) => glyph.getAttribute('data-status'))).toEqual([
      'critical',
      'warning',
      'unknown',
      'idle',
      'healthy',
      'healthy',
    ])
  })

  it('keeps healthy quiet: a 6px dot, while every other state is a full 10px shape', () => {
    const { container } = renderApp(<EntityCells variant="strip" entities={mixed} />)
    for (const glyph of glyphs(container)) {
      const quiet = glyph.getAttribute('data-status') === 'healthy'
      expect(glyph).toHaveClass(quiet ? 'size-1.5' : 'size-2.5')
    }
  })

  it('is decorative: hidden from assistive technology, its parent row carries the label', () => {
    const { container } = renderApp(<EntityCells variant="strip" entities={mixed} />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('lays cells on a 12px pitch: 10px cells with 2px gaps', () => {
    const { container } = renderApp(<EntityCells variant="strip" entities={mixed} />)
    expect(container.firstElementChild).toHaveClass('gap-0.5')
    expect(container.querySelector('svg')?.parentElement).toHaveClass('size-2.5')
  })

  it('does not reorder or mutate the entities it is given', () => {
    const input = [...mixed]
    renderApp(<EntityCells variant="strip" entities={input} />)
    expect(input).toEqual(mixed)
  })

  it('stays a strip up to its capacity, then collapses to a bar with glyph-coded counts', () => {
    const atCapacity = [entity('x', 'critical'), ...healthy(2)]
    const { container, rerender } = renderApp(
      <EntityCells variant="strip" entities={atCapacity} capacity={3} />,
    )
    expect(glyphs(container)).toHaveLength(3)
    expect(container.querySelector('[role="img"]')).toBeNull()

    rerender(<EntityCells variant="strip" entities={[...atCapacity, ...healthy(1)]} capacity={3} />)
    expect(container.querySelector('[role="img"]')).toHaveAttribute(
      'aria-label',
      'Entities: 1 critical, 3 ok',
    )
    expect(glyphs(container).map((glyph) => glyph.getAttribute('data-status'))).toEqual([
      'critical',
      'healthy',
    ])
    expect(container).toHaveTextContent('13')
  })

  it('collapses with a bar of the 8px thickness and names it with the given label', () => {
    const { container } = renderApp(
      <EntityCells variant="strip" entities={healthy(5)} capacity={4} label="Globex / Thess-1" />,
    )
    const bar = container.querySelector('[role="img"]')
    expect(bar).toHaveClass('h-2')
    expect(bar).toHaveAttribute('aria-label', 'Globex / Thess-1: 5 ok')
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('counts only the statuses present, worst first, in the collapsed form', () => {
    const entities = [
      ...healthy(18),
      entity('w1', 'warning'),
      entity('w2', 'warning'),
      entity('c', 'critical'),
    ]
    const { container } = renderApp(<EntityCells variant="strip" entities={entities} />)
    expect(glyphs(container).map((glyph) => glyph.getAttribute('data-status'))).toEqual([
      'critical',
      'warning',
      'healthy',
    ])
    expect(container).toHaveTextContent('1218')
  })

  it('defaults to a capacity of 20', () => {
    const { container, rerender } = renderApp(
      <EntityCells variant="strip" entities={healthy(20)} />,
    )
    expect(glyphs(container)).toHaveLength(20)
    rerender(<EntityCells variant="strip" entities={healthy(21)} />)
    expect(glyphs(container)).toHaveLength(1)
  })

  it('renders nothing for a site with no entities', () => {
    const { container } = renderApp(<EntityCells variant="strip" entities={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('EntityCells grid', () => {
  const entities: SiteEntity[] = [
    entity('web-01', 'healthy'),
    entity('edge-gw-02', 'critical'),
    entity('api-02', 'warning'),
    entity('db-01', 'healthy'),
    entity('worker-03', 'healthy'),
    entity('redis', 'healthy', 'container'),
    entity('acme-vpn:443', 'critical', 'target'),
    entity('sw-core', 'unknown', 'device'),
  ]
  // Servers (3 per row): [edge-gw-02 api-02 web-01] [db-01 worker-03]; then redis; acme-vpn:443; sw-core.
  const renderGrid = (props: Partial<Parameters<typeof EntityCells>[0]> = {}) =>
    renderApp(
      <EntityCells
        variant="grid"
        entities={entities}
        label="Acme / Athens-DC"
        columns={3}
        {...props}
      />,
    )
  const cell = (name: string | RegExp) => screen.getByRole('button', { name })
  const tabStops = () => screen.getAllByRole('button').filter((b) => b.tabIndex === 0)

  it('is a labelled grid of groups, rows and cells', () => {
    renderGrid()
    expect(screen.getByRole('grid', { name: 'Acme / Athens-DC' })).toBeInTheDocument()
    expect(
      screen.getAllByRole('rowgroup').map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Servers, 5', 'Containers, 1', 'Network targets, 1', 'Devices, 1'])
    expect(screen.getAllByRole('row')).toHaveLength(5)
  })

  it('labels every cell with its name, kind, state word and data source', () => {
    renderGrid()
    expect(cell('edge-gw-02, server, CRIT, mock data')).toBeInTheDocument()
    expect(cell('api-02, server, WARN, mock data')).toBeInTheDocument()
    expect(cell('web-01, server, OK, mock data')).toBeInTheDocument()
    expect(cell('acme-vpn:443, target, CRIT, mock data')).toBeInTheDocument()
    expect(cell('sw-core, device, UNKN, mock data')).toBeInTheDocument()
  })

  it('keeps claiming mock data over an HTTP adapter while the kind is not connected', () => {
    renderApp(<EntityCells variant="grid" entities={entities} label="Live" />, {
      api: createTestApi({ source: 'http' }),
    })
    expect(cell('edge-gw-02, server, CRIT, mock data')).toBeInTheDocument()
  })

  it('does not claim mock data for a kind that is connected and real', () => {
    overrides.set('servers', { connected: true })
    renderApp(<EntityCells variant="grid" entities={entities} label="Live" />, {
      api: createTestApi({ source: 'http' }),
    })
    expect(cell('edge-gw-02, server, CRIT')).toBeInTheDocument()
    expect(cell('acme-vpn:443, target, CRIT, mock data')).toBeInTheDocument()
  })

  it('lists servers worst first, then containers, targets and devices', () => {
    renderGrid()
    expect(screen.getAllByRole('button').map((button) => button.dataset.key)).toEqual([
      'server:edge-gw-02',
      'server:api-02',
      'server:web-01',
      'server:db-01',
      'server:worker-03',
      'container:redis',
      'target:acme-vpn:443',
      'device:sw-core',
    ])
  })

  it('is one tab stop: only the first cell is tabbable, and Tab lands on it', async () => {
    const user = userEvent.setup()
    renderGrid()
    expect(tabStops()).toEqual([cell(/^edge-gw-02/)])
    await user.tab()
    expect(cell(/^edge-gw-02/)).toHaveFocus()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('moves focus cell to cell with the arrow keys and rolls the tab stop with it', async () => {
    const user = userEvent.setup()
    renderGrid()
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(cell(/^api-02/)).toHaveFocus()
    expect(tabStops()).toEqual([cell(/^api-02/)])
    await user.keyboard('{ArrowDown}')
    expect(cell(/^worker-03/)).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(cell(/^db-01/)).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(cell(/^edge-gw-02/)).toHaveFocus()
  })

  it('goes to the ends of a row with Home and End, and of the grid with Ctrl', async () => {
    const user = userEvent.setup()
    renderGrid()
    await user.tab()
    await user.keyboard('{End}')
    expect(cell(/^web-01/)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(cell(/^edge-gw-02/)).toHaveFocus()
    await user.keyboard('{Control>}{End}{/Control}')
    expect(cell(/^sw-core/)).toHaveFocus()
    await user.keyboard('{Control>}{Home}{/Control}')
    expect(cell(/^edge-gw-02/)).toHaveFocus()
  })

  it('jumps between groups with PageDown and PageUp', async () => {
    const user = userEvent.setup()
    renderGrid()
    await user.tab()
    await user.keyboard('{PageDown}')
    expect(cell(/^redis/)).toHaveFocus()
    await user.keyboard('{PageDown}')
    expect(cell(/^acme-vpn:443/)).toHaveFocus()
    await user.keyboard('{PageUp}{PageUp}')
    expect(cell(/^edge-gw-02/)).toHaveFocus()
  })

  it('keeps the browser from scrolling on handled keys but leaves other keys alone', async () => {
    const user = userEvent.setup()
    renderGrid()
    await user.tab()
    const seen: Record<string, boolean> = {}
    const record = (event: KeyboardEvent) => (seen[event.key] = event.defaultPrevented)
    document.addEventListener('keydown', record)
    try {
      await user.keyboard('{ArrowDown}{PageDown}x')
    } finally {
      document.removeEventListener('keydown', record)
    }
    expect(seen).toMatchObject({ ArrowDown: true, PageDown: true, x: false })
  })

  it('remembers the last cell: Tab out and back returns to it', async () => {
    const user = userEvent.setup()
    renderApp(
      <>
        <button type="button">before</button>
        <EntityCells variant="grid" entities={entities} label="Acme" columns={3} />
        <button type="button">after</button>
      </>,
    )
    await user.tab()
    await user.tab()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(cell(/^web-01/)).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(cell(/^web-01/)).toHaveFocus()
  })

  it('selects with Enter, Space and click', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderGrid({ onSelect })
    await user.tab()
    await user.keyboard('{Enter}')
    await user.keyboard('{ArrowRight}{ }')
    await user.click(cell(/^acme-vpn:443/))
    expect(onSelect.mock.calls.map(([picked]) => picked.id)).toEqual([
      'edge-gw-02',
      'api-02',
      'acme-vpn:443',
    ])
  })

  it('marks the selected cell and makes it the tab stop when nothing was focused yet', () => {
    renderGrid({ selectedId: 'worker-03' })
    const selected = cell(/^worker-03/)
    expect(selected.closest('td')).toHaveAttribute('aria-selected', 'true')
    expect(cell(/^edge-gw-02/).closest('td')).toHaveAttribute('aria-selected', 'false')
    expect(selected).toHaveClass('outline-2', 'outline-primary')
    expect(tabStops()).toEqual([selected])
  })

  it('falls back to a cell that still exists when the focused one disappears', async () => {
    const user = userEvent.setup()
    const { rerender } = renderGrid()
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(tabStops()).toEqual([cell(/^api-02/)])
    rerender(
      <EntityCells
        variant="grid"
        entities={entities.filter((e) => e.id !== 'api-02')}
        label="Acme / Athens-DC"
        columns={3}
      />,
    )
    expect(tabStops()).toEqual([cell(/^edge-gw-02/)])
  })

  it('wraps a group into rows of the column count and keeps a glyph in every cell', () => {
    renderGrid()
    const rows = screen.getAllByRole('row')
    expect(within(rows[0] as HTMLElement).getAllByRole('button')).toHaveLength(3)
    expect(within(rows[1] as HTMLElement).getAllByRole('button')).toHaveLength(2)
    for (const button of screen.getAllByRole('button'))
      expect(button.querySelector('svg')).not.toBeNull()
  })

  it('renders nothing for no entities', () => {
    const { container } = renderGrid({ entities: [] })
    expect(container).toBeEmptyDOMElement()
  })
})

describe('EntityCells with an offline server', () => {
  /** A server whose agent stopped reporting: critical in `status`, flagged in `offline`. */
  const offlineServer = (id: string): SiteEntity => ({ ...entity(id, 'critical'), offline: true })

  const site = [
    entity('ok-1', 'healthy'),
    offlineServer('pir-fs-01'),
    entity('api-02', 'warning'),
    entity('edge-gw-02', 'critical'),
    entity('pir-vpn', 'critical', 'target'),
  ]

  describe('strip', () => {
    it('draws the offline server with its own glyph, directly after the critical ones', () => {
      const { container } = renderApp(<EntityCells variant="strip" entities={site} />)
      expect(glyphs(container).map((glyph) => glyph.getAttribute('data-status'))).toEqual([
        'critical',
        'critical',
        'offline',
        'warning',
        'healthy',
      ])
    })

    it('draws offline as a full 10px shape: only healthy is the quiet dot', () => {
      const { container } = renderApp(<EntityCells variant="strip" entities={site} />)
      const offline = container.querySelector('svg[data-status="offline"]')
      expect(offline).toHaveClass('size-2.5')
      expect(offline?.innerHTML).not.toBe(
        container.querySelector('svg[data-status="critical"]')?.innerHTML,
      )
    })

    it('stays decorative and does not reorder what it is given', () => {
      const input = [...site]
      const { container } = renderApp(<EntityCells variant="strip" entities={input} />)
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
      expect(input).toEqual(site)
    })

    it('collapses to a bar and counts that name offline apart, with critical still holding it', () => {
      const entities = [
        ...healthy(19),
        offlineServer('pir-fs-01'),
        entity('c', 'critical', 'target'),
      ]
      const { container } = renderApp(<EntityCells variant="strip" entities={entities} />)
      expect(container.querySelector('[role="img"]')).toHaveAttribute(
        'aria-label',
        'Entities: 1 critical, 1 offline, 19 ok',
      )
      expect(
        glyphs(container).map((glyph) => [
          glyph.getAttribute('data-status'),
          glyph.parentElement?.parentElement?.textContent,
        ]),
      ).toEqual([
        ['critical', '1'],
        ['offline', '1'],
        ['healthy', '19'],
      ])
    })

    it('draws the collapsed offline segment as two thin bars after the critical segment', () => {
      const entities = [
        ...healthy(19),
        offlineServer('pir-fs-01'),
        entity('c', 'critical', 'target'),
      ]
      const { container } = renderApp(<EntityCells variant="strip" entities={entities} />)
      const parts = [...container.querySelectorAll('[role="img"] > [data-status]')]
      expect(parts.map((part) => part.getAttribute('data-status'))).toEqual([
        'critical',
        'offline',
        'healthy',
      ])
      expect(parts[1]?.children).toHaveLength(2)
    })
  })

  describe('grid', () => {
    const renderGrid = () =>
      renderApp(<EntityCells variant="grid" entities={site} label="Piraeus" columns={4} />)

    it('names the offline cell in full, and keeps the compact CRIT for the critical ones', () => {
      renderGrid()
      expect(
        screen.getByRole('button', { name: 'pir-fs-01, server, offline, mock data' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'edge-gw-02, server, CRIT, mock data' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'pir-vpn, target, CRIT, mock data' }),
      ).toBeInTheDocument()
    })

    it('draws the offline glyph in the cell and lists it after the critical servers', () => {
      renderGrid()
      const cells = screen.getAllByRole('button')
      expect(cells.map((cell) => cell.dataset.key)).toEqual([
        'server:edge-gw-02',
        'server:pir-fs-01',
        'server:api-02',
        'server:ok-1',
        'target:pir-vpn',
      ])
      expect(cells[1]?.querySelector('svg')).toHaveAttribute('data-status', 'offline')
      expect(cells[0]?.querySelector('svg')).toHaveAttribute('data-status', 'critical')
    })
  })
})

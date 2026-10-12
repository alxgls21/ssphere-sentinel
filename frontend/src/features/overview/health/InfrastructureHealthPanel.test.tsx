import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DomainBreakdown,
  HealthBreakdown,
  HealthStatus,
  SiteBreakdown,
  SiteEntity,
} from '@/api/types'
import { emptyCounts } from '@/lib/status'
import { createTestApi, renderApp } from '@/test/render'
import { InfrastructureHealthPanel } from './InfrastructureHealthPanel'
import { NAME_RESERVE_PX } from './healthModel'

const NOW = '2026-10-12T14:05:12Z'

const counts = (parts: Partial<Record<HealthStatus, number>>) => ({ ...emptyCounts(), ...parts })

const DOMAINS: DomainBreakdown[] = [
  { domain: 'servers', label: 'SERVERS', counts: counts({ critical: 1, warning: 2, healthy: 13 }) },
  {
    domain: 'containers',
    label: 'CONTAINERS',
    counts: counts({ critical: 2, warning: 1, healthy: 62, idle: 3 }),
  },
  {
    domain: 'targets',
    label: 'NET TARGETS',
    counts: counts({ critical: 1, warning: 2, healthy: 37 }),
  },
  { domain: 'snmp', label: 'SNMP DEVS', counts: counts({ unknown: 12 }), planned: true },
]

const entities = (siteId: string, parts: [HealthStatus, number, string[]?][]): SiteEntity[] =>
  parts.flatMap(([status, n, names]) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${siteId}-${status}-${i}`,
      kind: 'server' as const,
      name: names?.[i] ?? `${siteId}-${status}-${i}`,
      status,
    })),
  )

const SITES: SiteBreakdown[] = [
  {
    siteId: 'site-initech',
    customerName: 'Initech',
    siteName: 'Patras',
    entities: entities('i', [
      ['warning', 1, ['api-02']],
      ['healthy', 14],
    ]),
  },
  {
    siteId: 'site-acme',
    customerName: 'Acme',
    siteName: 'Athens-DC',
    entities: entities('a', [
      ['critical', 2, ['edge-gw-02', 'acme-vpn:443']],
      ['warning', 1, ['api-02']],
      ['healthy', 15],
    ]),
  },
  {
    siteId: 'site-globex',
    customerName: 'Globex',
    siteName: 'Thess-1',
    entities: entities('g', [
      ['critical', 2],
      ['warning', 3],
      ['healthy', 20],
    ]),
  },
]

const breakdown = (overrides: Partial<HealthBreakdown> = {}): HealthBreakdown => ({
  generatedAt: NOW,
  domains: DOMAINS,
  sites: SITES,
  ...overrides,
})

const apiWith = (value: () => Promise<HealthBreakdown> = async () => breakdown()) =>
  createTestApi({ getHealthBreakdown: vi.fn(value) })

/** Reports every observed element as `width` px wide, as a layout engine would. */
function stubResizeObserver(width: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe() {
        this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as never)
      }
      unobserve() {}
      disconnect() {}
    },
  )
}

const region = () => screen.getByRole('region', { name: 'Infrastructure health' })
const siteLinks = () => within(screen.getByRole('list', { name: /by site/i })).getAllByRole('link')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('InfrastructureHealthPanel', () => {
  it('is panel [4]: a labelled, solid region marked mock (only its sub-elements are planned)', async () => {
    renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
    expect(region()).toHaveAttribute('aria-keyshortcuts', '4')
    expect(region()).not.toHaveAttribute('data-planned')
    expect(region()).not.toHaveAttribute('aria-describedby')
    expect(within(region()).getByText(/^mock/)).toBeInTheDocument()
    await screen.findByText('SERVERS')
    // The SNMP row and BY SITE each carry their own marker; the header does not.
    expect(within(region()).getAllByText('Planned')).toHaveLength(2)
    expect(
      within(region().querySelector('header') as HTMLElement).queryByText('Planned'),
    ).toBeNull()
  })

  it('takes its place in the Overview grid through className', async () => {
    renderApp(<InfrastructureHealthPanel className="col-span-4" />, { api: apiWith() })
    expect(region()).toHaveClass('col-span-4')
    await screen.findByText('SERVERS')
  })

  it('asks for the health breakdown in the topbar scope', async () => {
    const api = apiWith()
    renderApp(<InfrastructureHealthPanel />, { api, route: '/?customer=acme' })
    await screen.findByText('SERVERS')
    expect(api.getHealthBreakdown).toHaveBeenCalledWith({
      scope: { customerId: 'acme', siteId: null },
      signal: expect.any(AbortSignal),
    })
  })

  describe('domain rows', () => {
    it('shows four rows with the API labels, in order', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      for (const label of ['SERVERS', 'CONTAINERS', 'NET TARGETS', 'SNMP DEVS']) {
        expect(within(region()).getByText(label)).toBeInTheDocument()
      }
    })

    it('draws an 8px bar per domain that names every count', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const bar = await screen.findByRole('img', {
        name: 'Servers: 1 critical, 2 warning, 13 ok',
      })
      expect(bar).toHaveClass('h-2')
      expect(
        screen.getByRole('img', { name: 'Containers: 2 critical, 1 warning, 3 idle, 62 ok' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('img', { name: 'Network targets: 1 critical, 2 warning, 37 ok' }),
      ).toBeInTheDocument()
    })

    it('adds glyph-coded counts, worst first, hidden from assistive technology', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const row = (await screen.findByText('CONTAINERS')).closest('li') as HTMLElement
      const counted = row.querySelector('[aria-hidden="true"]') as HTMLElement
      expect(
        [...counted.querySelectorAll('svg')].map((glyph) => glyph.getAttribute('data-status')),
      ).toEqual(['critical', 'warning', 'idle', 'healthy'])
      expect(counted).toHaveTextContent('21362')
    })

    it('shows the SNMP row as a planned bar with a PLANNED chip and no counts', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const row = (await screen.findByText('SNMP DEVS')).closest('li') as HTMLElement
      expect(
        within(row).getByRole('img', { name: 'SNMP devices: no SNMP data' }),
      ).toBeInTheDocument()
      expect(within(row).getByText('Planned')).toBeInTheDocument()
      expect(row.querySelector('svg[data-status="unknown"]')).toBeNull()
    })

    it('says "none" for a domain with nothing counted', async () => {
      const domains = [
        { ...DOMAINS[1], counts: counts({}) },
        ...DOMAINS.slice(0, 1),
      ] as DomainBreakdown[]
      renderApp(<InfrastructureHealthPanel />, { api: apiWith(async () => breakdown({ domains })) })
      const row = (await screen.findByText('CONTAINERS')).closest('li') as HTMLElement
      expect(within(row).getByRole('img', { name: 'Containers: none' })).toBeInTheDocument()
      expect(within(row).getByText('none')).toBeInTheDocument()
    })
  })

  describe('BY SITE', () => {
    it('is marked planned and sample, with its reason available to everyone', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const list = await screen.findByRole('list', { name: 'By site' })
      const heading = screen.getByRole('heading', { name: /by site/i })
      expect(heading).toHaveTextContent('By site †')
      expect(heading.parentElement).toHaveTextContent('Planned')
      expect(heading.parentElement).toHaveTextContent('sample data')
      expect(list).toHaveAccessibleDescription(/not linked to sites in the backend/)
    })

    it('lists the worst site first, whatever order the API used', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      expect(siteLinks().map((link) => link.getAttribute('href'))).toEqual([
        '/customers?site=site-globex',
        '/customers?site=site-acme',
        '/customers?site=site-initech',
      ])
    })

    it('makes each site one link whose label names every non-OK entity', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      expect(
        await screen.findByRole('link', {
          name: 'Acme / Athens-DC: 2 critical (edge-gw-02, acme-vpn:443), 1 warning (api-02), 15 ok',
        }),
      ).toHaveAttribute('href', '/customers?site=site-acme')
      expect(
        screen.getByRole('link', { name: 'Initech / Patras: 1 warning (api-02), 14 ok' }),
      ).toBeInTheDocument()
    })

    it('leads each row with the glyph of its worst entity', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      const lead = (link: HTMLElement) => link.querySelector('svg')?.getAttribute('data-status')
      expect(siteLinks().map(lead)).toEqual(['critical', 'critical', 'warning'])
    })

    it('draws a strip of cells for a small site and a bar plus counts past 20 entities', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      const [globex, acme, initech] = siteLinks() as [HTMLElement, HTMLElement, HTMLElement]
      // One lead glyph plus one cell per entity.
      expect(acme.querySelectorAll('svg')).toHaveLength(1 + 18)
      expect(initech.querySelectorAll('svg')).toHaveLength(1 + 15)
      expect(acme.querySelector('[role="img"]')).toBeNull()
      // 25 entities: collapsed to a bar, with glyph + number for each status that is present.
      expect(globex.querySelector('[role="img"]')).not.toBeNull()
      expect(globex).toHaveTextContent('2320')
    })

    it('collapses strips sooner in a narrow container', async () => {
      stubResizeObserver(100)
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      for (const link of siteLinks()) expect(link.querySelector('[role="img"]')).not.toBeNull()
    })

    it('keeps strips of up to 20 cells in a container that holds them', async () => {
      // The row is measured, and the site name keeps its share: 238px of strip means that much plus the reserve.
      stubResizeObserver(238 + NAME_RESERVE_PX)
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      const [, acme, initech] = siteLinks() as [HTMLElement, HTMLElement, HTMLElement]
      expect(acme.querySelector('[role="img"]')).toBeNull()
      expect(initech.querySelector('[role="img"]')).toBeNull()
    })

    it('shows the three worst sites and counts the rest in the footer, linking to Customers & Sites', async () => {
      const more = ['d', 'e'].map((id, index) => ({
        siteId: `site-${id}`,
        customerName: 'Zed',
        siteName: id,
        entities: entities(id, [['healthy', 2 + index]]),
      }))
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(async () => breakdown({ sites: [...SITES, ...more] })),
      })
      await screen.findByRole('list', { name: /by site/i })
      expect(siteLinks()).toHaveLength(3)
      expect(screen.getByRole('link', { name: '+2 more sites' })).toHaveAttribute(
        'href',
        '/customers',
      )
    })

    it('has no "more" link when every site is listed', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByRole('list', { name: /by site/i })
      expect(screen.queryByRole('link', { name: /more site/ })).not.toBeInTheDocument()
    })

    it('says so when there are no site assignments, and keeps the planned marker', async () => {
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(async () => breakdown({ sites: [] })),
      })
      expect(await screen.findByText('No site assignments yet')).toBeInTheDocument()
      expect(screen.queryByRole('list', { name: /by site/i })).not.toBeInTheDocument()
      expect(within(region()).getAllByText('Planned')).toHaveLength(2)
    })
  })

  it('ends with the glyph legend: ok, warn, crit, unkn, idle', async () => {
    renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
    const legend = screen.getByRole('list', { name: 'Status legend' })
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['OK', 'WARN', 'CRIT', 'UNKN', 'IDLE'])
    const shapes = [...legend.querySelectorAll('svg')].map((glyph) =>
      glyph.getAttribute('data-status'),
    )
    expect(shapes).toEqual(['healthy', 'warning', 'critical', 'unknown', 'idle'])
    await screen.findByText('SERVERS')
  })

  describe('states', () => {
    it('shows a skeleton only after a short delay while the legend stays', async () => {
      const { container } = renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(() => new Promise<HealthBreakdown>(() => {})),
      })
      expect(region()).toHaveAttribute('aria-busy', 'true')
      expect(container.querySelector('.animate-skeleton')).toBeNull()
      await waitFor(() => expect(container.querySelectorAll('.animate-skeleton')).toHaveLength(7))
      expect(screen.getByRole('list', { name: 'Status legend' })).toBeInTheDocument()
      expect(screen.queryByText('SERVERS')).not.toBeInTheDocument()
    })

    it('says nothing is monitored when no real domain counts anything', async () => {
      const domains = DOMAINS.map((d) => (d.planned ? d : { ...d, counts: counts({}) }))
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(async () => breakdown({ domains, sites: [] })),
      })
      expect(await screen.findByText('Nothing monitored yet')).toBeInTheDocument()
      expect(screen.queryByText('SERVERS')).not.toBeInTheDocument()
    })

    it('shows an inline error with Retry, and recovers', async () => {
      const user = userEvent.setup()
      let failing = true
      const api = apiWith(async () => {
        if (failing) throw new Error('boom')
        return breakdown()
      })
      renderApp(<InfrastructureHealthPanel />, { api })
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load infrastructure health',
      )

      failing = false
      await user.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('SERVERS')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('keeps its last good rows, with a banner, when a refresh fails', async () => {
      let calls = 0
      const api = apiWith(async () => {
        calls += 1
        if (calls > 1) throw new Error('flaky')
        return breakdown()
      })
      renderApp(<InfrastructureHealthPanel />, { api, pollMs: 20 })
      expect(await screen.findByText('SERVERS')).toBeInTheDocument()
      await waitFor(() => expect(screen.getByText('Refresh failed')).toBeInTheDocument())
      expect(screen.getByText('SERVERS')).toBeInTheDocument()
    })
  })
})

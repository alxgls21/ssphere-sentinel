import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DomainBreakdown,
  HealthBreakdown,
  HealthStatus,
  SiteBreakdown,
  SiteEntity,
  StatusCounts,
} from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { emptyCounts, type DisplayStatus } from '@/lib/status'
import { createTestApi, renderApp } from '@/test/render'
import { stubFocusVisible } from '@/ui/controls/testing'
import { STATUS_NAME, STATUS_WORD, StatusLegend } from '@/ui/status'
import { InfrastructureHealthPanel } from './InfrastructureHealthPanel'
import { NAME_RESERVE_PX } from './healthModel'

const NOW = '2026-10-12T14:05:12Z'

const counts = (parts: Partial<Record<HealthStatus, number>>) => ({ ...emptyCounts(), ...parts })

/** Each mark with the figure beside it, in drawing order. */
const figures = (root: HTMLElement) =>
  [...root.querySelectorAll('svg')].map((glyph) => [
    glyph.getAttribute('data-status'),
    glyph.parentElement?.parentElement?.textContent,
  ])

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

const overrides = registryOverrides()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  overrides.restore()
})

describe('InfrastructureHealthPanel', () => {
  it('is panel [4]: a labelled, solid region marked mock (only its sub-elements say they are not connected)', async () => {
    renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
    expect(region()).toHaveAttribute('aria-keyshortcuts', '4')
    expect(region()).not.toHaveAttribute('data-planned')
    expect(region()).not.toHaveAttribute('aria-describedby')
    expect(within(region()).getByText(/^mock/)).toBeInTheDocument()
    await screen.findByText('SERVERS')
    // The SNMP row and BY SITE each carry their own marker; the header does not.
    expect(within(region()).getAllByText('Not connected')).toHaveLength(2)
    // Neither is claimed to be unimplemented, nor to be missing its setup: nothing says either.
    expect(within(region()).queryByText('Needs setup')).toBeNull()
    expect(within(region()).queryByText('Planned')).toBeNull()
    expect(
      within(region().querySelector('header') as HTMLElement).queryByText('Not connected'),
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

  describe('provenance', () => {
    const header = () => region().querySelector('header') as HTMLElement
    const rowOf = (label: string) => screen.getByText(label).closest('li') as HTMLElement
    const overHttp = (data: HealthBreakdown = breakdown()) =>
      createTestApi({ getHealthBreakdown: vi.fn(async () => data), source: 'http' })
    /** Every domain counted from real figures, as a connected API answers. */
    const counted = () => breakdown({ domains: DOMAINS.map((d) => ({ ...d, planned: false })) })

    it.each(['overview', 'site-links'] as const)(
      'stays mock over http while %s is not connected, since the figures mix demo and real data',
      async (id) => {
        overrides.set(id, { connected: false })
        renderApp(<InfrastructureHealthPanel />, { api: overHttp() })
        await screen.findByText('SERVERS')
        expect(within(header()).getByText(/^mock/)).toBeInTheDocument()
        expect(within(header()).queryByText(/^live/)).toBeNull()
      },
    )

    it('is tagged live over http as shipped: the counts and the site assignment come from the console API', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: overHttp(counted()) })
      await screen.findByText('SERVERS')
      expect(within(header()).getByText(/^live/)).toBeInTheDocument()
    })

    it('marks the rows of what the console API does not serve, with no figure in them', async () => {
      const planned = breakdown({
        domains: DOMAINS.map((d) =>
          d.domain === 'targets' || d.domain === 'snmp'
            ? { ...d, counts: counts({}), planned: true }
            : d,
        ),
      })
      renderApp(<InfrastructureHealthPanel />, { api: overHttp(planned) })
      await screen.findByText('SERVERS')
      for (const label of ['NET TARGETS', 'SNMP DEVS']) {
        const row = rowOf(label)
        expect(within(row).getByText('Not connected')).toBeInTheDocument()
        expect(row.querySelector('svg[data-status]:not([data-status="planned"])')).toBeNull()
      }
      // The panel itself is not marked down for it: its counted rows are real.
      expect(within(header()).getByText(/^live/)).toBeInTheDocument()
    })

    it('is tagged live, with nothing marked as sample data, once every feature is connected over http', async () => {
      overrides.connectAll()
      renderApp(<InfrastructureHealthPanel />, { api: overHttp(counted()) })
      await screen.findByText('SERVERS')
      expect(within(header()).getByText(/^live/)).toBeInTheDocument()
      expect(within(header()).queryByText(/^mock/)).toBeNull()
      expect(within(region()).queryByText('Not connected')).toBeNull()
      expect(within(region()).queryByText('sample data')).toBeNull()
      expect(screen.getByRole('heading', { name: 'By site' })).toHaveTextContent(/^By site$/)
      expect(screen.getByRole('list', { name: 'By site' })).not.toHaveAccessibleDescription()
    })

    it('marks only BY SITE as sample data while the site assignment is the one feature not connected', async () => {
      overrides.connectAll()
      overrides.set('site-links', { connected: false })
      renderApp(<InfrastructureHealthPanel />, { api: overHttp(counted()) })
      await screen.findByText('SERVERS')
      expect(within(header()).getByText(/^mock/)).toBeInTheDocument()
      expect(within(region()).getAllByText('Not connected')).toHaveLength(1)
      expect(screen.getByRole('heading', { name: /by site/i }).parentElement).toHaveTextContent(
        'Not connected',
      )
      expect(within(region()).getByText('sample data')).toBeInTheDocument()
    })

    it('marks only the SNMP row as not connected while SNMP is the one feature not connected', async () => {
      overrides.connectAll()
      overrides.set('snmp', { connected: false })
      renderApp(<InfrastructureHealthPanel />, { api: overHttp() })
      await screen.findByText('SERVERS')
      expect(within(header()).getByText(/^live/)).toBeInTheDocument()
      expect(within(region()).getAllByText('Not connected')).toHaveLength(1)
      expect(within(rowOf('SNMP DEVS')).getByText('Not connected')).toBeInTheDocument()
      expect(within(region()).queryByText('sample data')).toBeNull()
    })

    it('keeps the SNMP row marked while the backend only stores SNMP, whatever the registry claims', async () => {
      overrides.connectAll()
      overrides.set('snmp', { connected: true })
      renderApp(<InfrastructureHealthPanel />, { api: overHttp() })
      await screen.findByText('SERVERS')
      expect(within(rowOf('SNMP DEVS')).getByText('Not connected')).toBeInTheDocument()
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
      expect(figures(counted)).toEqual([
        ['critical', '2'],
        ['warning', '1'],
        ['idle', '3'],
        ['healthy', '62'],
      ])
    })

    it('shows offline servers apart from critical in the bar, the counts and the name', async () => {
      const domains = [
        {
          ...DOMAINS[0],
          counts: { ...counts({ critical: 2, warning: 2, healthy: 12 }), offline: 1 },
        },
        ...DOMAINS.slice(1),
      ] as DomainBreakdown[]
      renderApp(<InfrastructureHealthPanel />, { api: apiWith(async () => breakdown({ domains })) })
      const bar = await screen.findByRole('img', {
        name: 'Servers: 1 critical, 1 offline, 2 warning, 12 ok',
      })
      expect(
        [...bar.querySelectorAll('[data-status]')].map((part) => part.getAttribute('data-status')),
      ).toEqual(['critical', 'offline', 'warning', 'healthy'])
      const row = (await screen.findByText('SERVERS')).closest('li') as HTMLElement
      const counted = row.querySelector('[aria-hidden="true"]') as HTMLElement
      expect(figures(counted)).toEqual([
        ['critical', '1'],
        ['offline', '1'],
        ['warning', '2'],
        ['healthy', '12'],
      ])
    })

    it('shows the SNMP row as a placeholder bar with a NOT CONNECTED chip and no counts', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const row = (await screen.findByText('SNMP DEVS')).closest('li') as HTMLElement
      expect(
        within(row).getByRole('img', { name: 'SNMP devices: no SNMP data' }),
      ).toBeInTheDocument()
      expect(within(row).getByText('Not connected')).toBeInTheDocument()
      expect(within(row).queryByText('Planned')).toBeNull()
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

  describe('domain row details', () => {
    beforeEach(() => stubFocusVisible())

    const rowOf = (label: string) => screen.getByText(label).closest('li') as HTMLElement

    /** The state rows of an open tooltip: word, count, share. */
    const tipRows = (tip: HTMLElement) =>
      [...tip.querySelectorAll('li')].map((item) =>
        [...item.children].map((cell) => cell.textContent),
      )

    const withServers = (serverCounts: StatusCounts) =>
      apiWith(async () =>
        breakdown({
          domains: [
            { domain: 'servers', label: 'SERVERS', counts: serverCounts },
            ...DOMAINS.slice(1),
          ],
        }),
      )

    it('gives each counted domain row one tab stop, and the SNMP row none', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      for (const label of ['SERVERS', 'CONTAINERS', 'NET TARGETS'])
        expect(rowOf(label)).toHaveAttribute('tabindex', '0')
      expect(rowOf('SNMP DEVS')).not.toHaveAttribute('tabindex')
    })

    it('opens on keyboard focus, row by row, and the next tab stop after the rows is the first site', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      for (const label of ['SERVERS', 'CONTAINERS', 'NET TARGETS']) {
        await user.tab()
        expect(rowOf(label)).toHaveFocus()
        expect(screen.getByRole('tooltip')).toBeInTheDocument()
      }
      await user.tab()
      expect(siteLinks()[0]).toHaveFocus()
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('lists every state that has members with its count and share, and the domain total', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      await user.tab()
      await user.tab()
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent('Containers')
      expect(tip).toHaveTextContent('68 total')
      expect(tipRows(tip)).toEqual([
        ['CRIT', '2', '3%'],
        ['WARN', '1', '1%'],
        ['IDLE', '3', '4%'],
        ['OK', '62', '91%'],
      ])
      // Glyph, word and color: the state is never color alone.
      expect(
        [...tip.querySelectorAll('svg')].map((glyph) => glyph.getAttribute('data-status')),
      ).toEqual(['critical', 'warning', 'idle', 'healthy'])
      expect(rowOf('CONTAINERS')).toHaveAccessibleDescription(
        'Containers 68 total CRIT 2 3% WARN 1 1% IDLE 3 4% OK 62 91%',
      )
    })

    it('says the same as the bar: the name still lists every count and the tooltip agrees with it', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      await user.tab()
      await user.tab()
      const bar = within(rowOf('CONTAINERS')).getByRole('img')
      expect(bar).toHaveAccessibleName('Containers: 2 critical, 1 warning, 3 idle, 62 ok')
      const nameOf = Object.fromEntries(
        (Object.keys(STATUS_WORD) as DisplayStatus[]).map((status) => [
          STATUS_WORD[status],
          STATUS_NAME[status],
        ]),
      )
      const spoken = tipRows(screen.getByRole('tooltip')).map(
        ([word, count]) => `${count} ${nameOf[word as string]}`,
      )
      expect(bar).toHaveAccessibleName(`Containers: ${spoken.join(', ')}`)
    })

    it('opens on hover after a short delay and closes when the pointer leaves', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      await user.hover(rowOf('SERVERS'))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      const tip = await screen.findByRole('tooltip')
      expect(tipRows(tip)).toEqual([
        ['CRIT', '1', '6%'],
        ['WARN', '2', '13%'],
        ['OK', '13', '81%'],
      ])
      await user.unhover(rowOf('SERVERS'))
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    })

    it('closes on Escape and leaves focus on the row', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      await user.tab()
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(rowOf('SERVERS')).toHaveFocus()
    })

    it('draws no native title on the segments, so only one tooltip opens', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      for (const label of ['SERVERS', 'CONTAINERS', 'NET TARGETS'])
        expect(rowOf(label).querySelector('[title]')).toBeNull()
    })

    it('lists offline apart and says in words that it counts as critical in the verdict', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, {
        api: withServers({ ...counts({ critical: 3, warning: 2, healthy: 11 }), offline: 2 }),
      })
      await screen.findByText('SERVERS')
      await user.tab()
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent('16 total')
      expect(tipRows(tip)).toEqual([
        ['CRIT', '1', '6%'],
        ['OFFL', '2', '13%'],
        ['WARN', '2', '13%'],
        ['OK', '11', '69%'],
      ])
      expect(tip).toHaveTextContent(
        'Offline counts as critical in the verdict, which makes 3 of 16 critical.',
      )
      expect(tip.querySelector('svg[data-status="offline"]')).not.toBeNull()
    })

    it('words the offline sentence the same way for a single critical server', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, {
        api: withServers({ ...counts({ critical: 1, healthy: 15 }), offline: 1 }),
      })
      await screen.findByText('SERVERS')
      await user.tab()
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Offline counts as critical in the verdict, which makes 1 of 16 critical.',
      )
    })

    it('does not mention offline when no server is offline', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      await user.tab()
      expect(screen.getByRole('tooltip')).not.toHaveTextContent(/offline/i)
    })

    it('never shows 0% for a state with members or 100% for part of the whole', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, {
        api: withServers(counts({ critical: 1, healthy: 399 })),
      })
      await screen.findByText('SERVERS')
      await user.tab()
      expect(tipRows(screen.getByRole('tooltip'))).toEqual([
        ['CRIT', '1', '<1%'],
        ['OK', '399', '>99%'],
      ])
    })

    it('shows 100% when one state is the whole domain', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: withServers(counts({ healthy: 16 })) })
      await screen.findByText('SERVERS')
      await user.tab()
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent('16 total')
      expect(tipRows(tip)).toEqual([['OK', '16', '100%']])
    })

    it('gives the SNMP row no tooltip, so nothing claims numbers for it', async () => {
      const user = userEvent.setup()
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SNMP DEVS')
      const row = rowOf('SNMP DEVS')
      await user.hover(row)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      expect(row).not.toHaveAttribute('aria-describedby')
      expect(within(row).getByRole('img')).toHaveAccessibleName('SNMP devices: no SNMP data')
    })

    it('gives a domain with nothing counted no tooltip and no tab stop', async () => {
      renderApp(<InfrastructureHealthPanel />, {
        api: withServers(counts({})),
      })
      await screen.findByText('SERVERS')
      expect(rowOf('SERVERS')).not.toHaveAttribute('tabindex')
      expect(within(rowOf('SERVERS')).getByText('none')).toBeInTheDocument()
    })
  })

  describe('BY SITE', () => {
    it('is marked not connected and as sample data over the sample API, with its reason available to everyone', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      const list = await screen.findByRole('list', { name: 'By site' })
      const heading = screen.getByRole('heading', { name: /by site/i })
      expect(heading).toHaveTextContent('By site †')
      expect(heading.parentElement).toHaveTextContent('Not connected')
      expect(heading.parentElement).toHaveTextContent('sample data')
      expect(list).toHaveAccessibleDescription(
        /supports placing servers and probe targets on a site/,
      )
      expect(list).toHaveAccessibleDescription(/the console API filters by it/)
      expect(list).not.toHaveAccessibleDescription(/not linked to sites|setup/i)
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

    it('names an offline server apart in the link and strip, and ranks its site as critical', async () => {
      const offline: SiteBreakdown = {
        siteId: 'site-pir',
        customerName: 'Meridian',
        siteName: 'Piraeus',
        entities: [
          { id: 'pir-fs-01', kind: 'server', name: 'pir-fs-01', status: 'critical', offline: true },
          ...entities('p', [['healthy', 6]]),
        ],
      }
      // Offline counts as critical for ranking: two outrank one, and one outranks none.
      const twin: SiteBreakdown = {
        siteId: 'site-twin',
        customerName: 'Zed',
        siteName: 'Twin',
        entities: [
          { id: 't1', kind: 'server', name: 'twin-1', status: 'critical', offline: true },
          { id: 't2', kind: 'server', name: 'twin-2', status: 'critical' },
          ...entities('t', [['healthy', 4]]),
        ],
      }
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(async () => breakdown({ sites: [SITES[0] as SiteBreakdown, offline, twin] })),
      })
      await screen.findByRole('list', { name: /by site/i })
      expect(siteLinks().map((link) => link.getAttribute('href'))).toEqual([
        '/customers?site=site-twin',
        '/customers?site=site-pir',
        '/customers?site=site-initech',
      ])
      expect(
        screen.getByRole('link', {
          name: 'Meridian / Piraeus: 1 offline (pir-fs-01), 6 ok',
        }),
      ).toBeInTheDocument()
      const link = screen.getByRole('link', {
        name: 'Zed / Twin: 1 critical (twin-2), 1 offline (twin-1), 4 ok',
      })
      expect(
        [...link.querySelectorAll('svg')].map((glyph) => glyph.getAttribute('data-status')),
      ).toEqual(['critical', 'critical', 'offline', 'healthy', 'healthy', 'healthy', 'healthy'])
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

    it('says so when there are no site assignments, and keeps the not-connected marker', async () => {
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(async () => breakdown({ sites: [] })),
      })
      expect(await screen.findByText('No site assignments yet')).toBeInTheDocument()
      expect(screen.queryByRole('list', { name: /by site/i })).not.toBeInTheDocument()
      expect(within(region()).getAllByText('Not connected')).toHaveLength(2)
    })
  })

  describe('footer', () => {
    /** The legend's words, left to right. */
    const legendWords = () =>
      within(screen.getByRole('list', { name: 'Status legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)

    const moreSites = ['d', 'e'].map((id) => ({
      siteId: `site-${id}`,
      customerName: 'Zed',
      siteName: id,
      entities: entities(id, [['healthy', 2]]),
    }))

    const servers = (parts: Partial<Record<HealthStatus, number>>, offline?: number) =>
      ({
        domain: 'servers',
        label: 'SERVERS',
        counts: offline ? { ...counts(parts), offline } : counts(parts),
      }) as DomainBreakdown

    it('explains OK, WARN and CRIT, then the other states the panel draws', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      // Idle containers are drawn; unknown only exists in the SNMP row, which draws no marks.
      expect(legendWords()).toEqual(['OK', 'WARN', 'CRIT', 'IDLE'])
      const legend = screen.getByRole('list', { name: 'Status legend' })
      expect(
        [...legend.querySelectorAll('svg')].map((glyph) => glyph.getAttribute('data-status')),
      ).toEqual(['healthy', 'warning', 'critical', 'idle'])
    })

    it('lists all six states in the order of the legend when each is drawn', async () => {
      const alphabet = render(<StatusLegend />)
      const order = [...alphabet.container.querySelectorAll('li')].map((item) => item.textContent)
      alphabet.unmount()

      const domains = [servers({ critical: 2, warning: 1, unknown: 1, idle: 1, healthy: 9 }, 1)]
      renderApp(<InfrastructureHealthPanel />, { api: apiWith(async () => breakdown({ domains })) })
      await waitFor(() => expect(legendWords()).toHaveLength(6))
      expect(legendWords()).toEqual(order)
      expect(order).toEqual(['OK', 'WARN', 'CRIT', 'OFFL', 'UNKN', 'IDLE'])
    })

    it('lists a state that only a listed site draws, but not one that only the SNMP row or a hidden site holds', async () => {
      const unknownSite: SiteBreakdown = {
        siteId: 'site-u',
        customerName: 'Zed',
        siteName: 'Unknown',
        entities: entities('u', [
          ['unknown', 1],
          ['healthy', 1],
        ]),
      }
      const idleSite: SiteBreakdown = {
        siteId: 'site-i',
        customerName: 'Zed',
        siteName: 'Idle',
        entities: entities('i', [['idle', 2]]),
      }
      const domains = [servers({ warning: 1, healthy: 3 }), DOMAINS[3] as DomainBreakdown]

      // Listed: it ranks among the three worst sites.
      const listed = apiWith(async () =>
        breakdown({
          domains,
          sites: [unknownSite, SITES[1] as SiteBreakdown, SITES[2] as SiteBreakdown],
        }),
      )
      const { unmount } = renderApp(<InfrastructureHealthPanel />, { api: listed })
      await waitFor(() => expect(legendWords()).toEqual(['OK', 'WARN', 'CRIT', 'UNKN']))
      unmount()

      // Hidden: the idle site ranks last of four, so its marks are not drawn.
      const hidden = apiWith(async () => breakdown({ domains, sites: [...SITES, idleSite] }))
      renderApp(<InfrastructureHealthPanel />, { api: hidden })
      await screen.findByRole('link', { name: '+1 more site' })
      expect(legendWords()).toEqual(['OK', 'WARN', 'CRIT'])
    })

    it('keeps the legend while loading, with the states every panel explains', () => {
      renderApp(<InfrastructureHealthPanel />, {
        api: apiWith(() => new Promise<HealthBreakdown>(() => {})),
      })
      expect(legendWords()).toEqual(['OK', 'WARN', 'CRIT'])
    })

    it('shares one fixed-height row between the legend and the link, whatever the legend holds', async () => {
      const everything = [servers({ critical: 2, warning: 1, unknown: 1, idle: 1, healthy: 9 }, 1)]
      for (const domains of [DOMAINS, everything]) {
        const { unmount } = renderApp(<InfrastructureHealthPanel />, {
          api: apiWith(async () => breakdown({ domains, sites: [...SITES, ...moreSites] })),
        })
        const link = await screen.findByRole('link', { name: '+2 more sites' })
        const footer = region().querySelector('footer') as HTMLElement
        const legend = screen.getByRole('list', { name: 'Status legend' })
        expect([...footer.children]).toEqual([legend, link])
        // The footer's own 28px floor holds two 12px rows, so a wrapped legend does not grow it;
        // the link keeps its place and its words on one line.
        expect(footer).toHaveClass('min-h-7')
        expect(legend).toHaveClass('leading-3', 'min-w-0')
        expect(link).toHaveClass('ml-auto', 'shrink-0', 'whitespace-nowrap')
        expect(link).toHaveAttribute('href', '/customers')
        unmount()
      }
    })

    it('stacks a legend of five or six states at three marks a row until the panel is wide', async () => {
      const four = renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      expect(legendWords()).toHaveLength(4)
      const natural = screen.getByRole('list', { name: 'Status legend' })
      expect(natural.className).not.toMatch(/max-w/)
      four.unmount()

      const domains = [servers({ critical: 2, warning: 1, unknown: 1, idle: 1, healthy: 9 }, 1)]
      renderApp(<InfrastructureHealthPanel />, { api: apiWith(async () => breakdown({ domains })) })
      await waitFor(() => expect(legendWords()).toHaveLength(6))
      expect(screen.getByRole('list', { name: 'Status legend' })).toHaveClass(
        'max-w-44',
        '@min-[30rem]:max-w-none',
      )
    })

    it('has no link and the same footer row when every site is listed', async () => {
      renderApp(<InfrastructureHealthPanel />, { api: apiWith() })
      await screen.findByText('SERVERS')
      const footer = region().querySelector('footer') as HTMLElement
      expect(footer.children).toHaveLength(1)
      expect(footer).toHaveClass('min-h-7')
    })
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

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { ServerList } from '@/api/types'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import ServersListPage from './ServersListPage'

/** jsdom has no viewport: every media query answers the same, so a test picks "desktop" or "phone". */
function stubViewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}
const realMatchMedia = window.matchMedia
beforeEach(() => stubViewport(true))
afterEach(() => {
  window.matchMedia = realMatchMedia
})

const NOW = Date.parse('2026-10-12T14:00:00Z')
const mock = (scenario: Parameters<typeof createMockApi>[0] = {}) =>
  createMockApi({ now: () => NOW, delayMs: 0, ...scenario })

function Where() {
  const location = useLocation()
  return <output aria-label="location">{location.pathname + location.search}</output>
}

const page = (route = '/servers', api = mock(), auth = createFakeAuth()) =>
  renderApp(
    <>
      <Routes>
        <Route path="/servers" element={<ServersListPage />} />
        <Route path="/servers/new" element={<p>add server form</p>} />
        <Route path="/servers/:id" element={<p>detail page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, auth },
  )

const mayAdd = () => createFakeAuth({ capabilities: { ...NO_CAPABILITIES, manageServers: true } })

const table = () => screen.findByRole('table', { name: 'Servers' })
const hostnames = (t: HTMLElement) =>
  within(t)
    .getAllByRole('link')
    .map((link) => link.textContent)

describe('ServersListPage', () => {
  it('says what a deletion took with it when a server’s page sends the operator here', async () => {
    const user = userEvent.setup()
    renderApp(
      <Routes>
        <Route path="/servers" element={<ServersListPage />} />
      </Routes>,
      {
        api: mock(),
        route: {
          pathname: '/servers',
          state: {
            deleted: {
              id: 'srv-1',
              name: 'web-1',
              agent: true,
              telemetrySamples: 3,
              containers: 2,
              measurementsKept: 5,
              targetsUnassigned: 1,
              devicesUnassigned: 0,
            },
          },
        },
      },
    )
    const notice = await screen.findByText(/The server “web-1” is deleted/)
    expect(notice).toHaveTextContent('with its agent (its token no longer works)')
    expect(notice).toHaveTextContent('3 telemetry samples and 2 containers')
    expect(notice).toHaveTextContent('Kept: 5 network measurements')
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/is deleted/)).not.toBeInTheDocument()
  })

  it('lists every server worst first, with status words, and says how many it shows', async () => {
    page()
    const t = await table()
    const names = hostnames(t)
    expect(names[0]).toBe('pir-fs-01')
    expect(names).toHaveLength(16)
    expect(screen.getByText('16 of 16 shown')).toBeInTheDocument()
    expect(within(t).getByText('OFFLINE')).toBeInTheDocument()
    expect(within(t).getByText('HIGH CPU')).toBeInTheDocument()
  })

  it('shows a server that stopped reporting as offline, still critical to the edge and the filter', async () => {
    const user = userEvent.setup()
    page()
    const t = await table()
    const row = within(t).getByRole('link', { name: 'pir-fs-01' }).closest('tr') as HTMLElement
    const tag = within(row).getByText('OFFLINE').closest('[data-status]')
    expect(tag).toHaveAttribute('data-status', 'offline')
    expect(tag?.querySelector('svg')).toHaveAttribute('data-status', 'offline')
    expect(tag).toHaveClass('bg-offline-tint')
    // The severity edge reads the health, which is critical.
    expect(row.querySelector('span.w-0\\.5')).toHaveClass('bg-critical')
    // A server in another state keeps its own indicator.
    const other = within(t).getByRole('link', { name: 'ath-db-01' }).closest('tr') as HTMLElement
    expect(other.querySelector('[data-status]:not(svg)')).toHaveAttribute('data-status', 'warning')

    await user.click(screen.getByRole('button', { name: /CRIT\s*1/ }))
    expect(hostnames(await table())).toEqual(['pir-fs-01'])
  })

  it('shows no load for a host that is not reporting, and why', async () => {
    page()
    const t = await table()
    expect(within(t).getByText('No current reading: the agent stopped reporting')).toBeVisible()
    expect(within(t).getByText('No reading: never reported')).toBeVisible()
  })

  it('searches by name, address, OS and site, and keeps the search in the URL', async () => {
    const user = userEvent.setup()
    page()
    await table()
    await user.type(screen.getByRole('searchbox', { name: 'Search servers' }), 'piraeus')
    // The search is asked for once it has held still, not on every key.
    await waitFor(async () => expect(hostnames(await table())).toEqual(['pir-fs-01']))
    expect(screen.getByText('1 of 16 shown')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers?q=piraeus')
  })

  it('keeps the space typed between two words of a search', async () => {
    const user = userEvent.setup()
    page()
    await table()
    const box = screen.getByRole('searchbox', { name: 'Search servers' })
    await user.type(box, 'pir fs')
    expect(box).toHaveValue('pir fs')
  })

  it('restores the search and filter from the URL', async () => {
    page('/servers?q=ath&status=warning')
    const t = await table()
    expect(hostnames(t)).toEqual(['ath-db-01'])
    expect(screen.getByRole('button', { name: /WARN/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('filters by status from the chips, which count what each would show', async () => {
    const user = userEvent.setup()
    page()
    await table()
    expect(screen.getByRole('button', { name: /CRIT\s*1/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(hostnames(await table())).toEqual(['ath-db-01', 'fra-web-02', 'hc-bkp-01'])
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(hostnames(await table())).toHaveLength(16)
  })

  it('sorts from the column headers and tells assistive tech which way', async () => {
    const user = userEvent.setup()
    page()
    const t = await table()
    const header = (name: string) => within(t).getByRole('columnheader', { name })
    expect(header('STATUS')).toHaveAttribute('aria-sort', 'descending')

    await user.click(within(header('CPU')).getByRole('button'))
    expect(header('CPU')).toHaveAttribute('aria-sort', 'descending')
    expect(header('STATUS')).toHaveAttribute('aria-sort', 'none')
    // Busiest first; the two that cannot say come last.
    expect(hostnames(await table()).slice(-2)).toEqual(['core-ci-01', 'pir-fs-01'])
    expect(screen.getByLabelText('location')).toHaveTextContent('sort=cpu')

    await user.click(within(header('CPU')).getByRole('button'))
    expect(header('CPU')).toHaveAttribute('aria-sort', 'ascending')

    await user.click(within(header('HOSTNAME')).getByRole('button'))
    expect(hostnames(await table())[0]).toBe('ath-app-01')
  })

  it('names its SITE column plainly: the site of a real server is not a sample', async () => {
    page()
    const t = await table()
    const site = within(t).getByRole('columnheader', { name: 'SITE' })
    expect(site).toHaveTextContent(/^SITE$/)
    expect(within(t).queryByText(/†/)).toBeNull()
    expect(within(t).queryByRole('button', { name: /sample/i })).toBeNull()
  })

  it('opens a server from its hostname, and from anywhere on its row', async () => {
    const user = userEvent.setup()
    page('/servers?range=6h')
    const t = await table()
    expect(within(t).getByRole('link', { name: 'ath-db-01' })).toHaveAttribute(
      'href',
      '/servers/srv-ath-db-01?range=6h',
    )
    await user.click(within(t).getByText('143d 0h'))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers/srv-ath-db-01?range=6h')
  })

  it('opens the server the Overview queue pointed at', async () => {
    page('/servers?focus=srv-ath-db-01&range=6h')
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers/srv-ath-db-01?range=6h')
  })

  it('says so when nothing matches, and clears the search from there', async () => {
    const user = userEvent.setup()
    page('/servers?q=zzz')
    expect(await screen.findByText('No server matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!)
    expect(hostnames(await table())).toHaveLength(16)
  })

  it('says so when nothing is monitored', async () => {
    page('/servers', mock({ scenario: 'empty' }))
    expect(await screen.findByText('No servers monitored')).toBeInTheDocument()
    expect(screen.getByText('0 of 0 shown')).toBeInTheDocument()
    // An account that may not add hosts is told how one appears, and offered nothing.
    expect(screen.queryByRole('link', { name: 'Add server' })).toBeNull()
  })

  it('offers to add a server, in the header and when nothing is monitored, to an account that may', async () => {
    const user = userEvent.setup()
    page('/servers?range=6h', mock({ scenario: 'empty' }), mayAdd())
    expect(await screen.findByText('No servers monitored')).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: 'Add server' })
    expect(links).toHaveLength(2)
    for (const link of links) expect(link).toHaveAttribute('href', '/servers/new?range=6h')
    await user.click(links[1]!)
    expect(await screen.findByText('add server form')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers/new?range=6h')
  })

  it('keeps the action in the header once servers are monitored, and only for an account that may', async () => {
    page('/servers', mock(), mayAdd())
    await table()
    expect(screen.getByRole('link', { name: 'Add server' })).toHaveAttribute('href', '/servers/new')
    page('/servers')
    expect(screen.getAllByRole('link', { name: 'Add server' })).toHaveLength(1)
  })

  it('shows the loading state and then the table', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const real = mock()
    page(
      '/servers',
      createTestApi({
        listServers: vi.fn(async (options) => {
          await gate
          return real.listServers(options)
        }),
      }),
    )
    expect(screen.getByRole('region', { name: 'Servers' })).toHaveAttribute('aria-busy', 'true')
    release()
    expect(await table()).toBeInTheDocument()
  })

  it('fails in the panel, keeps the controls, and recovers on Retry', async () => {
    const user = userEvent.setup()
    const real = mock()
    const listServers = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockImplementation((options) => real.listServers(options))
    page('/servers', createTestApi({ listServers }))
    expect(await screen.findByText('Could not load servers')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search servers' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await table()).toBeInTheDocument()
    await waitFor(() => expect(listServers).toHaveBeenCalledTimes(2))
  })

  it('does not keep the previous search’s servers under a search the API refused, and says why', async () => {
    const user = userEvent.setup()
    const real = mock()
    // The console API refuses a search of more than 8 words (400 invalid_parameter).
    const listServers = vi.fn<SentinelApi['listServers']>(async (options) => {
      if ((options?.q ?? '').trim().split(/\s+/).length > 8)
        throw new ApiError('Use at most 8 words.', 400, 'invalid_parameter')
      return real.listServers(options)
    })
    page('/servers', createTestApi({ listServers }))
    await table()
    await user.click(screen.getByRole('searchbox', { name: 'Search servers' }))
    await user.paste('a b c d e f g h i')
    await waitFor(() =>
      expect(listServers).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'a b c d e f g h i' }),
      ),
    )

    expect(await screen.findByText('Use at most 8 words.')).toBeInTheDocument()
    expect(screen.getByText('Could not load servers')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Servers' })).toBeNull()
    expect(screen.queryByText(/of 16 shown/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('carries the scope to the API', async () => {
    const real = mock()
    const listServers = vi.fn((options) => real.listServers(options))
    page('/servers?customer=cus-meridian', createTestApi({ listServers }))
    await table()
    expect(listServers).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { customerId: 'cus-meridian', siteId: null } }),
    )
  })
})

describe('ServersListPage on a phone', () => {
  it('shows the offline server as offline on its card, with the critical edge', async () => {
    stubViewport(false)
    page()
    const list = await screen.findByRole('list', { name: 'Servers' })
    const card = within(list)
      .getByRole('link', { name: /pir-fs-01/ })
      .closest('li') as HTMLElement
    expect(within(card).getByText('OFFLINE').closest('[data-status]')).toHaveAttribute(
      'data-status',
      'offline',
    )
    expect(card.querySelector('span.w-0\\.5')).toHaveClass('bg-critical')
  })

  it('becomes a list of cards, with a sort menu instead of column headers', async () => {
    stubViewport(false)
    const user = userEvent.setup()
    page()
    const list = await screen.findByRole('list', { name: 'Servers' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(16)
    expect(screen.queryByRole('table')).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'name')
    expect(
      within(await screen.findByRole('list', { name: 'Servers' })).getAllByRole('link')[0],
    ).toHaveTextContent('ath-app-01')
  })
})

describe('ServersListPage over the console API', () => {
  /** A list the way the console API answers it: one page of many, with its own counts and totals. */
  async function paged(overrides: Partial<ServerList> = {}): Promise<ServerList> {
    const everyone = await mock().listServers()
    return {
      ...everyone,
      items: everyone.items.slice(0, 3),
      page: { number: 2, size: 50, total: 130, pages: 3 },
      counts: { healthy: 100, warning: 20, critical: 8, unknown: 2, idle: 0 },
      scopeTotal: 230,
      ...overrides,
    }
  }
  const served = (...lists: (ServerList | Error)[]) => {
    const listServers = vi.fn<SentinelApi['listServers']>(async () => {
      const next =
        lists.length > 1 ? (lists.shift() as ServerList | Error) : (lists[0] as ServerList)
      if (next instanceof Error) throw next
      return next
    })
    return { api: createTestApi({ listServers }), listServers }
  }

  it('asks for one page of the query, not the fleet, and sends the paging with it', async () => {
    const { api, listServers } = served(await paged())
    page('/servers?q=db&status=warning&sort=cpu&dir=asc&page=2', api)
    await table()
    expect(listServers).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'db',
        status: 'warning',
        sort: 'cpu',
        dir: 'asc',
        page: 2,
        pageSize: 50,
      }),
    )
  })

  it("says what the console API counted: the matches, the scope and each chip's figure", async () => {
    const { api } = served(await paged())
    page('/servers?page=2', api)
    await table()
    expect(screen.getByText('130 of 230 shown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /CRIT\s*8/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WARN\s*20/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ALL\s*130/ })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pages' })).toHaveTextContent(
      '51–53 of 130 · page 2 of 3',
    )
  })

  it('pages with Previous and Next, keeps the page in the URL and asks for it', async () => {
    const user = userEvent.setup()
    const { api, listServers } = served(await paged())
    page('/servers?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers?page=3')
    await waitFor(() =>
      expect(listServers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })),
    )
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    expect(screen.getByLabelText('location')).not.toHaveTextContent('page=')
  })

  it('stops at the first and the last page', async () => {
    const first = served(await paged({ page: { number: 1, size: 50, total: 130, pages: 3 } }))
    const { unmount } = page('/servers', first.api)
    await table()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    unmount()
    const last = served(await paged({ page: { number: 3, size: 50, total: 130, pages: 3 } }))
    page('/servers?page=3', last.api)
    await table()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('starts again from the first page when the search or the filter changes', async () => {
    const user = userEvent.setup()
    const { api } = served(await paged())
    page('/servers?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers?status=warning')
    expect(screen.getByLabelText('location')).not.toHaveTextContent('page=')
  })

  it('goes to the last page when the one asked for is past the end', async () => {
    const past = await paged({
      items: [],
      page: { number: 9, size: 50, total: 130, pages: 3 },
    })
    const { api, listServers } = served(
      past,
      await paged({ page: { number: 3, size: 50, total: 130, pages: 3 } }),
    )
    page('/servers?page=9', api)
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('/servers?page=3'),
    )
    await waitFor(() =>
      expect(listServers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })),
    )
  })

  it('treats a page number it cannot use as the first page', async () => {
    const { api, listServers } = served(
      await paged({ page: { number: 1, size: 50, total: 130, pages: 3 } }),
    )
    page('/servers?page=banana', api)
    await table()
    expect(listServers).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }))
  })

  it('shows a stale reading as no current reading, never as a load, and keeps the rows of current ones', async () => {
    const everyone = await mock().listServers()
    const [first, second] = everyone.items
    const stale = {
      ...first!,
      health: 'unknown' as const,
      server: {
        ...first!.server,
        status: 'online' as const,
        telemetry: { ...first!.server.telemetry!, cpuPercent: 99, stale: true },
      },
    }
    const current = {
      ...second!,
      server: { ...second!.server, status: 'online' as const },
    }
    const { api } = served(await paged({ items: [stale, current] }))
    page('/servers?page=2', api)
    const t = await table()
    const row = within(t)
      .getByRole('link', { name: stale.server.name })
      .closest('tr') as HTMLElement
    expect(within(row).getByText('No current reading: the last one is stale')).toBeInTheDocument()
    expect(within(row).queryByRole('meter')).toBeNull()
    expect(within(row).queryByText(/99/)).toBeNull()
    const other = within(t)
      .getByRole('link', { name: current.server.name })
      .closest('tr') as HTMLElement
    expect(within(other).getAllByRole('meter')).toHaveLength(3)
  })

  it('says nothing is monitored only when the scope itself is empty', async () => {
    const { api } = served(
      await paged({
        items: [],
        page: { number: 1, size: 50, total: 0, pages: 1 },
        counts: { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 },
        scopeTotal: 0,
      }),
    )
    page('/servers', api)
    expect(await screen.findByText('No servers monitored')).toBeInTheDocument()
  })

  it('says no server matches, not that none is monitored, when the search finds nothing', async () => {
    const { api } = served(
      await paged({
        items: [],
        page: { number: 1, size: 50, total: 0, pages: 1 },
        counts: { healthy: 0, warning: 0, critical: 0, unknown: 0, idle: 0 },
        scopeTotal: 230,
      }),
    )
    page('/servers?q=zzz', api)
    expect(await screen.findByText('No server matches')).toBeInTheDocument()
    expect(screen.queryByText('No servers monitored')).toBeNull()
  })

  it('shows the failure, not demo servers, when the request fails', async () => {
    const { api } = served(new ApiError('Cannot reach the server.', null, 'network'))
    page('/servers', api)
    expect(await screen.findByText('Cannot reach the server.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Servers' })).toBeNull()
  })

  it('shows an unusable answer as an error too', async () => {
    const { api } = served(
      new ApiError('The server sent an unexpected answer.', null, 'bad_response'),
    )
    page('/servers', api)
    expect(await screen.findByText('The server sent an unexpected answer.')).toBeInTheDocument()
  })
})

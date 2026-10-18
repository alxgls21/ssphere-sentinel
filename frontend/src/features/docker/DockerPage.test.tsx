import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { ContainerList } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import DockerPage from './DockerPage'

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
const overrides = registryOverrides()
beforeEach(() => stubViewport(true))
afterEach(() => {
  window.matchMedia = realMatchMedia
  overrides.restore()
})

const NOW = Date.parse('2026-10-12T14:00:00Z')
const mock = (scenario: Parameters<typeof createMockApi>[0] = {}) =>
  createMockApi({ now: () => NOW, delayMs: 0, ...scenario })

function Where() {
  const location = useLocation()
  return <output aria-label="location">{location.pathname + location.search}</output>
}

const page = (route = '/docker', api: SentinelApi = mock()) =>
  renderApp(
    <>
      <Routes>
        <Route path="/docker" element={<DockerPage />} />
        <Route path="/servers/:id" element={<p>server page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route },
  )

const table = () => screen.findByRole('table', { name: 'Containers' })
const names = (t: HTMLElement) =>
  within(t)
    .getAllByRole('row')
    .slice(1)
    .map(
      (row) =>
        within(row).getAllByRole('cell')[1]?.querySelector('.type-data-strong')?.textContent ?? '',
    )

describe('DockerPage over the sample fleet', () => {
  it('lists the containers worst first and says how many it shows', async () => {
    page()
    const t = await table()
    const total = (await mock().listContainers()).scopeTotal
    expect(screen.getByText(`${total} of ${total} shown`)).toBeInTheDocument()
    expect(within(t).getAllByRole('row').length).toBeGreaterThan(1)
    const first = within(t).getAllByRole('row')[1] as HTMLElement
    expect(first.querySelector('[data-status]:not(svg)')).toHaveAttribute('data-status', 'critical')
  })

  it('shows identity, host, state, health and start for each container', async () => {
    page()
    const t = await table()
    for (const header of [
      'STATUS',
      'NAME',
      'IMAGE',
      'HOST',
      'SITE',
      'STATE',
      'HEALTH',
      'STARTED',
    ]) {
      expect(within(t).getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    const row = within(t).getByText('pgbouncer').closest('tr') as HTMLElement
    expect(within(row).getByText('UNHEALTHY')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'ath-db-01' })).toHaveAttribute(
      'href',
      '/servers/srv-ath-db-01',
    )
    expect(within(row).getByText('unhealthy')).toBeInTheDocument()
    expect(within(row).getByText('running')).toBeInTheDocument()
    expect(within(row).getByText(/ago$/)).toBeInTheDocument()
  })

  it('says a container on a host that is not reporting has no current state, and shows no start', async () => {
    page()
    const t = await table()
    const row = within(t).getByText('samba').closest('tr') as HTMLElement
    expect(within(row).getByText('UNKNOWN')).toBeInTheDocument()
    expect(within(row).getByText('unknown', { selector: 'span' })).toBeInTheDocument()
    expect(within(row).queryByText(/ago$/)).toBeNull()
    expect(row.querySelector('span.w-0\\.5')).toHaveClass('bg-fg-faint')
    // The footer counts them, in words that do not claim to know which of the causes it is.
    expect(
      screen.getByText(/with no current state: host not reporting, Docker unavailable/),
    ).toBeInTheDocument()
  })

  it('filters by status from the chips, which count what each would show', async () => {
    const user = userEvent.setup()
    page()
    await table()
    const { counts } = await mock().listContainers()
    expect(counts.critical).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: new RegExp(`CRIT\\s*${counts.critical}$`) }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /CRIT/ }))
    await waitFor(async () => expect(names(await table())).toHaveLength(counts.critical))
    expect(screen.getByLabelText('location')).toHaveTextContent('/docker?status=critical')
    await user.click(screen.getByRole('button', { name: /IDLE/ }))
    await waitFor(async () => expect(names(await table()).length).toBeGreaterThan(2))
  })

  it('searches by name, image, host and site, and keeps the search in the URL', async () => {
    const user = userEvent.setup()
    page()
    await table()
    await user.type(screen.getByRole('searchbox', { name: 'Search containers' }), 'pgbouncer')
    // The header counts the new answer's rows: once it says one, the rows are the new ones too.
    expect(await screen.findByText('1 of 58 shown')).toBeInTheDocument()
    expect(names(await table())).toEqual(['pgbouncer'])
    expect(screen.getByLabelText('location')).toHaveTextContent('/docker?q=pgbouncer')
    await user.clear(screen.getByRole('searchbox', { name: 'Search containers' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search containers' }), 'ath-db-01')
    await waitFor(async () => {
      const found = names(await table())
      expect(found.length).toBeGreaterThan(0)
      expect(found).toContain('postgres')
    })
  })

  it('sorts from the column headers and tells assistive tech which way', async () => {
    const user = userEvent.setup()
    page()
    const t = await table()
    const header = (name: string) => within(t).getByRole('columnheader', { name })
    expect(header('STATUS')).toHaveAttribute('aria-sort', 'descending')
    await user.click(within(header('NAME')).getByRole('button'))
    expect(header('NAME')).toHaveAttribute('aria-sort', 'ascending')
    const ascending = names(await table())
    expect(ascending).toEqual(
      [...ascending].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    )
    expect(screen.getByLabelText('location')).toHaveTextContent('sort=name')
    await user.click(within(header('NAME')).getByRole('button'))
    expect(header('NAME')).toHaveAttribute('aria-sort', 'descending')
    await user.click(within(header('HOST')).getByRole('button'))
    expect(header('HOST')).toHaveAttribute('aria-sort', 'ascending')
    await user.click(within(header('STARTED')).getByRole('button'))
    expect(header('STARTED')).toHaveAttribute('aria-sort', 'descending')
  })

  it('limits the list to one host and offers to clear it', async () => {
    const user = userEvent.setup()
    page('/docker?server=srv-ath-db-01')
    await waitFor(async () => {
      const found = names(await table())
      expect(found.length).toBeGreaterThan(0)
      expect(found).toContain('pgbouncer')
      expect(found).not.toContain('samba')
    })
    await user.click(screen.getByRole('button', { name: /Host: ath-db-01/ }))
    expect(screen.getByLabelText('location')).not.toHaveTextContent('server=')
    await waitFor(async () => expect(names(await table())).toContain('samba'))
  })

  it('points at one container of a host: the host’s list, with that row marked', async () => {
    const list = await mock().listContainers()
    const target = list.items.find((entry) => entry.container.name === 'pgbouncer')!
    page(`/docker?focus=${encodeURIComponent(`srv-ath-db-01:${target.container.id}`)}`)
    // The mock's ids carry no host, so a host is taken from the part before the colon.
    await waitFor(async () => {
      const found = names(await table())
      expect(found).toContain('pgbouncer')
      expect(found).not.toContain('samba')
    })
  })

  it('opens the host of a container from its name', async () => {
    const user = userEvent.setup()
    page()
    const t = await table()
    await user.click(within(t).getAllByRole('link', { name: 'ath-db-01' })[0] as HTMLElement)
    expect(await screen.findByText('server page')).toBeInTheDocument()
  })

  it('says nothing is reported, and not that Docker is fine, for an empty inventory', async () => {
    page('/docker', mock({ scenario: 'empty' }))
    expect(await screen.findByText('No containers reported')).toBeInTheDocument()
    expect(screen.getByText(/Docker is not running there, or its agent cannot read/)).toBeVisible()
    expect(screen.getByText('0 of 0 shown')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says no container matches, with a way back, when the search finds none', async () => {
    const user = userEvent.setup()
    page('/docker?q=zzzz')
    expect(await screen.findByText('No container matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    await table()
    expect(screen.getByLabelText('location')).not.toHaveTextContent('q=')
  })

  it('says a host has no containers, apart from an empty fleet', async () => {
    page('/docker?server=srv-does-not-exist')
    expect(await screen.findByText('No containers on this host')).toBeInTheDocument()
  })
})

describe('DockerPage on a phone', () => {
  it('becomes a list of cards with a sort menu, still showing state, health and host', async () => {
    stubViewport(false)
    const user = userEvent.setup()
    page()
    const list = await screen.findByRole('list', { name: 'Containers' })
    expect(screen.queryByRole('table')).toBeNull()
    const card = within(list).getByText('pgbouncer').closest('li') as HTMLElement
    expect(within(card).getByRole('link', { name: 'ath-db-01' })).toBeInTheDocument()
    expect(within(card).getByText(/state running · health unhealthy/)).toBeInTheDocument()
    const unknown = within(list).getByText('samba').closest('li') as HTMLElement
    expect(within(unknown).getByText(/No current state/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'name')
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('sort=name'))
  })
})

describe('DockerPage over the console API', () => {
  /** A list the way the console API answers it: one page of many, with its own counts and totals. */
  async function paged(over: Partial<ContainerList> = {}): Promise<ContainerList> {
    const everyone = await mock().listContainers()
    return {
      ...everyone,
      items: everyone.items.slice(0, 3),
      page: { number: 2, size: 50, total: 130, pages: 3 },
      counts: { healthy: 100, warning: 20, critical: 8, unknown: 2, idle: 0 },
      scopeTotal: 230,
      ...over,
    }
  }
  const served = (...lists: (ContainerList | Error)[]) => {
    const listContainers = vi.fn<SentinelApi['listContainers']>(async () => {
      const next =
        lists.length > 1 ? (lists.shift() as ContainerList | Error) : (lists[0] as ContainerList)
      if (next instanceof Error) throw next
      return next
    })
    return { api: createTestApi({ listContainers }), listContainers }
  }

  it('asks for one page of the query, not the inventory, with the paging', async () => {
    const { api, listContainers } = served(await paged())
    page('/docker?q=pg&status=warning&sort=server&dir=desc&page=2&server=srv-1', api)
    await table()
    expect(listContainers).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'pg',
        status: 'warning',
        sort: 'server',
        dir: 'desc',
        page: 2,
        pageSize: 50,
        server: 'srv-1',
      }),
    )
  })

  it("says what the console API counted: the matches, the scope and each chip's figure", async () => {
    const { api } = served(await paged())
    page('/docker?page=2', api)
    await table()
    expect(screen.getByText('130 of 230 shown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /CRIT\s*8/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WARN\s*20/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /UNKN\s*2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ALL\s*130/ })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pages' })).toHaveTextContent(
      '51–53 of 130 · page 2 of 3',
    )
  })

  it('pages with Previous and Next, keeps the page in the URL and asks for it', async () => {
    const user = userEvent.setup()
    const { api, listContainers } = served(await paged())
    page('/docker?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/docker?page=3')
    await waitFor(() =>
      expect(listContainers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })),
    )
  })

  it('starts again from the first page when the search or the filter changes', async () => {
    const user = userEvent.setup()
    const { api } = served(await paged())
    page('/docker?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/docker?status=warning')
    expect(screen.getByLabelText('location')).not.toHaveTextContent('page=')
  })

  it('goes to the last page when the one asked for is past the end', async () => {
    const past = await paged({ items: [], page: { number: 9, size: 50, total: 130, pages: 3 } })
    const { api, listContainers } = served(
      past,
      await paged({ page: { number: 3, size: 50, total: 130, pages: 3 } }),
    )
    page('/docker?page=9', api)
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('/docker?page=3'),
    )
    await waitFor(() =>
      expect(listContainers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })),
    )
  })

  it('carries the topbar scope in the request', async () => {
    const { api, listContainers } = served(await paged())
    page('/docker?customer=cus-meridian', api)
    await table()
    expect(listContainers).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { customerId: 'cus-meridian', siteId: null } }),
    )
  })

  it('shows the API’s own message when the scope is refused or the request is not understood', async () => {
    const { api } = served(new ApiError('Not found.', 404))
    page('/docker?customer=cus-gone', api)
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found.')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows an inline error with Retry when it cannot be loaded, and recovers', async () => {
    const user = userEvent.setup()
    const { api } = served(new ApiError('Service unavailable', 503), await paged())
    page('/docker', api)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load containers')
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await table()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the last good rows under a banner when only a refresh fails', async () => {
    const { api, listContainers } = served(await paged(), new ApiError('Service unavailable', 503))
    page('/docker', api)
    await table()
    await userEvent.setup().click(screen.getByRole('button', { name: /WARN/ }))
    await waitFor(() => expect(listContainers.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Containers' })).toBeInTheDocument()
  })

  it('is tagged live over the console API, and mock over the sample fleet', async () => {
    const { api } = served(await paged())
    const live = page('/docker', { ...api, source: 'http' })
    await table()
    const region = screen.getByRole('region', { name: 'Containers' })
    expect(within(region).getByText(/^live/)).toBeInTheDocument()
    live.unmount()
    page()
    await table()
    expect(
      within(screen.getByRole('region', { name: 'Containers' })).getByText(/^mock/),
    ).toBeInTheDocument()
  })

  it('stays mock while the Docker feature is not connected, and shows no live tag', async () => {
    overrides.set('docker', { connected: false })
    const { api } = served(await paged())
    page('/docker', { ...api, source: 'http' })
    await table()
    const region = screen.getByRole('region', { name: 'Containers' })
    expect(within(region).queryByText(/^live/)).toBeNull()
    expect(within(region).getByText(/^mock/)).toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock/client'
import { createTestApi, renderApp } from '@/test/render'
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

const page = (route = '/servers', api = mock()) =>
  renderApp(
    <>
      <Routes>
        <Route path="/servers" element={<ServersListPage />} />
        <Route path="/servers/:id" element={<p>detail page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route },
  )

const table = () => screen.findByRole('table', { name: 'Servers' })
const hostnames = (t: HTMLElement) =>
  within(t)
    .getAllByRole('link')
    .map((link) => link.textContent)

describe('ServersListPage', () => {
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
    const t = await table()
    expect(hostnames(t)).toEqual(['pir-fs-01'])
    expect(screen.getByText('1 of 16 shown')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/servers?q=piraeus')
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

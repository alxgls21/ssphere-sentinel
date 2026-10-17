import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { TargetList, TargetListItem } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import NetworkPage from './NetworkPage'
import { item, iso, list, measurement } from './testing'

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

function Where() {
  const location = useLocation()
  return <output aria-label="location">{location.pathname + location.search}</output>
}

/** A fleet with every situation an operator has to tell apart. */
const FLEET: TargetListItem[] = [
  item({
    id: 't-fail',
    name: 'pir-gateway',
    reason: 'failing',
    latest: measurement({ success: false, latencyMs: null, lossPercent: 100 }),
  }),
  item({
    id: 't-slow',
    name: 'cdn-edge',
    protocol: 'tcp',
    reason: 'latency',
    latest: measurement({ latencyMs: 212 }),
  }),
  item({
    id: 't-lossy',
    name: 'fra-isp-a',
    reason: 'loss',
    latest: measurement({ lossPercent: 6 }),
  }),
  item({
    id: 't-lossy-tcp',
    name: 'api-https',
    protocol: 'tcp',
    reason: 'loss',
    latest: measurement({ lossPercent: 6 }),
  }),
  item({
    id: 't-stale',
    name: 'old-probe',
    reason: 'stale',
    latest: measurement({ measuredAt: iso(7200), latencyMs: 9 }),
  }),
  item({ id: 't-offline', name: 'quiet-agent', reason: 'agent_offline', agent: 'offline' }),
  item({ id: 't-noagent', name: 'orphan', reason: 'no_agent', agent: 'none' }),
  item({ id: 't-never', name: 'fresh', reason: 'no_measurement', latest: null }),
  item({ id: 't-off', name: 'spare', reason: 'disabled' }),
  item({ id: 't-ok', name: 'ath-gateway', reason: 'ok' }),
]

const served = (...lists: (TargetList | Error)[]) => {
  const listTargets = vi.fn<SentinelApi['listTargets']>(async () => {
    const next = lists.length > 1 ? (lists.shift() as TargetList | Error) : (lists[0] as TargetList)
    if (next instanceof Error) throw next
    return next
  })
  return { api: createTestApi({ listTargets, source: 'http' }), listTargets }
}

const page = (route = '/network', api: SentinelApi = served(list(FLEET)).api) =>
  renderApp(
    <>
      <Routes>
        <Route path="/network" element={<NetworkPage />} />
        <Route path="/network/:id" element={<p>target page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route },
  )

const table = () => screen.findByRole('table', { name: 'Network targets' })
const rowOf = (t: HTMLElement, name: string) =>
  within(t).getByRole('link', { name }).closest('tr') as HTMLElement
const names = (t: HTMLElement) =>
  within(t)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.querySelector('a')?.textContent ?? '')

describe('the inventory', () => {
  it('lists the targets as the API ordered them and says how many it shows', async () => {
    page()
    const t = await table()
    expect(names(t)).toEqual(FLEET.map((entry) => entry.target.name))
    expect(screen.getByText('10 of 10 shown')).toBeInTheDocument()
  })

  it('gives each row its status word (the API’s reason), protocol, agent and age', async () => {
    page()
    const t = await table()
    const row = rowOf(t, 'pir-gateway')
    expect(within(row).getByText('FAILING')).toBeInTheDocument()
    expect(within(row).getByText('ICMP')).toBeInTheDocument()
    expect(within(row).getByText('ath-probe')).toBeInTheDocument()
    expect(within(row).getByText('20s ago')).toBeInTheDocument()
    expect(within(rowOf(t, 'cdn-edge')).getByText('TCP 443')).toBeInTheDocument()
    expect(row.querySelector('span.w-0\\.5')).toHaveClass('bg-critical')
  })

  it('tells the six situations apart by word, not only by colour', async () => {
    page()
    const t = await table()
    const word = (name: string) =>
      within(rowOf(t, name)).getByText(/^[A-Z ]+$/, { selector: 'span' })
    expect(rowOf(t, 'spare')).toHaveTextContent('DISABLED')
    expect(rowOf(t, 'orphan')).toHaveTextContent('NO AGENT')
    expect(rowOf(t, 'quiet-agent')).toHaveTextContent('AGENT OFFLINE')
    expect(rowOf(t, 'fresh')).toHaveTextContent('NO DATA')
    expect(rowOf(t, 'old-probe')).toHaveTextContent('STALE')
    expect(rowOf(t, 'pir-gateway')).toHaveTextContent('FAILING')
    expect(rowOf(t, 'cdn-edge')).toHaveTextContent('SLOW')
    expect(rowOf(t, 'ath-gateway')).toHaveTextContent('OK')
    expect(word).toBeTypeOf('function')
  })

  it('names the loss column for both protocols, and each value for its own', async () => {
    page()
    const t = await table()
    const header = within(t).getByRole('columnheader', { name: /LOSS \/ FAILED/ })
    expect(within(header).getByRole('button')).toHaveAttribute(
      'title',
      'ICMP: probe packets lost. TCP: connection attempts that failed.',
    )
    expect(within(rowOf(t, 'fra-isp-a')).getByText('6.0% lost')).toBeInTheDocument()
    expect(within(rowOf(t, 'api-https')).getByText('6.0% failed')).toBeInTheDocument()
    expect(within(rowOf(t, 'api-https')).queryByText(/lost/)).toBeNull()
  })

  it('shows latency and loss only for a current reading, and the reason for the rest', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'cdn-edge')).getByText('212 ms')).toBeInTheDocument()
    for (const name of ['old-probe', 'quiet-agent', 'orphan', 'fresh', 'spare']) {
      const row = rowOf(t, name)
      const dashes = within(row).getAllByText('—')
      // Latency and loss, both: the last number is never shown as the present one.
      expect(dashes.length, name).toBeGreaterThanOrEqual(2)
      expect(within(row).queryByText('9 ms')).toBeNull()
    }
    const stale = rowOf(t, 'old-probe')
    expect(within(stale).getAllByLabelText(/^Not a current reading\./).length).toBe(2)
    expect(within(stale).getAllByLabelText(/Last measurement 2h ago: 9\.0 ms/).length).toBe(2)
  })

  it('shows the age of the newest measurement, and "never" for a target never measured', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'old-probe')).getByText('2h ago')).toBeInTheDocument()
    expect(within(rowOf(t, 'fresh')).getByText('never')).toBeInTheDocument()
  })

  it('names an agent as the API lets it, with its status, or says none is assigned', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'quiet-agent')).getByText('ath-probe (offline)')).toBeInTheDocument()
    expect(within(rowOf(t, 'orphan')).getByText('none assigned')).toBeInTheDocument()
  })

  it('opens a target from its name and from anywhere on its row', async () => {
    const user = userEvent.setup()
    page('/network?status=warning&sort=name')
    const t = await table()
    expect(within(t).getByRole('link', { name: 'ath-gateway' })).toHaveAttribute(
      'href',
      '/network/t-ok',
    )
    await user.click(within(rowOf(t, 'ath-gateway')).getByText('ICMP'))
    expect(await screen.findByText('target page')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/network/t-ok')
  })
})

describe('the query', () => {
  it('asks for one page of the query with the paging, scope and sort the API supports', async () => {
    const { api, listTargets } = served(list(FLEET))
    page('/network?q=gate&status=warning&sort=latency&dir=asc&page=2&customer=cus-1', api)
    await table()
    expect(listTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'gate',
        status: 'warning',
        sort: 'latency',
        dir: 'asc',
        page: 2,
        pageSize: 50,
        scope: { customerId: 'cus-1', siteId: null },
      }),
    )
  })

  it("says what the API counted: the matches, the scope and each chip's figure", async () => {
    const { api } = served(
      list(FLEET.slice(0, 3), {
        page: { number: 2, size: 50, total: 130, pages: 3 },
        counts: { healthy: 100, warning: 20, critical: 8, unknown: 2, idle: 0 },
        scopeTotal: 230,
      }),
    )
    page('/network?page=2', api)
    await table()
    expect(screen.getByText('130 of 230 shown')).toBeInTheDocument()
    for (const [word, count] of [
      ['CRIT', 8],
      ['WARN', 20],
      ['UNKN', 2],
      ['IDLE', 0],
      ['OK', 100],
    ] as const) {
      expect(
        screen.getByRole('button', { name: new RegExp(`${word}\\s*${count}$`) }),
      ).toBeInTheDocument()
    }
    expect(screen.getByRole('navigation', { name: 'Pages' })).toHaveTextContent(
      '51–53 of 130 · page 2 of 3',
    )
  })

  it('filters from the chips, sorts from the headers and pages, all in the URL', async () => {
    const user = userEvent.setup()
    const { api, listTargets } = served(
      list(FLEET, { page: { number: 1, size: 50, total: 130, pages: 3 } }),
    )
    page('/network', api)
    const t = await table()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/network?status=warning')
    await user.click(
      within(within(t).getByRole('columnheader', { name: /LATENCY/ })).getByRole('button'),
    )
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('sort=latency'))
    expect(listTargets).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'latency', dir: 'desc' }),
    )
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('location')).toHaveTextContent('page=2')
  })

  it('starts again from the first page when the filter changes, and goes to the last when past the end', async () => {
    const user = userEvent.setup()
    const { api } = served(list(FLEET, { page: { number: 2, size: 50, total: 130, pages: 3 } }))
    const view = page('/network?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    expect(screen.getByLabelText('location')).not.toHaveTextContent('page=')
    view.unmount()
    const past = served(
      list([], { page: { number: 9, size: 50, total: 130, pages: 3 } }),
      list(FLEET, { page: { number: 3, size: 50, total: 130, pages: 3 } }),
    )
    page('/network?page=9', past.api)
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('/network?page=3'),
    )
  })

  it('searches with a pause, and keeps the search in the URL', async () => {
    const user = userEvent.setup()
    const { api, listTargets } = served(list(FLEET))
    page('/network', api)
    await table()
    await user.type(screen.getByRole('searchbox', { name: 'Search targets' }), 'gate')
    await waitFor(() =>
      expect(listTargets).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'gate' })),
    )
    expect(screen.getByLabelText('location')).toHaveTextContent('/network?q=gate')
    // Not a request per key: the first keys were not asked for on their own.
    expect(listTargets.mock.calls.some(([options]) => options?.q === 'g')).toBe(false)
  })
})

describe('opening a target the Overview pointed at', () => {
  it('goes straight to its page, keeping the view', () => {
    page('/network?focus=t-fail&range=6h')
    expect(screen.getByText('target page')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/network/t-fail?range=6h')
  })
})

describe('empty, error and provenance', () => {
  it('says no targets are configured, and not that the network is fine, for an empty inventory', async () => {
    page('/network', served(list([])).api)
    expect(await screen.findByText('No network targets')).toBeInTheDocument()
    expect(screen.getByText('0 of 0 shown')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says no target matches, with a way back', async () => {
    const user = userEvent.setup()
    page('/network?q=zzz', served(list([], { scopeTotal: 10 })).api)
    expect(await screen.findByText('No target matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    expect(screen.getByLabelText('location')).not.toHaveTextContent('q=')
  })

  it('counts the unknown ones in the footer in the API’s own situations', async () => {
    page()
    await table()
    expect(
      screen.getByText(/4 unknown: no agent, agent offline, no measurement/),
    ).toBeInTheDocument()
  })

  it('shows an inline error with Retry, never sample data, and recovers', async () => {
    const user = userEvent.setup()
    const { api } = served(new ApiError('Service unavailable', 503), list(FLEET))
    page('/network', api)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load targets')
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await table()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the API’s own message when the scope is refused, with no fallback list', async () => {
    page('/network?customer=gone', served(new ApiError('Not found.', 404)).api)
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found.')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('keeps the last good rows under a banner when only a refresh fails', async () => {
    const user = userEvent.setup()
    const { api, listTargets } = served(list(FLEET), new ApiError('Service unavailable', 503))
    page('/network', api)
    await table()
    await user.click(screen.getByRole('button', { name: /WARN/ }))
    await waitFor(() => expect(listTargets.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Network targets' })).toBeInTheDocument()
  })

  it('is live over the console API when the whole feature is connected, mock over the sample API', async () => {
    const live = page()
    await table()
    const region = () => screen.getByRole('region', { name: 'Targets' })
    expect(within(region()).getByText(/^live/)).toBeInTheDocument()
    live.unmount()
    page('/network', createTestApi({ listTargets: async () => list(FLEET), source: 'mock' }))
    await table()
    expect(within(region()).getByText(/^mock/)).toBeInTheDocument()
  })

  it('is not live while the Network feature is not connected', async () => {
    overrides.set('network', { connected: false })
    page()
    await table()
    expect(within(screen.getByRole('region', { name: 'Targets' })).queryByText(/^live/)).toBeNull()
  })
})

describe('on a phone', () => {
  it('becomes cards with a sort menu, keeping the word, the protocol-specific loss and the reason', async () => {
    stubViewport(false)
    const user = userEvent.setup()
    page()
    const cards = await screen.findByRole('list', { name: 'Network targets' })
    expect(screen.queryByRole('table')).toBeNull()
    const card = (name: string) => within(cards).getByText(name).closest('li') as HTMLElement
    expect(within(card('api-https')).getByText('6.0% failed')).toBeInTheDocument()
    expect(within(card('fra-isp-a')).getByText('6.0% lost')).toBeInTheDocument()
    expect(
      within(card('old-probe')).getByText(/too old to describe the present/),
    ).toBeInTheDocument()
    expect(within(card('spare')).getByText(/switched off/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'latency')
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('sort=latency'))
  })
})

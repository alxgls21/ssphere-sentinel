import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { DeviceList, DeviceListItem } from '@/api/types'
import { registryOverrides } from '@/config/testing'
import { createTestApi, renderApp } from '@/test/render'
import SnmpPage from './SnmpPage'
import { item, list } from './testing'

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
const FLEET: DeviceListItem[] = [
  item({
    id: 'd-down',
    name: 'pir-edge-rtr',
    type: 'router',
    reason: 'unreachable',
    error: 'timeout',
    interfaces: { unknown: 12 },
  }),
  item({ id: 'd-stale', name: 'old-sw', reason: 'stale', interfaces: { unknown: 24 } }),
  item({
    id: 'd-offline',
    name: 'quiet-fw',
    type: 'firewall',
    reason: 'agent_offline',
    agent: 'offline',
    interfaces: { unknown: 8 },
  }),
  item({
    id: 'd-noagent',
    name: 'orphan-sw',
    reason: 'no_agent',
    agent: 'none',
    interfaces: { unknown: 4 },
  }),
  item({ id: 'd-new', name: 'fresh-sw', reason: 'no_poll', interfaces: {} }),
  item({ id: 'd-off', name: 'spare-sw', reason: 'disabled', interfaces: { unknown: 2 } }),
  // A healthy switch with a port down: the port counts, the switch stays healthy.
  item({
    id: 'd-ok',
    name: 'ath-core-sw',
    reason: 'ok',
    interfaces: { healthy: 20, idle: 3, warning: 2 },
  }),
]

const served = (...lists: (DeviceList | Error)[]) => {
  const listDevices = vi.fn<SentinelApi['listDevices']>(async () => {
    const next = lists.length > 1 ? (lists.shift() as DeviceList | Error) : (lists[0] as DeviceList)
    if (next instanceof Error) throw next
    return next
  })
  return { api: createTestApi({ listDevices, source: 'http' }), listDevices }
}

const page = (route = '/snmp', api: SentinelApi = served(list(FLEET)).api) =>
  renderApp(
    <>
      <Routes>
        <Route path="/snmp" element={<SnmpPage />} />
        <Route path="/snmp/:id" element={<p>device page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route },
  )

const table = () => screen.findByRole('table', { name: 'SNMP devices' })
const rowOf = (t: HTMLElement, name: string) =>
  within(t).getByRole('link', { name }).closest('tr') as HTMLElement
const names = (t: HTMLElement) =>
  within(t)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.querySelector('a')?.textContent ?? '')

describe('the inventory', () => {
  it('lists the devices as the API ordered them and says how many it shows', async () => {
    page()
    expect(names(await table())).toEqual(FLEET.map((entry) => entry.device.name))
    expect(screen.getByText('7 of 7 shown')).toBeInTheDocument()
  })

  it('shows identity: type, management address, SNMP version, site, agent and interface counts', async () => {
    page()
    const row = rowOf(await table(), 'ath-core-sw')
    expect(within(row).getByText('Switch')).toBeInTheDocument()
    expect(within(row).getByText('10.20.0.250')).toBeInTheDocument()
    expect(within(row).getByText('SNMPv2c port 161')).toBeInTheDocument()
    expect(within(row).getByText('ath-probe')).toBeInTheDocument()
    expect(within(row).getByText('25 · 2 down')).toBeInTheDocument()
    expect(
      within(row).getByLabelText('25 interfaces, 20 up, 3 admin down, 2 down, 0 unknown'),
    ).toBeInTheDocument()
    expect(within(row).getByText('20s ago')).toBeInTheDocument()
    expect(within(row).getByText('12 ms')).toBeInTheDocument()
  })

  it('tells the situations apart by word, not only by colour, using the API’s reason', async () => {
    page()
    const t = await table()
    expect(rowOf(t, 'pir-edge-rtr')).toHaveTextContent('UNREACHABLE')
    expect(rowOf(t, 'old-sw')).toHaveTextContent('STALE')
    expect(rowOf(t, 'quiet-fw')).toHaveTextContent('AGENT OFFLINE')
    expect(rowOf(t, 'orphan-sw')).toHaveTextContent('NO AGENT')
    expect(rowOf(t, 'fresh-sw')).toHaveTextContent('NOT POLLED')
    expect(rowOf(t, 'spare-sw')).toHaveTextContent('DISABLED')
    expect(rowOf(t, 'ath-core-sw')).toHaveTextContent('REACHABLE')
    expect(rowOf(t, 'pir-edge-rtr').querySelector('span.w-0\\.5')).toHaveClass('bg-critical')
  })

  it('does not call a device unhealthy because an interface is down: the health is the device’s', async () => {
    page()
    const row = rowOf(await table(), 'ath-core-sw')
    expect(row.querySelector('span.w-0\\.5')).toHaveClass('bg-healthy')
    expect(row).toHaveTextContent('2 down')
    expect(within(row).getByText('REACHABLE')).toBeInTheDocument()
  })

  it('shows a response time only for a current reachable poll, and the reason for the rest', async () => {
    page()
    const t = await table()
    for (const name of [
      'old-sw',
      'quiet-fw',
      'orphan-sw',
      'fresh-sw',
      'spare-sw',
      'pir-edge-rtr',
    ]) {
      const row = rowOf(t, name)
      expect(
        within(row).getAllByLabelText(/^(Not a current reading|No response)/).length,
        name,
      ).toBe(1)
    }
    expect(
      within(rowOf(t, 'pir-edge-rtr')).getByLabelText(
        /^No response: the latest poll could not reach the device/,
      ),
    ).toBeInTheDocument()
  })

  it('shows the age of the last poll, and "never" for a device never polled', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'old-sw')).getByText('2h ago')).toBeInTheDocument()
    expect(within(rowOf(t, 'fresh-sw')).getByText('never')).toBeInTheDocument()
  })

  it('names an agent as the API lets it, with its status, or says none is assigned', async () => {
    page()
    const t = await table()
    expect(within(rowOf(t, 'quiet-fw')).getByText('ath-probe (offline)')).toBeInTheDocument()
    expect(within(rowOf(t, 'orphan-sw')).getByText('none assigned')).toBeInTheDocument()
  })

  it('opens a device from its name and from anywhere on its row, keeping the list for the way back', async () => {
    const user = userEvent.setup()
    page('/snmp?status=critical&sort=name')
    const t = await table()
    expect(within(t).getByRole('link', { name: 'ath-core-sw' })).toHaveAttribute(
      'href',
      '/snmp/d-ok',
    )
    await user.click(within(rowOf(t, 'ath-core-sw')).getByText('Switch'))
    expect(await screen.findByText('device page')).toBeInTheDocument()
    expect(screen.getByLabelText('location')).toHaveTextContent('/snmp/d-ok')
  })
})

describe('the query', () => {
  it('asks for one page of the query with the paging, scope and sort the API supports', async () => {
    const { api, listDevices } = served(list(FLEET))
    page('/snmp?q=core&status=critical&sort=response&dir=asc&page=2&customer=cus-1', api)
    await table()
    expect(listDevices).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'core',
        status: 'critical',
        sort: 'response',
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
        counts: { healthy: 100, warning: 0, critical: 8, unknown: 20, idle: 2 },
        scopeTotal: 230,
      }),
    )
    page('/snmp?page=2', api)
    await table()
    expect(screen.getByText('130 of 230 shown')).toBeInTheDocument()
    for (const [word, count] of [
      ['CRIT', 8],
      ['WARN', 0],
      ['UNKN', 20],
      ['IDLE', 2],
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
    const { api, listDevices } = served(
      list(FLEET, { page: { number: 1, size: 50, total: 130, pages: 3 } }),
    )
    page('/snmp', api)
    const t = await table()
    await user.click(screen.getByRole('button', { name: /CRIT/ }))
    expect(screen.getByLabelText('location')).toHaveTextContent('/snmp?status=critical')
    await user.click(
      within(within(t).getByRole('columnheader', { name: /RESPONSE/ })).getByRole('button'),
    )
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('sort=response'),
    )
    expect(listDevices).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'response', dir: 'desc' }),
    )
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('location')).toHaveTextContent('page=2')
  })

  it('starts again from the first page when the filter changes, and goes to the last when past the end', async () => {
    const user = userEvent.setup()
    const { api } = served(list(FLEET, { page: { number: 2, size: 50, total: 130, pages: 3 } }))
    const view = page('/snmp?page=2', api)
    await table()
    await user.click(screen.getByRole('button', { name: /CRIT/ }))
    expect(screen.getByLabelText('location')).not.toHaveTextContent('page=')
    view.unmount()
    const past = served(
      list([], { page: { number: 9, size: 50, total: 130, pages: 3 } }),
      list(FLEET, { page: { number: 3, size: 50, total: 130, pages: 3 } }),
    )
    page('/snmp?page=9', past.api)
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/snmp?page=3'))
  })

  it('searches with a pause, and keeps the search in the URL', async () => {
    const user = userEvent.setup()
    const { api, listDevices } = served(list(FLEET))
    page('/snmp', api)
    await table()
    await user.type(screen.getByRole('searchbox', { name: 'Search devices' }), 'core')
    await waitFor(() =>
      expect(listDevices).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'core' })),
    )
    expect(screen.getByLabelText('location')).toHaveTextContent('/snmp?q=core')
    expect(listDevices.mock.calls.some(([options]) => options?.q === 'c')).toBe(false)
  })
})

describe('empty, error and provenance', () => {
  it('says no devices are configured, and not that the network is fine, for an empty inventory', async () => {
    page('/snmp', served(list([])).api)
    expect(await screen.findByText('No SNMP devices')).toBeInTheDocument()
    expect(screen.getByText('0 of 0 shown')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says no device matches, with a way back', async () => {
    const user = userEvent.setup()
    page('/snmp?q=zzz', served(list([], { scopeTotal: 10 })).api)
    expect(await screen.findByText('No device matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    expect(screen.getByLabelText('location')).not.toHaveTextContent('q=')
  })

  it('counts the unknown ones in the footer in the API’s own situations', async () => {
    page()
    await table()
    expect(screen.getByText(/4 unknown: no agent, agent offline, not polled/)).toBeInTheDocument()
  })

  it('shows an inline error with Retry, never sample data, and recovers', async () => {
    const user = userEvent.setup()
    const { api } = served(new ApiError('Service unavailable', 503), list(FLEET))
    page('/snmp', api)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load devices')
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await table()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the API’s own message when the scope is refused, with no fallback list', async () => {
    page('/snmp?customer=gone', served(new ApiError('Not found.', 404)).api)
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found.')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('keeps the last good rows under a banner when only a refresh fails', async () => {
    const user = userEvent.setup()
    const { api, listDevices } = served(list(FLEET), new ApiError('Service unavailable', 503))
    page('/snmp', api)
    await table()
    await user.click(screen.getByRole('button', { name: /CRIT/ }))
    await waitFor(() => expect(listDevices.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'SNMP devices' })).toBeInTheDocument()
  })

  it('is live over the console API, mock over the sample API, and not live while SNMP is not connected', async () => {
    const live = page()
    await table()
    const region = () => screen.getByRole('region', { name: 'Devices' })
    expect(within(region()).getByText(/^live/)).toBeInTheDocument()
    live.unmount()
    page('/snmp', createTestApi({ listDevices: async () => list(FLEET), source: 'mock' }))
    await table()
    expect(within(region()).getByText(/^mock/)).toBeInTheDocument()
    overrides.set('snmp', { connected: false })
    page('/snmp', createTestApi({ listDevices: async () => list(FLEET), source: 'http' }))
    await waitFor(() => expect(screen.getAllByRole('table').length).toBeGreaterThan(0))
    expect(screen.queryAllByText(/^live/)).toHaveLength(0)
  })
})

describe('on a phone', () => {
  it('becomes cards with a sort menu, keeping the word, the interfaces and the reason', async () => {
    stubViewport(false)
    const user = userEvent.setup()
    page()
    const cards = await screen.findByRole('list', { name: 'SNMP devices' })
    expect(screen.queryByRole('table')).toBeNull()
    const card = (name: string) => within(cards).getByText(name).closest('li') as HTMLElement
    expect(within(card('ath-core-sw')).getByText('12 ms')).toBeInTheDocument()
    expect(
      within(card('ath-core-sw')).getByLabelText(/interfaces: 25 interfaces/),
    ).toBeInTheDocument()
    expect(within(card('old-sw')).getByText(/too old to describe the present/)).toBeInTheDocument()
    expect(within(card('spare-sw')).getByText(/switched off/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'response')
    await waitFor(() =>
      expect(screen.getByLabelText('location')).toHaveTextContent('sort=response'),
    )
  })
})

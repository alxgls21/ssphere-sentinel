import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import DevicesPage from './DevicesPage'
import { device, deviceList } from './adminTesting'
import { can } from './testing'

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

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

function setup({
  capabilities = can('manageDevices'),
  listInventoryDevices = vi.fn<SentinelApi['listInventoryDevices']>(async () =>
    deviceList([
      device(),
      device({
        id: 'd2',
        name: 'spare',
        type: 'other',
        snmp: null,
        enabled: false,
        siteId: null,
        customerName: undefined,
        siteName: undefined,
        agent: null,
        agentAssigned: false,
      }),
    ]),
  ),
} = {}) {
  const api = createTestApi({ source: 'http', listInventoryDevices })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/devices" element={<DevicesPage />} />
        <Route path="/settings/devices/:id" element={<p>device editor</p>} />
      </Routes>
      <Where />
    </>,
    { api, route: '/settings/devices', auth: createFakeAuth({ capabilities }) },
  )
  return { listInventoryDevices }
}

const table = () => screen.findByRole('table', { name: 'Devices' })

describe('Devices', () => {
  it('says so without the capability', () => {
    const { listInventoryDevices } = setup({ capabilities: can('manageTargets') })
    expect(screen.getByText('Not permitted to change devices')).toBeInTheDocument()
    expect(listInventoryDevices).not.toHaveBeenCalled()
  })

  it('lists every device with its type, address, place, polling and agent, each a link to its editor', async () => {
    setup()
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1)
    expect(rows[0]).toHaveTextContent('ENABLED')
    expect(rows[0]).toHaveTextContent('Switch')
    expect(rows[0]).toHaveTextContent('core.example.net')
    expect(rows[0]).toHaveTextContent('Meridian / Athens DC')
    expect(rows[0]).toHaveTextContent('SNMPv3 · port 161')
    expect(rows[0]).toHaveTextContent('ath-probe-01')
    expect(rows[1]).toHaveTextContent('DISABLED')
    expect(rows[1]).toHaveTextContent('Not polled')
    expect(rows[1]).toHaveTextContent('No site')
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'core-sw' })).toHaveAttribute(
      'href',
      '/settings/devices/d1',
    )
    expect(screen.getByRole('link', { name: 'New device' })).toHaveAttribute(
      'href',
      '/settings/devices/new',
    )
  })

  it('filters by polling and searches with the server, in the URL', async () => {
    const user = userEvent.setup()
    const { listInventoryDevices } = setup()
    await table()
    await user.click(screen.getByRole('button', { name: 'NOT POLLED' }))
    await waitFor(() =>
      expect(listInventoryDevices).toHaveBeenLastCalledWith(
        expect.objectContaining({ snmp: 'none' }),
      ),
    )
    expect(screen.getByTestId('where').textContent).toBe('/settings/devices?snmp=none')
    await user.type(screen.getByLabelText('Search devices'), 'core')
    await waitFor(() =>
      expect(listInventoryDevices).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'core', snmp: 'none' }),
      ),
    )
  })

  it('lists cards on a phone', async () => {
    stubViewport(false)
    setup()
    expect(await screen.findByRole('list', { name: 'Devices' })).toBeInTheDocument()
  })
})

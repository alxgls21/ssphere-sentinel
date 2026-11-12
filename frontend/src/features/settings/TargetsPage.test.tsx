import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { TargetList, TargetListItem } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import TargetsPage from './TargetsPage'
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

const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

const NOW = '2026-10-18T10:00:00.000Z'

function item(over: Partial<TargetListItem['target']> = {}, place = true): TargetListItem {
  return {
    target: {
      id: 't1',
      name: 'ath-gateway',
      address: '10.20.0.1',
      protocol: 'icmp',
      port: null,
      enabled: true,
      intervalSeconds: 60,
      timeoutSeconds: 2,
      expectedSlaPercent: 99.9,
      customerLabel: null,
      circuitId: null,
      siteId: place ? 's1' : null,
      agentAssigned: true,
      agent: {
        id: 'a1',
        name: 'probe',
        status: 'online',
        lastSeenAt: NOW,
        serverId: 'srv-1',
        serverName: 'ath-probe-01',
      },
      ...over,
    },
    latest: null,
    stale: false,
    health: 'unknown',
    reason: 'no_measurement',
    ...(place ? { customerName: 'Meridian', siteName: 'Athens DC' } : {}),
  }
}

const list = (items: TargetListItem[]): TargetList => ({
  generatedAt: NOW,
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  counts: { healthy: 0, warning: 0, critical: 0, unknown: items.length, idle: 0 },
  scopeTotal: items.length,
})

function setup({
  capabilities = can('manageTargets'),
  listTargets = vi.fn<SentinelApi['listTargets']>(async () =>
    list([
      item(),
      item(
        {
          id: 't2',
          name: 'dns',
          protocol: 'tcp',
          port: 53,
          enabled: false,
          agent: null,
          agentAssigned: false,
        },
        false,
      ),
    ]),
  ),
  updateTarget = vi.fn<SentinelApi['updateTarget']>(),
} = {}) {
  const api = createTestApi({ source: 'http', listTargets, updateTarget })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/targets" element={<TargetsPage />} />
        <Route path="/settings/targets/:id" element={<p>target editor</p>} />
      </Routes>
      <Where />
    </>,
    { api, route: '/settings/targets', withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { listTargets, updateTarget }
}

const table = () => screen.findByRole('table', { name: 'Network targets' })

describe('who may open it', () => {
  it('says so without the capability', () => {
    const { listTargets } = setup({ capabilities: can('manageDevices') })
    expect(screen.getByText('Not permitted to change network targets')).toBeInTheDocument()
    expect(listTargets).not.toHaveBeenCalled()
  })
})

describe('the list', () => {
  it('lists every target with its state, probe, place and agent, sorted by name, each a link to its editor', async () => {
    const { listTargets } = setup()
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('ENABLED')
    expect(rows[0]).toHaveTextContent('ICMP · every 60s')
    expect(rows[0]).toHaveTextContent('Meridian / Athens DC')
    expect(rows[0]).toHaveTextContent('ath-probe-01')
    expect(rows[1]).toHaveTextContent('DISABLED')
    expect(rows[1]).toHaveTextContent('TCP 53')
    expect(rows[1]).toHaveTextContent('No site')
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'ath-gateway' }),
    ).toHaveAttribute('href', '/settings/targets/t1')
    expect(listTargets).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'name', dir: 'asc', pageSize: 50 }),
    )
    expect(screen.getByRole('link', { name: 'New target' })).toHaveAttribute(
      'href',
      '/settings/targets/new',
    )
  })

  it('switches a target off and on from the row, and reads the list again', async () => {
    const user = userEvent.setup()
    const { updateTarget, listTargets } = setup()
    await table()
    await user.click(screen.getByRole('button', { name: 'Disable target ath-gateway' }))
    await waitFor(() => expect(updateTarget).toHaveBeenCalledWith('t1', { enabled: false }))
    expect(await screen.findByText(/“ath-gateway” is disabled/)).toBeInTheDocument()
    await waitFor(() => expect(listTargets.mock.calls.length).toBeGreaterThan(1))
    await user.click(screen.getByRole('button', { name: 'Enable target dns' }))
    await waitFor(() => expect(updateTarget).toHaveBeenCalledWith('t2', { enabled: true }))
  })

  it('says why a switch was refused', async () => {
    const user = userEvent.setup()
    setup({
      updateTarget: vi.fn(async () => {
        throw new ApiError('This account may not add or change network targets.', 403, 'forbidden')
      }),
    })
    await table()
    await user.click(screen.getByRole('button', { name: 'Disable target ath-gateway' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account may not make this change.',
    )
    expect(shell.announce).toHaveBeenCalledWith('The target was not changed.')
  })

  it('lists cards on a phone', async () => {
    stubViewport(false)
    setup()
    expect(await screen.findByRole('list', { name: 'Network targets' })).toBeInTheDocument()
  })
})

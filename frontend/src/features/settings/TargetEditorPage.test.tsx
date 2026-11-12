import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { TargetDetail, TargetListItem } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import TargetEditorPage from './TargetEditorPage'
import { SCOPE, agent, agentList, iso } from './adminTesting'
import { can } from './testing'

const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

function Where() {
  const { pathname, search, state } = useLocation()
  return (
    <>
      <span data-testid="where">{pathname + search}</span>
      <span data-testid="state">{JSON.stringify(state ?? null)}</span>
    </>
  )
}

function detail(over: Partial<TargetListItem['target']> = {}): TargetDetail {
  const target: TargetListItem['target'] = {
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
    circuitId: 'CIR-1',
    siteId: 's1',
    agentAssigned: true,
    agent: {
      id: 'a1',
      name: 'ath-probe',
      status: 'online',
      lastSeenAt: iso(30),
      serverId: 'srv-1',
      serverName: 'ath-probe-01',
    },
    ...over,
  }
  return {
    generatedAt: iso(0),
    item: {
      target,
      latest: null,
      stale: false,
      health: 'unknown',
      reason: 'no_measurement',
      customerName: 'Meridian',
      siteName: 'Athens DC',
    },
    measurements: [],
    availability24h: {
      from: iso(86_400),
      to: iso(0),
      measurements: 0,
      successful: 0,
      percent: null,
      expectedMeasurements: 1440,
      coveragePercent: 0,
    },
    agentEntry: {
      id: target.id,
      name: target.name,
      hostname_or_ip: target.address,
      protocol: target.protocol,
      port: target.port,
      enabled: target.enabled,
      monitoring_interval_seconds: target.intervalSeconds,
      timeout_seconds: target.timeoutSeconds,
      probe_count: 4,
    },
  }
}

function setup({
  capabilities = can('manageTargets'),
  route = '/settings/targets/t1',
  getTarget = vi.fn<SentinelApi['getTarget']>(async () => detail()),
  createTarget = vi.fn<SentinelApi['createTarget']>(async (input) =>
    detail({
      id: 't-new',
      name: input.name,
      address: input.address,
      protocol: input.protocol,
      port: input.port ?? null,
    }),
  ),
  updateTarget = vi.fn<SentinelApi['updateTarget']>(async (_id, patch) =>
    detail({ ...patch, port: patch.port ?? null }),
  ),
  deleteTarget = vi.fn<SentinelApi['deleteTarget']>(async (id) => ({
    generatedAt: iso(0),
    deleted: { id, name: 'ath-gateway', measurements: 12 },
  })),
} = {}) {
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const listAgents = vi.fn<SentinelApi['listAgents']>(async () =>
    agentList([
      agent(),
      agent({ id: 'a2', name: 'plant-probe', serverName: 'plant-01', status: 'offline' }),
    ]),
  )
  const api = createTestApi({
    source: 'http',
    getScopeOptions,
    listAgents,
    getTarget,
    createTarget,
    updateTarget,
    deleteTarget,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/targets" element={<p>targets list</p>} />
        <Route path="/settings/targets/new" element={<TargetEditorPage />} />
        <Route path="/settings/targets/:id" element={<TargetEditorPage />} />
        <Route path="/network/:id" element={<p>network page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { getTarget, createTarget, updateTarget, deleteTarget, listAgents }
}

const where = () => screen.getByTestId('where').textContent
const field = (label: string) => screen.getByLabelText(label)

describe('a new target', () => {
  it('starts from the server’s defaults, offers the sites and the agents, and needs a port for TCP', async () => {
    const user = userEvent.setup()
    const { createTarget } = setup({ route: '/settings/targets/new' })
    expect(await screen.findByLabelText('Interval (seconds)')).toHaveValue('60')
    expect(field('Timeout (seconds)')).toHaveValue('2')
    expect(field('Expected SLA (%)')).toHaveValue('99.9')
    expect(field('Port')).toBeDisabled()
    expect(
      within(field('Agent'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'No agent (nothing measures it)',
      'ath-probe-01 (ath-probe)',
      'plant-01 (plant-probe, offline)',
    ])
    expect(within(field('Site')).getAllByRole('option')).toHaveLength(3)
    await user.type(field('Name'), 'dns')
    await user.type(field('Address'), 'dns.example.net')
    await user.selectOptions(field('Protocol'), 'tcp')
    await user.click(screen.getByRole('button', { name: 'Create target' }))
    expect(screen.getByRole('alert')).toHaveTextContent('port')
    expect(field('Port')).toHaveAccessibleDescription(/A TCP target needs a port/)
    expect(createTarget).not.toHaveBeenCalled()
    await user.type(field('Port'), '53')
    await user.selectOptions(field('Agent'), 'a1')
    await user.selectOptions(field('Site'), 's2')
    await user.click(screen.getByRole('button', { name: 'Create target' }))
    await waitFor(() =>
      expect(createTarget).toHaveBeenCalledWith({
        name: 'dns',
        address: 'dns.example.net',
        protocol: 'tcp',
        port: 53,
        enabled: true,
        intervalSeconds: 60,
        timeoutSeconds: 2,
        expectedSlaPercent: 99.9,
        customerLabel: '',
        circuitId: '',
        siteId: 's2',
        agentId: 'a1',
      }),
    )
    await waitFor(() => expect(where()).toBe('/settings/targets/t-new'))
    expect(
      await screen.findByText(/Copy its entry below into the targets file/),
    ).toBeInTheDocument()
  })

  it('says so without the capability', () => {
    setup({ capabilities: can('manageDevices'), route: '/settings/targets/new' })
    expect(screen.getByText('Not permitted to change network targets')).toBeInTheDocument()
  })
})

describe('an existing target', () => {
  it('shows the entry for the agent’s file, verbatim, with a copy button and a link to the Network page', async () => {
    setup()
    const entry = await screen.findByLabelText('Entry text')
    expect(entry).toHaveTextContent('"hostname_or_ip": "10.20.0.1"')
    expect(entry).toHaveTextContent('"probe_count": 4')
    expect(screen.getByRole('button', { name: 'Copy entry' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Network' })).toHaveAttribute(
      'href',
      '/network/t1',
    )
  })

  it('saves only what changed, and reminds about the agent’s file', async () => {
    const user = userEvent.setup()
    const { updateTarget } = setup()
    await screen.findByLabelText('Name')
    expect(field('Agent')).toHaveValue('a1')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.clear(field('Interval (seconds)'))
    await user.type(field('Interval (seconds)'), '120')
    await user.selectOptions(field('Agent'), '')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(updateTarget).toHaveBeenCalledWith('t1', { intervalSeconds: 120, agentId: null }),
    )
    expect(
      await screen.findByText(/update the entry in the agent's targets file too/),
    ).toBeInTheDocument()
  })

  it('shows the server’s answer field by field', async () => {
    const user = userEvent.setup()
    setup({
      updateTarget: vi.fn(async () => {
        throw new ApiError('Some values are not valid.', 400, 'validation_error', {
          fields: { port: ['ICMP targets must not set a port.'] },
        })
      }),
    })
    await screen.findByLabelText('Name')
    await user.clear(field('Name'))
    await user.type(field('Name'), 'renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('ICMP targets must not set a port.')).toBeInTheDocument()
  })

  it('deletes after its name is typed, and goes back to the list saying so', async () => {
    const user = userEvent.setup()
    const { deleteTarget } = setup()
    await user.click(await screen.findByRole('button', { name: 'Delete target' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the target “ath-gateway”?' })
    expect(within(dialog).getByText(/whole measurement history/)).toBeInTheDocument()
    await user.type(
      within(dialog).getByLabelText('Type the target’s name to confirm'),
      'ath-gateway',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Delete target' }))
    await waitFor(() => expect(deleteTarget).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(where()).toBe('/settings/targets'))
    expect(JSON.parse(screen.getByTestId('state').textContent ?? 'null')).toEqual({
      deleted: 'ath-gateway',
    })
  })
})

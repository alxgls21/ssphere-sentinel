import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { NO_CAPABILITIES } from '@/api/auth'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createMockApi } from '@/api/mock/client'
import type { ScopeOptions, ServerDetail } from '@/api/types'
import type { Resource } from '@/hooks/useResource'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import { ServerConfigPanel } from './ServerConfigPanel'

const NOW = Date.parse('2026-10-12T14:00:00Z')
const SCOPE: ScopeOptions = {
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [
    { id: 's1', customerId: 'c1', name: 'Athens DC' },
    { id: 's2', customerId: 'c1', name: 'Thessaloniki' },
  ],
}
const shell = createFakeShell()
beforeEach(() => vi.mocked(shell.announce).mockClear())

function Where() {
  const { pathname, state } = useLocation()
  return (
    <>
      <span data-testid="where">{pathname}</span>
      <span data-testid="state">{JSON.stringify(state ?? null)}</span>
    </>
  )
}

async function detail(): Promise<ServerDetail> {
  const real = createMockApi({ now: () => NOW, delayMs: 0 })
  const found = await real.getServer('srv-ath-db-01')
  return {
    ...found,
    item: {
      ...found.item,
      server: { ...found.item.server, siteId: 's1', description: 'the database' },
    },
  }
}

function resourceOf(data: ServerDetail): Resource<ServerDetail> & { refetch: Mock<() => void> } {
  return {
    status: 'success',
    data,
    error: null,
    isRefreshing: false,
    updatedAt: NOW,
    refetch: vi.fn<() => void>(),
  }
}

async function setup({
  capabilities = { ...NO_CAPABILITIES, editServers: true, deleteServers: true },
  updateServer = vi.fn<SentinelApi['updateServer']>(async () => detail()),
  deleteServer = vi.fn<SentinelApi['deleteServer']>(async (id) => ({
    generatedAt: new Date(NOW).toISOString(),
    deleted: {
      id,
      name: 'ath-db-01',
      agent: true,
      telemetrySamples: 3,
      containers: 2,
      measurementsKept: 0,
      targetsUnassigned: 1,
      devicesUnassigned: 0,
    },
  })),
} = {}) {
  const resource = resourceOf(await detail())
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const api = createTestApi({ source: 'http', getScopeOptions, updateServer, deleteServer })
  renderApp(
    <>
      <Routes>
        <Route path="/servers" element={<p>servers list</p>} />
        <Route path="/servers/:id" element={<ServerConfigPanel index={5} resource={resource} />} />
      </Routes>
      <Where />
    </>,
    {
      api,
      withShell: shell,
      auth: createFakeAuth({ capabilities }),
      route: '/servers/srv-ath-db-01',
    },
  )
  return { resource, updateServer, deleteServer, getScopeOptions }
}

const panel = () => screen.getByRole('region', { name: 'Configuration' })

describe('what it shows', () => {
  it('states the server as it is in the inventory, and offers nothing to an account that may not change hosts', async () => {
    const { getScopeOptions } = await setup({ capabilities: NO_CAPABILITIES })
    expect(within(panel()).getByText('ath-db-01')).toBeInTheDocument()
    expect(within(panel()).getByText('the database')).toBeInTheDocument()
    expect(within(panel()).getByText('Meridian Logistics / Athens DC')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete server' })).not.toBeInTheDocument()
    expect(within(panel()).getByText(/may not change or delete hosts/)).toBeInTheDocument()
    expect(getScopeOptions).not.toHaveBeenCalled()
  })

  it('offers only what the account may do', async () => {
    await setup({ capabilities: { ...NO_CAPABILITIES, editServers: true } })
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete server' })).not.toBeInTheDocument()
  })
})

describe('changing the server', () => {
  it('opens the form on the server as it is, saves only what changed, and reads the server again', async () => {
    const user = userEvent.setup()
    const { updateServer, resource } = await setup()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(await screen.findByLabelText('Name')).toHaveValue('ath-db-01')
    expect(screen.getByLabelText('Description')).toHaveValue('the database')
    expect(screen.getByLabelText('Site')).toHaveValue('s1')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Site'), 's2')
    await user.clear(screen.getByLabelText('Description'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(updateServer).toHaveBeenCalledWith('srv-ath-db-01', { siteId: 's2', description: '' }),
    )
    await waitFor(() => expect(resource.refetch).toHaveBeenCalled())
    expect(shell.announce).toHaveBeenCalledWith('Server saved.')
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('puts a taken name under the name field and keeps the form open', async () => {
    const user = userEvent.setup()
    await setup({
      updateServer: vi.fn(async () => {
        throw new ApiError('A server with this name already exists.', 409, 'server_exists')
      }),
    })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(await screen.findByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'taken')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('A server with this name already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
  })

  it('cancels back to the facts', async () => {
    const user = userEvent.setup()
    await setup()
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })
})

describe('deleting the server', () => {
  it('says what goes and what stays, needs the name typed, then goes to the list with what was done', async () => {
    const user = userEvent.setup()
    const { deleteServer } = await setup()
    await user.click(screen.getByRole('button', { name: 'Delete server' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the server “ath-db-01”?' })
    expect(within(dialog).getByText(/token stops working at once/)).toBeInTheDocument()
    expect(within(dialog).getByText(/measurements are kept/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Delete server' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type the server’s name to confirm'), 'ath-db-01')
    await user.click(within(dialog).getByRole('button', { name: 'Delete server' }))
    await waitFor(() => expect(deleteServer).toHaveBeenCalledWith('srv-ath-db-01'))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/servers'))
    expect(JSON.parse(screen.getByTestId('state').textContent ?? 'null')).toMatchObject({
      deleted: { name: 'ath-db-01', agent: true, telemetrySamples: 3 },
    })
    expect(shell.announce).toHaveBeenCalledWith('Server “ath-db-01” deleted.')
  })

  it('shows a refusal inside the confirmation and stays', async () => {
    const user = userEvent.setup()
    await setup({
      deleteServer: vi.fn(async () => {
        throw new ApiError('This account may not delete monitored hosts.', 403, 'forbidden')
      }),
    })
    await user.click(screen.getByRole('button', { name: 'Delete server' }))
    const dialog = screen.getByRole('alertdialog')
    await user.type(within(dialog).getByLabelText('Type the server’s name to confirm'), 'ath-db-01')
    await user.click(within(dialog).getByRole('button', { name: 'Delete server' }))
    expect(
      await within(dialog).findByText('This account may not delete monitored hosts.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('where').textContent).toBe('/servers/srv-ath-db-01')
  })
})

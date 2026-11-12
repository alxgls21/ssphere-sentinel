import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import DeviceEditorPage from './DeviceEditorPage'
import { SCOPE, agent, agentList, device, deviceDetail, iso } from './adminTesting'
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

function setup({
  capabilities = can('manageDevices'),
  route = '/settings/devices/d1',
  getInventoryDevice = vi.fn<SentinelApi['getInventoryDevice']>(async () => deviceDetail(device())),
  createInventoryDevice = vi.fn<SentinelApi['createInventoryDevice']>(async (input) =>
    deviceDetail(
      device({
        id: 'd-new',
        name: input.name,
        address: input.address,
        snmp: input.snmp
          ? { version: '3', port: 161, pollIntervalSeconds: 300, timeoutSeconds: 5, retries: 1 }
          : null,
      }),
    ),
  ),
  // Answers with the device as changed, as the server does; the profile is never answered.
  updateInventoryDevice = vi.fn<SentinelApi['updateInventoryDevice']>(async (_id, patch) => {
    const { credentialProfile: _profile, ...snmp } = patch.snmp ?? {}
    return deviceDetail(
      device({
        snmp: {
          version: '3',
          port: 161,
          pollIntervalSeconds: 300,
          timeoutSeconds: 5,
          retries: 1,
          ...snmp,
        },
        updatedAt: iso(0),
      }),
    )
  }),
  deleteInventoryDevice = vi.fn<SentinelApi['deleteInventoryDevice']>(async (id) => ({
    generatedAt: iso(0),
    deleted: { id, name: 'core-sw' },
  })),
} = {}) {
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const listAgents = vi.fn<SentinelApi['listAgents']>(async () => agentList([agent()]))
  const api = createTestApi({
    source: 'http',
    getScopeOptions,
    listAgents,
    getInventoryDevice,
    createInventoryDevice,
    updateInventoryDevice,
    deleteInventoryDevice,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/devices" element={<p>devices list</p>} />
        <Route path="/settings/devices/new" element={<DeviceEditorPage />} />
        <Route path="/settings/devices/:id" element={<DeviceEditorPage />} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { getInventoryDevice, createInventoryDevice, updateInventoryDevice, deleteInventoryDevice }
}

const where = () => screen.getByTestId('where').textContent
const field = (label: string) => screen.getByLabelText(label)

describe('a new device', () => {
  it('needs a credential profile once polling is switched on, and sends the SNMP block with it', async () => {
    const user = userEvent.setup()
    const { createInventoryDevice } = setup({ route: '/settings/devices/new' })
    await screen.findByLabelText('Name')
    expect(screen.queryByLabelText('Credential profile')).not.toBeInTheDocument()
    await user.type(field('Name'), 'core-sw')
    await user.type(field('Management address'), '192.0.2.10')
    await user.click(screen.getByRole('checkbox', { name: 'Polled by SNMP' }))
    expect(field('Port')).toHaveValue('161')
    await user.click(screen.getByRole('button', { name: 'Create device' }))
    expect(screen.getByRole('alert')).toHaveTextContent('snmp.credentialProfile')
    expect(field('Credential profile')).toHaveAccessibleDescription(/Required/)
    expect(createInventoryDevice).not.toHaveBeenCalled()
    await user.type(field('Credential profile'), 'lab')
    await user.selectOptions(field('Agent'), 'a1')
    await user.click(screen.getByRole('button', { name: 'Create device' }))
    await waitFor(() =>
      expect(createInventoryDevice).toHaveBeenCalledWith({
        name: 'core-sw',
        address: '192.0.2.10',
        type: 'other',
        enabled: true,
        description: '',
        siteId: null,
        agentId: 'a1',
        snmp: {
          version: '3',
          port: 161,
          credentialProfile: 'lab',
          pollIntervalSeconds: 300,
          timeoutSeconds: 5,
          retries: 1,
        },
      }),
    )
    await waitFor(() => expect(where()).toBe('/settings/devices/d-new'))
  })

  it('refuses a timing that the server would refuse, before asking it', async () => {
    const user = userEvent.setup()
    const { createInventoryDevice } = setup({ route: '/settings/devices/new' })
    await screen.findByLabelText('Name')
    await user.type(field('Name'), 'sw')
    await user.type(field('Management address'), '192.0.2.10')
    await user.click(screen.getByRole('checkbox', { name: 'Polled by SNMP' }))
    await user.type(field('Credential profile'), 'lab')
    await user.clear(field('Poll interval (seconds)'))
    await user.type(field('Poll interval (seconds)'), '30')
    await user.clear(field('Timeout (seconds)'))
    await user.type(field('Timeout (seconds)'), '20')
    await user.click(screen.getByRole('button', { name: 'Create device' }))
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => /timeout × \(retries \+ 1\)/.test(alert.textContent ?? '')),
    ).toBe(true)
    expect(createInventoryDevice).not.toHaveBeenCalled()
  })

  it('says so without the capability', () => {
    setup({ capabilities: can('manageTargets'), route: '/settings/devices/new' })
    expect(screen.getByText('Not permitted to change devices')).toBeInTheDocument()
  })
})

describe('an existing device', () => {
  it('never shows the profile, keeps it when the field stays blank, and sends it only when typed', async () => {
    const user = userEvent.setup()
    const { updateInventoryDevice } = setup()
    await screen.findByLabelText('Name')
    expect(field('Credential profile')).toHaveValue('')
    expect(field('Credential profile')).toHaveAccessibleDescription(/leave blank to keep it/)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.clear(field('Port'))
    await user.type(field('Port'), '1161')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(updateInventoryDevice).toHaveBeenCalledWith('d1', { snmp: { port: 1161 } }),
    )
    expect(await screen.findByText('The device is saved.')).toBeInTheDocument()
    await user.type(field('Credential profile'), 'new-profile')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(updateInventoryDevice).toHaveBeenLastCalledWith('d1', {
        snmp: { credentialProfile: 'new-profile' },
      }),
    )
    await waitFor(() => expect(field('Credential profile')).toHaveValue(''))
  })

  it('puts a taken name under the name field', async () => {
    const user = userEvent.setup()
    setup({
      updateInventoryDevice: vi.fn(async () => {
        throw new ApiError('This site already has a device with this name.', 409, 'device_exists')
      }),
    })
    await screen.findByLabelText('Name')
    await user.clear(field('Name'))
    await user.type(field('Name'), 'taken')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(
      await screen.findByText('This site already has a device with this name.'),
    ).toBeInTheDocument()
    expect(field('Name')).toHaveAttribute('aria-invalid', 'true')
  })

  it('offers no deletion while SNMP history exists, and says what to do', async () => {
    setup({ getInventoryDevice: vi.fn(async () => deviceDetail(device({ hasHistory: true }))) })
    expect(await screen.findByRole('button', { name: 'Delete device' })).toBeDisabled()
    expect(screen.getByText(/purge_snmp_data/)).toBeInTheDocument()
  })

  it('deletes after its name is typed, and goes back to the list saying so', async () => {
    const user = userEvent.setup()
    const { deleteInventoryDevice } = setup()
    await user.click(await screen.findByRole('button', { name: 'Delete device' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the device “core-sw”?' })
    await user.type(within(dialog).getByLabelText('Type the device’s name to confirm'), 'core-sw')
    await user.click(within(dialog).getByRole('button', { name: 'Delete device' }))
    await waitFor(() => expect(deleteInventoryDevice).toHaveBeenCalledWith('d1'))
    await waitFor(() => expect(where()).toBe('/settings/devices'))
  })
})

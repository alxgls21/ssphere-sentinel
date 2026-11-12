import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import UserPage from './UserPage'
import { SCOPE, account, accountDetail, iso } from './adminTesting'
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
  capabilities = can('manageUsers'),
  route = '/settings/users/7',
  getUser = vi.fn<SentinelApi['getUser']>(async () => accountDetail(account())),
  createUser = vi.fn<SentinelApi['createUser']>(async (input) =>
    accountDetail(
      account({
        id: 20,
        username: input.username,
        role: input.role,
        customers: [],
        createdAt: iso(0),
      }),
    ),
  ),
  updateUser = vi.fn<SentinelApi['updateUser']>(async (_id, patch) =>
    accountDetail(
      account({
        ...(patch.active === undefined ? {} : { active: patch.active }),
        ...(patch.role ? { role: patch.role } : {}),
      }),
    ),
  ),
  resetUserPassword = vi.fn<SentinelApi['resetUserPassword']>(async () => accountDetail(account())),
  unlockUser = vi.fn<SentinelApi['unlockUser']>(async () =>
    accountDetail(account({ locked: false })),
  ),
} = {}) {
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const api = createTestApi({
    source: 'http',
    getScopeOptions,
    getUser,
    createUser,
    updateUser,
    resetUserPassword,
    unlockUser,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/users" element={<p>accounts list</p>} />
        <Route path="/settings/users/new" element={<UserPage />} />
        <Route path="/settings/users/:id" element={<UserPage />} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { getUser, createUser, updateUser, resetUserPassword, unlockUser }
}

const where = () => screen.getByTestId('where').textContent
const field = (label: string) => screen.getByLabelText(label)

describe('who may open it', () => {
  it('is offered to administrators only', () => {
    const { getUser } = setup({ capabilities: can('manageCustomers') })
    expect(screen.getByText('Not permitted to manage accounts')).toBeInTheDocument()
    expect(getUser).not.toHaveBeenCalled()
  })
})

describe('a new account', () => {
  it('asks for the first password twice, and refuses two that differ', async () => {
    const user = userEvent.setup()
    const { createUser } = setup({ route: '/settings/users/new' })
    await screen.findByLabelText('User name')
    await user.type(field('User name'), 'vera')
    await user.type(field('First password'), 'a-long-passphrase')
    await user.type(field('Repeat the password'), 'another-passphrase')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByRole('alert')).toHaveTextContent('confirm')
    expect(field('Repeat the password')).toHaveAccessibleDescription(/The two passwords differ/)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('creates a viewer with the customers ticked, and opens the account saying the password is not shown again', async () => {
    const user = userEvent.setup()
    const { createUser } = setup({ route: '/settings/users/new' })
    await screen.findByLabelText('User name')
    await user.type(field('User name'), 'vera')
    await user.type(field('Email'), 'vera@example.com')
    await user.type(field('First password'), 'a-long-passphrase')
    await user.type(field('Repeat the password'), 'a-long-passphrase')
    expect(screen.getByText(/Reads what its customers and sites show/)).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Globex' }))
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({
        username: 'vera',
        password: 'a-long-passphrase',
        role: 'viewer',
        email: 'vera@example.com',
        firstName: '',
        lastName: '',
        active: true,
        allCustomers: false,
        customerIds: ['c2'],
        siteIds: [],
      }),
    )
    await waitFor(() => expect(where()).toBe('/settings/users/20'))
    expect(await screen.findByText(/Tell the user the first password/)).toBeInTheDocument()
  })

  it('hides the scope for an editor, who sees every customer', async () => {
    const user = userEvent.setup()
    setup({ route: '/settings/users/new' })
    await screen.findByLabelText('Role')
    await user.selectOptions(field('Role'), 'editor')
    expect(screen.queryByRole('checkbox', { name: 'Sees every customer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Globex' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Editors see every customer: there is no scope to choose.'),
    ).toBeInTheDocument()
  })

  it('puts the server’s word on the password under its field', async () => {
    const user = userEvent.setup()
    setup({
      route: '/settings/users/new',
      createUser: vi.fn(async () => {
        throw new ApiError('Some values are not valid.', 400, 'validation_error', {
          fields: { password: ['This password is too common.'] },
        })
      }),
    })
    await screen.findByLabelText('User name')
    await user.type(field('User name'), 'vera')
    await user.type(field('First password'), 'password1234')
    await user.type(field('Repeat the password'), 'password1234')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('This password is too common.')).toBeInTheDocument()
  })
})

describe('an existing account', () => {
  it('shows it, and saves only what changed, the role with its scope', async () => {
    const user = userEvent.setup()
    const { updateUser } = setup()
    expect(await screen.findByRole('heading', { level: 2, name: 'maria' })).toBeInTheDocument()
    expect(field('User name')).toHaveValue('maria')
    expect(screen.getByRole('checkbox', { name: 'Meridian' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Sees every customer' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith(7, {
        role: 'viewer',
        allCustomers: true,
        customerIds: [],
      }),
    )
    expect(await screen.findByText(/The account is saved/)).toBeInTheDocument()
  })

  it('deactivates from the form, and says the sessions ended', async () => {
    const user = userEvent.setup()
    const { updateUser } = setup()
    await screen.findByLabelText('User name')
    await user.click(screen.getByRole('checkbox', { name: 'Active' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith(7, { active: false }))
    expect(
      await screen.findByText(/It is deactivated: its sessions have ended/),
    ).toBeInTheDocument()
  })

  it('keeps your own account from being deactivated or demoted here, and sets no password for it', async () => {
    setup({
      getUser: vi.fn(async () =>
        accountDetail(
          account({
            id: 1,
            username: 'admin',
            role: 'administrator',
            allCustomers: true,
            self: true,
          }),
        ),
      ),
    })
    await screen.findByLabelText('User name')
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeDisabled()
    expect(field('Role')).toBeDisabled()
    expect(screen.getByText(/Your own role is not changed here/)).toBeInTheDocument()
    expect(
      screen.getByText('Your own password is changed from Settings > Account.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set password' })).not.toBeInTheDocument()
  })

  it('shows the server’s refusal to demote the last administrator on top', async () => {
    const user = userEvent.setup()
    setup({
      getUser: vi.fn(async () =>
        accountDetail(
          account({ id: 2, username: 'second', role: 'administrator', allCustomers: true }),
        ),
      ),
      updateUser: vi.fn(async () => {
        throw new ApiError(
          'This is the last active administrator: make another account an administrator first.',
          409,
          'last_administrator',
        )
      }),
    })
    await screen.findByLabelText('Role')
    await user.selectOptions(field('Role'), 'editor')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('last active administrator')
  })
})

describe('the password and the lockout', () => {
  it('sets a new password typed twice, and says the sessions ended', async () => {
    const user = userEvent.setup()
    const { resetUserPassword } = setup()
    const panel = await screen.findByRole('region', { name: 'Password' })
    await user.type(within(panel).getByLabelText('New password'), 'another-long-passphrase')
    await user.type(
      within(panel).getByLabelText('Repeat the new password'),
      'another-long-passphrase',
    )
    await user.click(within(panel).getByRole('button', { name: 'Set password' }))
    await waitFor(() =>
      expect(resetUserPassword).toHaveBeenCalledWith(7, 'another-long-passphrase'),
    )
    expect(await within(panel).findByText(/every session of “maria” has ended/)).toBeInTheDocument()
    expect(within(panel).getByLabelText('New password')).toHaveValue('')
  })

  it('unlocks a locked account', async () => {
    const user = userEvent.setup()
    const { unlockUser } = setup({
      getUser: vi.fn(async () => accountDetail(account({ locked: true, lockedUntil: iso(-600) }))),
    })
    const panel = await screen.findByRole('region', { name: 'Sign-in' })
    expect(within(panel).getByText('LOCKED')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Unlock sign-in' }))
    await waitFor(() => expect(unlockUser).toHaveBeenCalledWith(7))
    expect(await within(panel).findByText(/the account may sign in now/)).toBeInTheDocument()
    expect(within(panel).getByText('ALLOWED')).toBeInTheDocument()
  })
})

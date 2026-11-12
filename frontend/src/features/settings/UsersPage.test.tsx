import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import UsersPage from './UsersPage'
import { account, accountList } from './adminTesting'
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

const ACCOUNTS = [
  account(),
  account({
    id: 1,
    username: 'admin',
    role: 'administrator',
    allCustomers: true,
    self: true,
    firstName: '',
    lastName: '',
    email: '',
  }),
  account({
    id: 9,
    username: 'former',
    role: null,
    active: false,
    locked: true,
    lockedUntil: '2026-10-18T10:15:00.000Z',
    customers: [],
    lastLoginAt: null,
  }),
]

function setup({
  capabilities = can('manageUsers'),
  listUsers = vi.fn<SentinelApi['listUsers']>(async () => accountList(ACCOUNTS)),
} = {}) {
  const api = createTestApi({ source: 'http', listUsers })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="/settings/users/:id" element={<p>account page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route: '/settings/users', auth: createFakeAuth({ capabilities }) },
  )
  return { listUsers }
}

const table = () => screen.findByRole('table', { name: 'Accounts' })
const rowOf = (name: string) =>
  within(screen.getByRole('table', { name: 'Accounts' }))
    .getByRole('link', { name })
    .closest('tr') as HTMLElement

describe('who may open it', () => {
  it('is offered to administrators only', () => {
    const { listUsers } = setup({
      capabilities: can('manageCustomers', 'manageTargets', 'manageDevices'),
    })
    expect(screen.getByText('Not permitted to manage accounts')).toBeInTheDocument()
    expect(listUsers).not.toHaveBeenCalled()
  })
})

describe('the list', () => {
  it('lists every account with its role, what it sees and its state', async () => {
    setup()
    await table()
    expect(rowOf('maria')).toHaveTextContent('Viewer')
    expect(rowOf('maria')).toHaveTextContent('1 customer')
    expect(rowOf('maria')).toHaveTextContent('ACTIVE')
    expect(rowOf('admin')).toHaveTextContent('Administrator')
    expect(rowOf('admin')).toHaveTextContent('All customers')
    expect(rowOf('admin')).toHaveTextContent('YOU')
    expect(rowOf('former')).toHaveTextContent('No console access')
    expect(rowOf('former')).toHaveTextContent('INACTIVE')
    expect(rowOf('former')).toHaveTextContent('LOCKED')
    expect(rowOf('maria').querySelector('a')).toHaveAttribute('href', '/settings/users/7')
    expect(screen.getByRole('link', { name: 'New user' })).toHaveAttribute(
      'href',
      '/settings/users/new',
    )
    expect(screen.getByRole('button', { name: 'ACTIVE 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'INACTIVE 1' })).toBeInTheDocument()
  })

  it('filters by state and searches with the server', async () => {
    const user = userEvent.setup()
    const { listUsers } = setup()
    await table()
    await user.click(screen.getByRole('button', { name: 'INACTIVE 1' }))
    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'inactive' })),
    )
    expect(screen.getByTestId('where').textContent).toBe('/settings/users?active=inactive')
    await user.type(screen.getByLabelText('Search accounts'), 'mar')
    await waitFor(() =>
      expect(listUsers).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'mar', active: 'inactive' }),
      ),
    )
  })

  it('lists cards on a phone', async () => {
    stubViewport(false)
    setup()
    expect(await screen.findByRole('list', { name: 'Accounts' })).toBeInTheDocument()
  })
})

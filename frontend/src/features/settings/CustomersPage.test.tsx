import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import CustomersPage from './CustomersPage'
import { customer, customerList } from './adminTesting'
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
  capabilities = can('manageCustomers'),
  listCustomers = vi.fn<SentinelApi['listCustomers']>(async () =>
    customerList([
      customer(),
      customer({ id: 'c2', name: 'Globex', sites: 0, servers: 0, targets: 0 }),
    ]),
  ),
  route = '/settings/customers' as string | { pathname: string; state: unknown },
} = {}) {
  const api = createTestApi({ source: 'http', listCustomers })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/customers" element={<CustomersPage />} />
        <Route path="/settings/customers/:id" element={<p>customer page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, auth: createFakeAuth({ capabilities }) },
  )
  return { listCustomers }
}

const table = () => screen.findByRole('table', { name: 'Customers' })

describe('who may open it', () => {
  it('says so, and asks the server for nothing, without the capability', () => {
    const { listCustomers } = setup({ capabilities: can('manageOwnNotifications') })
    expect(screen.getByText('Not permitted to change customers and sites')).toBeInTheDocument()
    expect(listCustomers).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'New customer' })).not.toBeInTheDocument()
  })

  it('takes a refusal of the server for the last word', async () => {
    setup({
      listCustomers: vi.fn(async () => {
        throw new ApiError('no', 403, 'forbidden')
      }),
    })
    expect(
      await screen.findByText('Not permitted to change customers and sites'),
    ).toBeInTheDocument()
  })
})

describe('the list', () => {
  it('lists every customer with what belongs to it, each a link to its page', async () => {
    setup()
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Meridian' })).toHaveAttribute(
      'href',
      '/settings/customers/c1',
    )
    expect(rows[0]).toHaveTextContent('2')
    expect(screen.getByText('2 of 2 shown')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New customer' })).toHaveAttribute(
      'href',
      '/settings/customers/new',
    )
  })

  it('opens a customer when its row is clicked', async () => {
    const user = userEvent.setup()
    setup()
    // The notes cell of the first row: not the link, so the row's own click opens the customer.
    await user.click(within(await table()).getAllByText('first customer')[0] as HTMLElement)
    expect(await screen.findByText('customer page')).toBeInTheDocument()
    expect(screen.getByTestId('where').textContent).toBe('/settings/customers/c1')
  })

  it('searches with the server, after the typing settles, and keeps the search in the URL', async () => {
    const user = userEvent.setup()
    const { listCustomers } = setup()
    await table()
    await user.type(screen.getByLabelText('Search customers'), 'meri')
    await waitFor(() =>
      expect(listCustomers).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'meri', page: 1 }),
      ),
    )
    expect(screen.getByTestId('where').textContent).toBe('/settings/customers?q=meri')
  })

  it('says when there is none, and when none matches', async () => {
    setup({ listCustomers: vi.fn(async () => customerList([], 0)) })
    expect(await screen.findByText('No customers')).toBeInTheDocument()
  })

  it('says what was just deleted when sent here from a customer’s page', async () => {
    setup({ route: { pathname: '/settings/customers', state: { deleted: 'Globex' } } })
    expect(await screen.findByText('The customer “Globex” is deleted.')).toBeInTheDocument()
  })

  it('lists cards on a phone', async () => {
    stubViewport(false)
    setup()
    expect(await screen.findByRole('list', { name: 'Customers' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import CustomerPage from './CustomerPage'
import { customer, customerDetail, iso, site } from './adminTesting'
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
  capabilities = can('manageCustomers'),
  route = '/settings/customers/c1',
  getCustomer = vi.fn<SentinelApi['getCustomer']>(async () => customerDetail(customer(), [site()])),
  createCustomer = vi.fn<SentinelApi['createCustomer']>(async (input) =>
    customerDetail(customer({ id: 'c-new', name: input.name, sites: 0, servers: 0, targets: 0 })),
  ),
  updateCustomer = vi.fn<SentinelApi['updateCustomer']>(async (_id, patch) =>
    customerDetail(customer({ ...patch, updatedAt: iso(0) })),
  ),
  deleteCustomer = vi.fn<SentinelApi['deleteCustomer']>(async (id) => ({
    generatedAt: iso(0),
    deleted: { id, name: 'Meridian' },
  })),
} = {}) {
  const api = createTestApi({
    source: 'http',
    getCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/customers" element={<p>customers list</p>} />
        <Route path="/settings/customers/new" element={<CustomerPage />} />
        <Route path="/settings/customers/:id" element={<CustomerPage />} />
        <Route path="/settings/sites/:id" element={<p>site page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { getCustomer, createCustomer, updateCustomer, deleteCustomer }
}

const where = () => screen.getByTestId('where').textContent
const state = (): unknown => JSON.parse(screen.getByTestId('state').textContent ?? 'null')

describe('who may open it', () => {
  it('says so without the capability, and asks the server for nothing', () => {
    const { getCustomer } = setup({ capabilities: can('viewAlertRules') })
    expect(screen.getByText('Not permitted to change customers and sites')).toBeInTheDocument()
    expect(getCustomer).not.toHaveBeenCalled()
  })
})

describe('a new customer', () => {
  it('is created from the form and opened on its page', async () => {
    const user = userEvent.setup()
    const { createCustomer } = setup({ route: '/settings/customers/new' })
    expect(screen.getByRole('heading', { level: 2, name: 'New customer' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Name'), ' Initech ')
    await user.type(screen.getByLabelText('Notes'), 'third')
    await user.click(screen.getByRole('button', { name: 'Create customer' }))
    await waitFor(() => expect(where()).toBe('/settings/customers/c-new'))
    expect(createCustomer).toHaveBeenCalledWith({ name: 'Initech', notes: 'third' })
    expect(state()).toMatchObject({ created: true })
    expect(shell.announce).toHaveBeenCalledWith('Customer created.')
  })

  it('refuses an empty name here, and says so on top and under the field', async () => {
    const user = userEvent.setup()
    const { createCustomer } = setup({ route: '/settings/customers/new' })
    await user.click(screen.getByRole('button', { name: 'Create customer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Some values are not valid: name')
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(/Required/)
    expect(createCustomer).not.toHaveBeenCalled()
  })

  it('puts a taken name under the name field', async () => {
    const user = userEvent.setup()
    setup({
      route: '/settings/customers/new',
      createCustomer: vi.fn(async () => {
        throw new ApiError('A customer with this name already exists.', 409, 'customer_exists')
      }),
    })
    await user.type(screen.getByLabelText('Name'), 'Meridian')
    await user.click(screen.getByRole('button', { name: 'Create customer' }))
    expect(await screen.findByText('A customer with this name already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('an existing customer', () => {
  it('shows its form, its sites with a link to each and to a new one, and saves only what changed', async () => {
    const user = userEvent.setup()
    const { updateCustomer } = setup()
    expect(await screen.findByRole('heading', { level: 2, name: 'Meridian' })).toBeInTheDocument()
    expect(screen.getByLabelText('Notes')).toHaveValue('first customer')
    const sites = screen.getByRole('table', { name: 'Sites' })
    expect(within(sites).getByRole('link', { name: 'Athens DC' })).toHaveAttribute(
      'href',
      '/settings/sites/s1',
    )
    expect(screen.getByRole('link', { name: 'Add site' })).toHaveAttribute(
      'href',
      '/settings/sites/new?of=c1',
    )
    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).toBeDisabled()
    expect(screen.getByText('Nothing changed yet.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Notes'))
    await user.type(screen.getByLabelText('Notes'), 'second')
    await user.click(save)
    await waitFor(() => expect(updateCustomer).toHaveBeenCalledWith('c1', { notes: 'second' }))
    expect(await screen.findByText('The customer is saved.')).toBeInTheDocument()
  })

  it('says when it does not exist', async () => {
    setup({
      getCustomer: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
    })
    expect(await screen.findByText('Customer not found')).toBeInTheDocument()
  })
})

describe('deleting a customer', () => {
  it('is not offered while something still belongs to it, and says what', async () => {
    setup()
    const button = await screen.findByRole('button', { name: 'Delete customer' })
    expect(button).toBeDisabled()
    expect(screen.getByText(/It still has 1 site: move or delete them first/)).toBeInTheDocument()
  })

  it('asks for the name to be typed, deletes, and goes back to the list saying so', async () => {
    const user = userEvent.setup()
    const { deleteCustomer } = setup({
      getCustomer: vi.fn(async () =>
        customerDetail(customer({ sites: 0, servers: 0, targets: 0 })),
      ),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete customer' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the customer “Meridian”?' })
    expect(within(dialog).getByRole('button', { name: 'Delete customer' })).toBeDisabled()
    await user.type(
      within(dialog).getByLabelText('Type the customer’s name to confirm'),
      'Meridian',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Delete customer' }))
    await waitFor(() => expect(deleteCustomer).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(where()).toBe('/settings/customers'))
    expect(state()).toEqual({ deleted: 'Meridian' })
  })

  it('shows the server’s refusal inside the confirmation, and deletes nothing', async () => {
    const user = userEvent.setup()
    setup({
      getCustomer: vi.fn(async () =>
        customerDetail(customer({ sites: 0, servers: 0, targets: 0 })),
      ),
      deleteCustomer: vi.fn(async () => {
        throw new ApiError(
          'The customer “Meridian” still has 1 alert rule: move or delete them first.',
          409,
          'customer_in_use',
        )
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete customer' }))
    const dialog = screen.getByRole('alertdialog')
    await user.type(
      within(dialog).getByLabelText('Type the customer’s name to confirm'),
      'Meridian',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Delete customer' }))
    expect(await within(dialog).findByText(/still has 1 alert rule/)).toBeInTheDocument()
    expect(where()).toBe('/settings/customers/c1')
    expect(shell.announce).toHaveBeenCalledWith('The customer was not deleted.')
  })
})

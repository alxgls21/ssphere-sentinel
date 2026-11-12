import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import SitePage from './SitePage'
import { SCOPE, iso, site, siteDetail } from './adminTesting'
import { can } from './testing'

const shell = createFakeShell()

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="where">{pathname + search}</span>
}

function setup({
  capabilities = can('manageCustomers'),
  route = '/settings/sites/s1',
  getSite = vi.fn<SentinelApi['getSite']>(async () => siteDetail(site())),
  createSite = vi.fn<SentinelApi['createSite']>(async (input) =>
    siteDetail(site({ id: 's-new', ...input, servers: 0, devices: 0, targets: 0 })),
  ),
  updateSite = vi.fn<SentinelApi['updateSite']>(async (_id, patch) =>
    siteDetail(
      site({
        ...patch,
        customerName: patch.customerId === 'c2' ? 'Globex' : 'Meridian',
        updatedAt: iso(0),
      }),
    ),
  ),
  deleteSite = vi.fn<SentinelApi['deleteSite']>(async (id) => ({
    generatedAt: iso(0),
    deleted: { id, name: 'Athens DC' },
  })),
} = {}) {
  const getScopeOptions = vi.fn<SentinelApi['getScopeOptions']>(async () => SCOPE)
  const api = createTestApi({
    source: 'http',
    getScopeOptions,
    getSite,
    createSite,
    updateSite,
    deleteSite,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/customers/:id" element={<p>customer page</p>} />
        <Route path="/settings/sites/new" element={<SitePage />} />
        <Route path="/settings/sites/:id" element={<SitePage />} />
      </Routes>
      <Where />
    </>,
    { api, route, withShell: shell, auth: createFakeAuth({ capabilities }) },
  )
  return { getSite, createSite, updateSite, deleteSite }
}

const where = () => screen.getByTestId('where').textContent

describe('a new site', () => {
  it('starts with the customer it was opened for, and is created and opened', async () => {
    const user = userEvent.setup()
    // `of`, not `customer`: the latter is the console's scope, which this page must not change.
    const { createSite } = setup({ route: '/settings/sites/new?of=c2' })
    expect(await screen.findByLabelText('Customer')).toHaveValue('c2')
    expect(screen.getByRole('link', { name: 'Customers & sites' })).toHaveAttribute(
      'href',
      '/settings/customers/c2',
    )
    await user.type(screen.getByLabelText('Name'), 'Plant 2')
    await user.click(screen.getByRole('button', { name: 'Create site' }))
    await waitFor(() =>
      expect(createSite).toHaveBeenCalledWith({
        customerId: 'c2',
        name: 'Plant 2',
        description: '',
      }),
    )
    await waitFor(() => expect(where()).toBe('/settings/sites/s-new'))
  })

  it('needs a customer and a name', async () => {
    const user = userEvent.setup()
    const { createSite } = setup({ route: '/settings/sites/new' })
    await screen.findByLabelText('Customer')
    await user.click(screen.getByRole('button', { name: 'Create site' }))
    expect(screen.getByRole('alert')).toHaveTextContent('customerId, name')
    expect(createSite).not.toHaveBeenCalled()
  })

  it('says so without the capability', () => {
    setup({ capabilities: can('manageTargets'), route: '/settings/sites/new' })
    expect(screen.getByText('Not permitted to change customers and sites')).toBeInTheDocument()
  })
})

describe('an existing site', () => {
  it('is moved to another customer with a word of warning, saving only the move', async () => {
    const user = userEvent.setup()
    const { updateSite } = setup()
    expect(await screen.findByRole('heading', { level: 2, name: 'Athens DC' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Meridian' })).toHaveAttribute(
      'href',
      '/settings/customers/c1',
    )
    await user.selectOptions(screen.getByLabelText('Customer'), 'c2')
    expect(
      screen.getByText(/Moving the site changes who sees everything on it/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save and move' }))
    await waitFor(() => expect(updateSite).toHaveBeenCalledWith('s1', { customerId: 'c2' }))
    expect(await screen.findByText('The site is saved.')).toBeInTheDocument()
  })

  it('is not deleted while something is placed on it, and otherwise after its name is typed', async () => {
    const user = userEvent.setup()
    const { deleteSite } = setup({
      getSite: vi.fn(async () => siteDetail(site({ servers: 0, targets: 0 }))),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete site' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete the site “Athens DC”?' })
    await user.type(within(dialog).getByLabelText('Type the site’s name to confirm'), 'Athens DC')
    await user.click(within(dialog).getByRole('button', { name: 'Delete site' }))
    await waitFor(() => expect(deleteSite).toHaveBeenCalledWith('s1'))
    await waitFor(() => expect(where()).toBe('/settings/customers/c1'))
  })

  it('offers no deletion while servers or targets are on it, and says what', async () => {
    setup()
    expect(await screen.findByRole('button', { name: 'Delete site' })).toBeDisabled()
    expect(screen.getByText(/It still has 2 servers, 1 network target/)).toBeInTheDocument()
  })
})

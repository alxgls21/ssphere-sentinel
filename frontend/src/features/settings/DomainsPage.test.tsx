import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import DomainsPage from './DomainsPage'
import { SCOPE, domain, domainDetail, domainList } from './adminTesting'
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

const DOMAINS = [
  domain(),
  domain({
    id: 'd2',
    name: 'xn--bcher-kva.example',
    displayName: 'bücher.example',
    status: 'verified',
    customer: { id: 'c2', name: 'Globex' },
  }),
]

function setup({
  capabilities = can('viewDomains'),
  listDomains = vi.fn<SentinelApi['listDomains']>(async () => domainList(DOMAINS)),
  createDomain = vi.fn<SentinelApi['createDomain']>(async (input) =>
    domainDetail(domain({ id: 'd9', name: input.name, displayName: input.name })),
  ),
  route = '/settings/domains',
} = {}) {
  const api = createTestApi({
    source: 'http',
    listDomains,
    createDomain,
    getScopeOptions: async () => SCOPE,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/settings/domains" element={<DomainsPage />} />
        <Route path="/settings/domains/:id" element={<p>domain page</p>} />
      </Routes>
      <Where />
    </>,
    { api, route, auth: createFakeAuth({ capabilities }) },
  )
  return { listDomains, createDomain }
}

const table = () => screen.findByRole('table', { name: 'Domains' })

describe('who may open it', () => {
  it('says so, and asks the server for nothing, without the capability', () => {
    const { listDomains } = setup({ capabilities: can('manageOwnNotifications') })
    expect(screen.getByText('Not permitted to see monitored domains')).toBeInTheDocument()
    expect(listDomains).not.toHaveBeenCalled()
  })

  it('takes a refusal of the server for the last word', async () => {
    setup({
      listDomains: vi.fn(async () => {
        throw new ApiError('no', 403, 'forbidden')
      }),
    })
    expect(await screen.findByText('Not permitted to see monitored domains')).toBeInTheDocument()
  })

  it('offers the form to add one only to an account that may add', async () => {
    setup()
    await table()
    expect(screen.queryByRole('form', { name: 'Add a domain' })).not.toBeInTheDocument()
  })
})

describe('the list', () => {
  it('lists each domain by its Unicode name with its customer and its state in words', async () => {
    setup()
    const rows = within(await table())
    expect(rows.getByRole('link', { name: 'acme.example' })).toBeInTheDocument()
    expect(rows.getByRole('link', { name: 'bücher.example' })).toBeInTheDocument()
    expect(rows.getByText('PENDING')).toBeInTheDocument()
    expect(rows.getByText('VERIFIED')).toBeInTheDocument()
    expect(screen.getByText('2 of 2 shown')).toBeInTheDocument()
  })

  it('asks the server for the search, the state and the sort it is given', async () => {
    const { listDomains } = setup({ route: '/settings/domains?q=acme&status=pending&sort=status' })
    await table()
    expect(listDomains).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'acme', status: 'pending', sort: 'status', pageSize: 50 }),
    )
  })

  it('says there are none when the server has none', async () => {
    setup({ listDomains: vi.fn(async () => domainList([], 0)) })
    expect(await screen.findByText('No domains')).toBeInTheDocument()
  })

  it('opens a domain on its own page', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(within(await table()).getByRole('link', { name: 'acme.example' }))
    expect(await screen.findByText('domain page')).toBeInTheDocument()
  })
})

describe('after a deletion', () => {
  it('says which domain went, with its customer, when the domain page sends the operator here', async () => {
    setup({
      route: {
        pathname: '/settings/domains',
        state: { deleted: 'bücher.example', customer: 'Globex' },
      } as unknown as string,
    })
    expect(
      await screen.findByText(
        'The domain bücher.example of Globex is deleted, with its verification history.',
      ),
    ).toBeInTheDocument()
  })
})

describe('adding a domain', () => {
  it('checks the customer and the name here before asking the server', async () => {
    const user = userEvent.setup()
    const { createDomain } = setup({ capabilities: can('viewDomains', 'addDomains') })
    await table()
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(createDomain).not.toHaveBeenCalled()
    expect(await screen.findAllByText(/Choose the customer/)).not.toHaveLength(0)
    expect(screen.getAllByText(/Enter the domain/)).not.toHaveLength(0)
  })

  it('sends the customer and the name as typed, then opens the new domain', async () => {
    const user = userEvent.setup()
    const { createDomain } = setup({ capabilities: can('viewDomains', 'addDomains') })
    await table()
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1')
    await user.type(screen.getByLabelText('Domain'), ' Example.com ')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    await waitFor(() =>
      expect(createDomain).toHaveBeenCalledWith({ customerId: 'c1', name: 'Example.com' }),
    )
    expect(await screen.findByText('domain page')).toBeInTheDocument()
  })

  it('shows the server’s refusal of a domain the customer already has under the name', async () => {
    const user = userEvent.setup()
    setup({
      capabilities: can('viewDomains', 'addDomains'),
      createDomain: vi.fn(async () => {
        throw new ApiError('This customer already has that domain.', 409, 'domain_exists')
      }),
    })
    await table()
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1')
    await user.type(screen.getByLabelText('Domain'), 'acme.example')
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(await screen.findByText('This customer already has that domain.')).toBeInTheDocument()
  })
})

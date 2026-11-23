import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import DomainPage from './DomainPage'
import { domain, domainDetail, verification, verificationAnswer } from './adminTesting'
import { can } from './testing'

afterEach(() => vi.useRealTimers())

function setup({
  capabilities = can('viewDomains', 'verifyDomains'),
  getDomain = vi.fn<SentinelApi['getDomain']>(async () => domainDetail(domain())),
  verifyDomain = vi.fn<SentinelApi['verifyDomain']>(async () =>
    verificationAnswer(verification({ status: 'pending' })),
  ),
  getDomainVerification = vi.fn<SentinelApi['getDomainVerification']>(async () =>
    verificationAnswer(verification({ status: 'running' })),
  ),
  deleteDomain = vi.fn<SentinelApi['deleteDomain']>(async () => ({
    generatedAt: new Date().toISOString(),
    deleted: {
      id: 'd1',
      name: 'acme.example',
      displayName: 'acme.example',
      customer: { id: 'c1', name: 'Acme' },
    },
  })),
} = {}) {
  const api = createTestApi({
    source: 'http',
    getDomain,
    verifyDomain,
    getDomainVerification,
    deleteDomain,
  })
  renderApp(
    <Routes>
      <Route path="/settings/domains" element={<p>domains list</p>} />
      <Route path="/settings/domains/:id" element={<DomainPage />} />
    </Routes>,
    { api, route: '/settings/domains/d1', auth: createFakeAuth({ capabilities }) },
  )
  return { getDomain, verifyDomain, getDomainVerification, deleteDomain }
}

describe('the domain', () => {
  it('says so, and asks for nothing, without the capability', () => {
    const { getDomain } = setup({ capabilities: can('manageOwnNotifications') })
    expect(screen.getByText('Not permitted to see monitored domains')).toBeInTheDocument()
    expect(getDomain).not.toHaveBeenCalled()
  })

  it('shows what it is, its state in words, and the record to add to the DNS, verbatim', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'acme.example' })).toBeInTheDocument()
    expect(screen.getByText('PENDING')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    const record = screen.getByLabelText('Record text')
    expect(record).toHaveTextContent('_ssphere-sentinel.acme.example')
    expect(record).toHaveTextContent('ssphere-verification=abc123')
  })

  it('says a domain that does not exist does not, in words', async () => {
    setup({
      getDomain: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
    })
    expect(await screen.findByText('Domain not found')).toBeInTheDocument()
  })

  it('says what the latest verification found, with the name servers it asked', async () => {
    setup({
      getDomain: vi.fn(async () =>
        domainDetail(
          domain({ status: 'verified', lastCheckedAt: new Date().toISOString() }),
          verification({
            status: 'done',
            outcome: { value: 'verified', label: 'Verified' },
            detail: null,
            finishedAt: new Date().toISOString(),
            evidence: {
              zone: 'acme.example',
              aliases: [],
              nameserverCount: 1,
              nameservers: [{ name: 'ns1.acme.example', address: '192.0.2.1', result: 'found' }],
            },
          }),
        ),
      ),
    })
    expect(await screen.findByText('Verified.')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Name servers asked' })).toHaveTextContent(
      'ns1.acme.example',
    )
  })
})

describe('asking for a verification', () => {
  it('offers the button only to an account that may verify', async () => {
    setup({ capabilities: can('viewDomains') })
    await screen.findByRole('heading', { name: 'acme.example' })
    expect(screen.queryByRole('button', { name: 'Verify now' })).not.toBeInTheDocument()
  })

  it('asks, shows the request is going, and follows it until it is over, then reads the domain again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const getDomainVerification = vi
      .fn<SentinelApi['getDomainVerification']>()
      .mockResolvedValueOnce(verificationAnswer(verification({ status: 'running' })))
      .mockResolvedValue(
        verificationAnswer(
          verification({
            status: 'done',
            outcome: { value: 'absent', label: 'Record not found' },
            detail: { value: 'x', label: 'no name server has it' },
          }),
          'running',
        ),
      )
    const { verifyDomain, getDomain } = setup({ getDomainVerification })
    await user.click(await screen.findByRole('button', { name: 'Verify now' }))
    expect(verifyDomain).toHaveBeenCalledWith('d1')
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(screen.getByText('Waiting for the verifier to pick the request up.')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(3100))
    expect(
      await screen.findByText('The verifier is asking the domain’s name servers.'),
    ).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(3100))
    expect(await screen.findByText('Record not found: no name server has it.')).toBeInTheDocument()
    await waitFor(() => expect(getDomain.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByRole('button', { name: 'Verify now' })).toBeEnabled()
  })

  it('tells how long to wait when the server limits the requests', async () => {
    const user = userEvent.setup()
    setup({
      verifyDomain: vi.fn(async () => {
        throw new ApiError('Slow down.', 429, 'rate_limited', { retryAfterSeconds: 8 })
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Verify now' }))
    expect(
      await screen.findByText('Verifications are limited: try again in 8 seconds.'),
    ).toBeInTheDocument()
  })

  it('shows the server’s own words when one is already waiting', async () => {
    const user = userEvent.setup()
    setup({
      verifyDomain: vi.fn(async () => {
        throw new ApiError(
          'A verification of this domain is already waiting or running.',
          409,
          'verification_active',
        )
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Verify now' }))
    expect(
      await screen.findByText('A verification of this domain is already waiting or running.'),
    ).toBeInTheDocument()
  })
})

describe('deleting the domain', () => {
  const admin = can('viewDomains', 'verifyDomains', 'deleteDomains')

  it('offers it only to an account that may delete', async () => {
    setup()
    await screen.findByRole('heading', { name: 'acme.example' })
    expect(screen.queryByRole('button', { name: 'Delete domain' })).not.toBeInTheDocument()
  })

  it('says what goes with it, asks for the name typed back, then deletes and returns to the list', async () => {
    const user = userEvent.setup()
    const { deleteDomain } = setup({ capabilities: admin })
    await user.click(await screen.findByRole('button', { name: 'Delete domain' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/verification history are deleted/)).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Adding the domain again later gives a new record/),
    ).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete domain' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByRole('textbox'), 'acme.example')
    await user.click(confirm)
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith('d1'))
    expect(await screen.findByText('domains list')).toBeInTheDocument()
  })

  it('shows the server’s words when a verification is still going, and does not leave the page', async () => {
    const user = userEvent.setup()
    setup({
      capabilities: admin,
      deleteDomain: vi.fn(async () => {
        throw new ApiError(
          'A verification of this domain is waiting or running: wait for its answer, then delete it.',
          409,
          'verification_active',
        )
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete domain' }))
    const dialog = screen.getByRole('alertdialog')
    await user.type(within(dialog).getByRole('textbox'), 'acme.example')
    await user.click(within(dialog).getByRole('button', { name: 'Delete domain' }))
    expect(
      await within(dialog).findByText(/wait for its answer, then delete it/),
    ).toBeInTheDocument()
    expect(screen.queryByText('domains list')).not.toBeInTheDocument()
  })

  it('goes back to the list when the domain is gone already', async () => {
    const user = userEvent.setup()
    setup({
      capabilities: admin,
      deleteDomain: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
    })
    await user.click(await screen.findByRole('button', { name: 'Delete domain' }))
    const dialog = screen.getByRole('alertdialog')
    await user.type(within(dialog).getByRole('textbox'), 'acme.example')
    await user.click(within(dialog).getByRole('button', { name: 'Delete domain' }))
    expect(await screen.findByText('domains list')).toBeInTheDocument()
  })

  it('does not offer it while a verification is waiting or running', async () => {
    setup({
      capabilities: admin,
      getDomain: vi.fn(async () => domainDetail(domain(), verification({ status: 'running' }))),
    })
    expect(await screen.findByRole('button', { name: 'Delete domain' })).toBeDisabled()
  })
})

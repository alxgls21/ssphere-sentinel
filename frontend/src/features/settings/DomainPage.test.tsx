import { act, screen, waitFor } from '@testing-library/react'
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
} = {}) {
  const api = createTestApi({
    source: 'http',
    getDomain,
    verifyDomain,
    getDomainVerification,
  })
  renderApp(
    <Routes>
      <Route path="/settings/domains/:id" element={<DomainPage />} />
    </Routes>,
    { api, route: '/settings/domains/d1', auth: createFakeAuth({ capabilities }) },
  )
  return { getDomain, verifyDomain, getDomainVerification }
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

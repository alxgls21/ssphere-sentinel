import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import EmailLogPage from './EmailLogPage'
import { delivery, deliveryList } from './adminTesting'
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

const ITEMS = [
  delivery(),
  delivery({
    id: 2,
    status: 'failed',
    failure: { category: 'recipient_refused', label: 'The SMTP server refused the recipient' },
    sentAt: null,
    recipient: { id: 9, username: 'carol' },
  }),
  delivery({
    id: 3,
    status: 'pending',
    failure: { category: 'timeout', label: 'The SMTP server did not answer in time' },
    nextAttemptAt: new Date(Date.parse('2026-10-18T10:05:00Z')).toISOString(),
    sentAt: null,
    recipient: { id: null, username: 'former' },
    kind: 'recovered',
  }),
  delivery({
    id: 4,
    status: 'cancelled',
    failure: { category: 'recipient_unavailable', label: 'The account is deactivated' },
    sentAt: null,
  }),
]

function setup({
  capabilities = can('viewDeliveryLog'),
  listDeliveries = vi.fn<SentinelApi['listDeliveries']>(async () => deliveryList(ITEMS)),
  route = '/settings/email-log',
} = {}) {
  const api = createTestApi({ source: 'http', listDeliveries })
  renderApp(
    <Routes>
      <Route path="/settings/email-log" element={<EmailLogPage />} />
    </Routes>,
    { api, route, auth: createFakeAuth({ capabilities }) },
  )
  return { listDeliveries }
}

const table = () => screen.findByRole('table', { name: 'Incident emails' })
const rowOf = (text: string) =>
  within(screen.getByRole('table', { name: 'Incident emails' }))
    .getByText(text)
    .closest('tr') as HTMLElement

describe('who may open it', () => {
  it('says so, and asks the server for nothing, without the capability', () => {
    const { listDeliveries } = setup({ capabilities: can('manageUsers') })
    expect(screen.getByText('Not permitted to read the email log')).toBeInTheDocument()
    expect(listDeliveries).not.toHaveBeenCalled()
  })

  it('takes a refusal of the server for the last word', async () => {
    setup({
      listDeliveries: vi.fn(async () => {
        throw new ApiError('no', 403, 'forbidden')
      }),
    })
    expect(await screen.findByText('Not permitted to read the email log')).toBeInTheDocument()
  })
})

describe('the log', () => {
  it('says what became of each email in words, with the server’s own failure labels', async () => {
    setup()
    await table()
    expect(rowOf('carol')).toHaveTextContent('FAILED')
    expect(rowOf('carol')).toHaveTextContent(
      'Not delivered: The SMTP server refused the recipient.',
    )
    expect(rowOf('former')).toHaveTextContent('QUEUED')
    expect(rowOf('former')).toHaveTextContent(
      'The last attempt failed (The SMTP server did not answer in time)',
    )
    expect(rowOf('former')).toHaveTextContent('Tried again')
    const cancelled = within(screen.getByRole('table', { name: 'Incident emails' })).getByText(
      /Not sent, on purpose: The account is deactivated\./,
    )
    expect(cancelled).toBeInTheDocument()
  })

  it('links the recipient to the account and the incident to its page, and never shows an address', async () => {
    setup()
    const t = within(await table())
    expect(t.getAllByRole('link', { name: 'maria' })[0]).toHaveAttribute(
      'href',
      '/settings/users/7',
    )
    expect(t.getAllByRole('link', { name: 'Server resources' })[0]).toHaveAttribute(
      'href',
      '/alerts/i1',
    )
    // An account that is gone has a name and no link.
    expect(t.getByText('former')).not.toHaveAttribute('href')
    expect(screen.queryByText(/@/)).not.toBeInTheDocument()
  })

  it('says how long emails are kept and that test emails are not listed', async () => {
    setup()
    await table()
    expect(screen.getByText(/Kept for 90 days/)).toBeInTheDocument()
    expect(screen.getByText(/Test emails are not listed/)).toBeInTheDocument()
  })

  it('counts each state in its chip and asks the server for the one chosen', async () => {
    const user = userEvent.setup()
    const { listDeliveries } = setup()
    await table()
    expect(screen.getByRole('button', { name: 'FAILED 1' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'FAILED 1' }))
    await waitFor(() =>
      expect(listDeliveries).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failed' }),
      ),
    )
  })

  it('asks for the incident or the account it is narrowed to, and says so, with a way back', async () => {
    const user = userEvent.setup()
    const { listDeliveries } = setup({ route: '/settings/email-log?incident=i1' })
    await table()
    expect(listDeliveries).toHaveBeenCalledWith(expect.objectContaining({ incident: 'i1' }))
    expect(screen.getByText('Only the emails of one incident.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all emails' }))
    await waitFor(() => expect(screen.queryByText('Only the emails of one incident.')).toBeNull())
  })

  it('says there are no emails when there are none', async () => {
    setup({ listDeliveries: vi.fn(async () => deliveryList([], 0)) })
    expect(await screen.findByText('No emails')).toBeInTheDocument()
  })

  it('is a list of cards on a phone', async () => {
    stubViewport(false)
    setup()
    const cards = await screen.findByRole('list', { name: 'Incident emails' })
    expect(within(cards).getAllByRole('listitem')).toHaveLength(4)
  })
})

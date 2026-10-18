import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { NotificationSettings, NotifierState, TestEmail } from '@/api/types'
import { createTestApi, renderApp } from '@/test/render'
import { TestEmailPanel } from './TestEmailPanel'
import { iso, notificationSettings, testEmail } from './testing'
import { POLL_MAX_MS, POLL_MS } from './useTestEmail'

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

const answer = (item: TestEmail, state: NotifierState = 'running') => ({
  generatedAt: iso(0),
  item,
  notifier: { state },
})

function setup({
  settings = notificationSettings(),
  permitted = true,
}: { settings?: NotificationSettings; permitted?: boolean } = {}) {
  const requestTestEmail = vi.fn<SentinelApi['requestTestEmail']>()
  const getTestEmail = vi.fn<SentinelApi['getTestEmail']>()
  const onRefresh = vi.fn()
  const api = createTestApi({ source: 'http', requestTestEmail, getTestEmail })
  const view = renderApp(
    <TestEmailPanel settings={settings} permitted={permitted} onRefresh={onRefresh} />,
    { api },
  )
  return { requestTestEmail, getTestEmail, onRefresh, ...view }
}

const send = () => screen.getByRole('button', { name: /Send test email|Asking…/ })
const latest = () => screen.getByRole('region', { name: 'Latest test email' })
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
/** A click, with the timers faked: the pointer's own delays would never run. */
const click = (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element)
  })

describe('who may send one, and when', () => {
  it('offers no action to an account without the capability, and says why', () => {
    setup({ permitted: false })
    expect(screen.queryByRole('button', { name: 'Send test email' })).not.toBeInTheDocument()
    expect(screen.getByText(/may not send test emails/)).toBeInTheDocument()
  })

  it('offers none when the server says this account may not either', () => {
    setup({ settings: notificationSettings({ allowed: false }) })
    expect(screen.queryByRole('button', { name: 'Send test email' })).not.toBeInTheDocument()
  })

  it('offers the action, enabled, to an account that may', () => {
    setup()
    expect(send()).toBeEnabled()
    expect(screen.getByText('No test email has been asked for yet.')).toBeInTheDocument()
  })

  it('disables it where the server sends no email, and says so', () => {
    setup({ settings: notificationSettings({ available: false }) })
    expect(send()).toBeDisabled()
    expect(
      screen.getByText('This server sends no email, so there is nothing to test.'),
    ).toBeInTheDocument()
  })

  it('disables it for an account with no address, and says so', () => {
    setup({ settings: notificationSettings({ email: null }) })
    expect(send()).toBeDisabled()
    expect(screen.getByText('Your account has no email address to send it to.')).toBeInTheDocument()
  })

  it('is always sent to the account’s own address: the request names no address', async () => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending')))
    await click(send())
    expect(served.requestTestEmail).toHaveBeenCalledWith()
  })
})

describe('asking for one', () => {
  it('shows it queued, and offers no second until it is final', async () => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending')))
    await click(send())
    const card = latest()
    expect(within(card).getByText('QUEUED')).toBeInTheDocument()
    expect(within(card).getByText(/^Queued: waiting for the notifier/)).toBeInTheDocument()
    expect(send()).toBeDisabled()
    expect(screen.getByText(/One is on its way/)).toBeInTheDocument()
  })

  it('says the button is busy while the request is in flight', async () => {
    const served = setup()
    let finish: (value: ReturnType<typeof answer>) => void = () => {}
    served.requestTestEmail.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    await click(send())
    expect(screen.getByRole('button', { name: 'Asking…' })).toBeDisabled()
    await act(async () => finish(answer(testEmail('pending'))))
    expect(within(latest()).getByText('QUEUED')).toBeInTheDocument()
  })

  it.each([
    ['disabled', /sends no email, so nothing will take it/],
    ['never_started', /never run/],
    ['stale', /stopped or is stuck/],
    ['failed', /is failing/],
  ] as const)('says what a %s notifier means for a queued test email', async (state, words) => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending'), state))
    await click(send())
    expect(screen.getByText(words)).toBeInTheDocument()
  })

  it('says nothing of the notifier while it runs', async () => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending'), 'running'))
    await click(send())
    expect(screen.queryByText(/nothing will take it/)).not.toBeInTheDocument()
  })
})

describe('following it', () => {
  it('asks again only while it is queued or sending, and stops at the first final state', async () => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending')))
    served.getTestEmail
      .mockResolvedValueOnce(answer(testEmail('sending')))
      .mockResolvedValueOnce(answer(testEmail('sent')))
    await click(send())
    expect(served.getTestEmail).not.toHaveBeenCalled()

    await tick(POLL_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
    expect(served.getTestEmail).toHaveBeenCalledWith('test-1', expect.any(Object))
    expect(within(latest()).getByText('SENDING')).toBeInTheDocument()

    await tick(POLL_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(2)
    expect(within(latest()).getByText('SENT')).toBeInTheDocument()
    expect(send()).toBeEnabled()

    await tick(POLL_MS * 10)
    expect(served.getTestEmail).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['sent', 'SENT'],
    ['failed', 'FAILED'],
    ['cancelled', 'CANCELLED'],
    ['expired', 'EXPIRED'],
  ] as const)('stops at %s', async (status, word) => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending')))
    served.getTestEmail.mockResolvedValue(answer(testEmail(status)))
    await click(send())
    await tick(POLL_MS)
    expect(within(latest()).getByText(word)).toBeInTheDocument()
    await tick(POLL_MS * 5)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
  })

  it('follows one that was open when the page was read, and never asks about a final one', async () => {
    const open = setup({ settings: notificationSettings({ latest: testEmail('sending') }) })
    open.getTestEmail.mockResolvedValue(answer(testEmail('sent')))
    await tick(POLL_MS)
    expect(open.getTestEmail).toHaveBeenCalledTimes(1)
    expect(within(latest()).getByText('SENT')).toBeInTheDocument()
  })

  it('tells an age as of the answer that carried it, not of when the page was read', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail.mockResolvedValue({
      generatedAt: iso(-120),
      item: testEmail('sent', { finishedAt: iso(-115) }),
      notifier: { state: 'running' },
    })
    await tick(POLL_MS)
    expect(latest()).toHaveTextContent('Sent 5s ago')
    expect(latest()).not.toHaveTextContent('now ago')
  })

  it('says just now for one that went within the last moments', async () => {
    const served = setup()
    served.requestTestEmail.mockResolvedValue(answer(testEmail('pending')))
    served.getTestEmail.mockResolvedValue({
      generatedAt: iso(-60),
      item: testEmail('sent', { finishedAt: iso(-58) }),
      notifier: { state: 'running' },
    })
    await click(send())
    await tick(POLL_MS)
    expect(latest()).toHaveTextContent('Sent just now')
  })

  it('does not ask at all about one that is already final', async () => {
    const done = setup({ settings: notificationSettings({ latest: testEmail('failed') }) })
    await tick(POLL_MS * 5)
    expect(done.getTestEmail).not.toHaveBeenCalled()
  })

  it('does not ask at all when there is none', async () => {
    const none = setup()
    await tick(POLL_MS * 5)
    expect(none.getTestEmail).not.toHaveBeenCalled()
  })

  it('stops asking when the screen goes away', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail.mockResolvedValue(answer(testEmail('pending')))
    await tick(POLL_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
    served.unmount()
    await tick(POLL_MS * 5)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
  })

  it('says when a reading fails, keeps what it knew, and asks again more slowly', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail.mockRejectedValue(new ApiError('Busy.', 503, 'unavailable'))
    await tick(POLL_MS)
    expect(
      screen.getByText('Its status could not be read just now: asking again.'),
    ).toBeInTheDocument()
    expect(within(latest()).getByText('QUEUED')).toBeInTheDocument()
    await tick(POLL_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
    await tick(POLL_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(2)
    await tick(POLL_MS * 2)
    expect(served.getTestEmail).toHaveBeenCalledTimes(2)
    await tick(POLL_MS * 2)
    expect(served.getTestEmail).toHaveBeenCalledTimes(3)
  })

  it('never waits longer than the longest between two readings', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail.mockRejectedValue(new ApiError('Busy.', 503, 'unavailable'))
    for (let failures = 0; failures < 8; failures += 1) {
      await tick(Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS))
    }
    const calls = served.getTestEmail.mock.calls.length
    await tick(POLL_MAX_MS)
    expect(served.getTestEmail).toHaveBeenCalledTimes(calls + 1)
  })

  it('goes back to normal speed, and drops the notice, when a reading works again', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail
      .mockRejectedValueOnce(new ApiError('Busy.', 503, 'unavailable'))
      .mockResolvedValue(answer(testEmail('sending')))
    await tick(POLL_MS)
    expect(screen.getByText(/could not be read just now/)).toBeInTheDocument()
    await tick(POLL_MS * 2)
    expect(screen.queryByText(/could not be read just now/)).not.toBeInTheDocument()
    expect(within(latest()).getByText('SENDING')).toBeInTheDocument()
  })

  it('stops, and says it is gone, when the server cannot find it', async () => {
    const served = setup({ settings: notificationSettings({ latest: testEmail('pending') }) })
    served.getTestEmail.mockRejectedValue(new ApiError('Not found.', 404, 'not_found'))
    await tick(POLL_MS)
    expect(screen.getByText(/It can no longer be found/)).toBeInTheDocument()
    await tick(POLL_MS * 10)
    expect(served.getTestEmail).toHaveBeenCalledTimes(1)
  })
})

describe('how it ended', () => {
  it('says a failure by its category and the server’s own label, never the mail server’s words', () => {
    setup({
      settings: notificationSettings({
        latest: testEmail('failed', {
          failure: { category: 'authentication', label: 'Logging in to the mail server failed' },
        }),
      }),
    })
    const card = latest()
    expect(within(card).getByText('FAILED')).toBeInTheDocument()
    expect(card).toHaveTextContent('Not sent: Logging in to the mail server failed.')
    expect(card).toHaveTextContent('reason: authentication')
    expect(card).not.toHaveTextContent(/535|password/i)
  })

  it('says an expired one expired, and a cancelled one was stopped on purpose', () => {
    setup({ settings: notificationSettings({ latest: testEmail('expired') }) })
    expect(latest()).toHaveTextContent(/no notifier took it in time/)
  })

  it('says a cancelled one was stopped on purpose, with the reason', () => {
    setup({
      settings: notificationSettings({
        latest: testEmail('cancelled', {
          failure: { category: 'not_permitted', label: 'The account may no longer send it' },
        }),
      }),
    })
    expect(latest()).toHaveTextContent('Not sent, on purpose: The account may no longer send it.')
  })

  it('offers another once the last one is final', () => {
    setup({ settings: notificationSettings({ latest: testEmail('sent') }) })
    expect(send()).toBeEnabled()
  })
})

describe('what the server refuses', () => {
  it('says to wait the minute the server asks for, counts it down, and offers the action again after it', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(
      new ApiError('One test email a minute.', 429, 'rate_limited', { retryAfterSeconds: 42 }),
    )
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One test email a minute: try again in 42 s.',
    )
    expect(send()).toBeDisabled()
    expect(screen.getByText('try again in 42 s')).toBeInTheDocument()
    expect(served.onRefresh).not.toHaveBeenCalled()

    await tick(10_000)
    expect(screen.getByText('try again in 32 s')).toBeInTheDocument()
    expect(send()).toBeDisabled()

    await tick(32_000)
    expect(screen.queryByText(/try again in/)).not.toBeInTheDocument()
    expect(send()).toBeEnabled()
    expect(served.requestTestEmail).toHaveBeenCalledTimes(1)
  })

  it('waits a minute when the server did not say how long', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(new ApiError('One a minute.', 429, 'rate_limited'))
    await click(send())
    expect(screen.getByText('try again in 60 s')).toBeInTheDocument()
  })

  it.each([
    ['email_disabled', /sends no email: no mail server is set/],
    ['no_email_address', /no email address/],
    ['test_email_pending', /still waiting to be sent/],
  ] as const)('says a 409 %s in words, and reads the page again', async (code, words) => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(new ApiError('Conflict.', 409, code))
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent(words)
    expect(served.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('says a 403 is not permitted, and reads the page again', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(new ApiError('Forbidden.', 403, 'forbidden'))
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent('You may not send test emails.')
    expect(served.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('says it is not known whether one was queued when the server could not be reached', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(
      new ApiError('Cannot reach the server.', null, 'network'),
    )
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent(/not known whether a test email was queued/)
    expect(send()).toBeEnabled()
  })

  it('says another failure with the server’s own sentence, and nothing of an error that is not an answer', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValueOnce(
      new ApiError('Mail queue is full.', 500, 'internal'),
    )
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The test email could not be requested: Mail queue is full.',
    )
    served.requestTestEmail.mockRejectedValueOnce(new TypeError('boom at /srv/app/x.js'))
    await click(send())
    expect(screen.getByRole('alert')).toHaveTextContent('The test email could not be requested.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('boom')
  })

  it('lets the notice be dismissed', async () => {
    const served = setup()
    served.requestTestEmail.mockRejectedValue(new ApiError('Forbidden.', 403, 'forbidden'))
    await click(send())
    await click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

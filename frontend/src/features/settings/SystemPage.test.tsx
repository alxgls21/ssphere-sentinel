import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { SystemStatus } from '@/api/types'
import { createFakeAuth, createTestApi, renderApp } from '@/test/render'
import SystemPage from './SystemPage'
import { can, iso, notifier, outbox, systemStatus } from './testing'

function setup(
  served: SystemStatus | Error = systemStatus(),
  capabilities = can('viewSystemStatus'),
  pollMs?: number,
) {
  const getSystemStatus = vi.fn<SentinelApi['getSystemStatus']>(async () => {
    if (served instanceof Error) throw served
    return served
  })
  const api = createTestApi({ source: 'http', getSystemStatus })
  renderApp(<SystemPage />, { api, auth: createFakeAuth({ capabilities }), pollMs })
  return { getSystemStatus }
}

const notifierBanner = () => screen.findByRole('region', { name: 'Notifier' })
const engineBanner = () => screen.findByRole('region', { name: 'Alert engine' })

describe('who may see it', () => {
  it('says so, and asks the server for nothing, to an account without the permission', () => {
    const { getSystemStatus } = setup(
      systemStatus(),
      can('viewAlertRules', 'manageOwnNotifications'),
    )
    expect(screen.getByText('Not permitted to see the system status')).toBeInTheDocument()
    expect(getSystemStatus).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Notifier' })).not.toBeInTheDocument()
  })

  it('shows no global figure at all to such an account: no outbox, no deployment, no retention', () => {
    setup(systemStatus(), can())
    for (const word of ['outbox', 'Retention', 'smtp.example.com', 'Monitoring limits']) {
      expect(screen.queryByText(new RegExp(word, 'i'))).not.toBeInTheDocument()
    }
  })

  it('says a refused read is not permitted, with no Retry', async () => {
    setup(new ApiError('Forbidden.', 403, 'forbidden'))
    expect(await screen.findByText('Not permitted to see the system status')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})

describe('reading the status', () => {
  it('shows the engine, the notifier, the outbox and what the deployment sets', async () => {
    setup()
    expect(await engineBanner()).toHaveAttribute('data-state', 'running')
    expect(await notifierBanner()).toHaveAttribute('data-state', 'running')
    expect(screen.getByRole('region', { name: 'Notification outbox' })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Email, as the deployment sets it' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Retention' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Monitoring limits' })).toBeInTheDocument()
  })

  it('says a failed read, with Retry that reads again', async () => {
    const { getSystemStatus } = setup(
      new ApiError('The server is unavailable.', 503, 'unavailable'),
    )
    expect(await screen.findByText('The system status could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('The server is unavailable.')
    getSystemStatus.mockResolvedValueOnce(systemStatus())
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await notifierBanner()).toBeInTheDocument()
    expect(getSystemStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer under a banner when a refresh fails', async () => {
    const { getSystemStatus } = setup(systemStatus(), can('viewSystemStatus'), 40)
    await notifierBanner()
    getSystemStatus.mockRejectedValue(new ApiError('Gateway timeout.', 504, 'unavailable'))
    await waitFor(() =>
      expect(screen.getAllByText(/Refresh failed: Gateway timeout\./).length).toBeGreaterThan(0),
    )
    expect(screen.getByRole('region', { name: 'Notifier' })).toHaveAttribute(
      'data-state',
      'running',
    )
    expect(screen.getByRole('region', { name: 'Notification outbox' })).toBeInTheDocument()
  })
})

describe('the notifier’s state', () => {
  const tagOf = (banner: HTMLElement) => banner.querySelector('[data-status]')

  it('is drawn healthy only when it is running', async () => {
    setup(systemStatus({ notifier: notifier({ state: 'running' }) }))
    const banner = await notifierBanner()
    expect(tagOf(banner)).toHaveAttribute('data-status', 'healthy')
    expect(banner).toHaveTextContent('RUNNING')
    expect(banner).toHaveTextContent(/its latest cycle succeeded 20s ago/)
  })

  it('never draws a disabled notifier as healthy: it is idle, and says it is none', async () => {
    setup(
      systemStatus({
        notifier: notifier({
          state: 'disabled',
          intervalSeconds: null,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastActiveAt: null,
          lastCycleMs: null,
          smtpConfigured: null,
          authenticationConfigured: null,
        }),
      }),
    )
    const banner = await notifierBanner()
    expect(banner).toHaveAttribute('data-state', 'disabled')
    expect(tagOf(banner)).toHaveAttribute('data-status', 'idle')
    expect(banner).toHaveTextContent('DISABLED')
    expect(banner).not.toHaveTextContent('RUNNING')
    expect(banner).toHaveTextContent(/not a healthy notifier/)
    expect(banner).not.toHaveTextContent(/mail server (set|not set)/)
  })

  it('never draws a notifier that never started as healthy, and says queued email waits', async () => {
    setup(
      systemStatus({
        notifier: notifier({
          state: 'never_started',
          intervalSeconds: null,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastActiveAt: null,
          lastCycleMs: null,
          smtpConfigured: null,
          authenticationConfigured: null,
        }),
      }),
    )
    const banner = await notifierBanner()
    expect(banner).toHaveAttribute('data-state', 'never_started')
    expect(tagOf(banner)).toHaveAttribute('data-status', 'unknown')
    expect(banner).toHaveTextContent('NEVER STARTED')
    expect(banner).toHaveTextContent(/never completed a cycle/)
    expect(banner).toHaveTextContent('mail server not reported yet')
  })

  it('draws a stale notifier as a warning, with how long it has been silent', async () => {
    setup(
      systemStatus({
        notifier: notifier({ state: 'stale', stale: true, lastActiveAt: iso(1800) }),
      }),
    )
    const banner = await notifierBanner()
    expect(tagOf(banner)).toHaveAttribute('data-status', 'warning')
    expect(banner).toHaveTextContent('STALE')
    expect(banner).toHaveTextContent(/stopped or is stuck/)
    expect(banner).toHaveTextContent('last sign of life 30m ago')
  })

  it('draws a failed notifier as critical, with the mail server failure by category and no message', async () => {
    setup(
      systemStatus({
        notifier: notifier({
          state: 'failed',
          lastSmtpError: { at: iso(120), category: 'authentication' },
        }),
      }),
    )
    const banner = await notifierBanner()
    expect(tagOf(banner)).toHaveAttribute('data-status', 'critical')
    expect(banner).toHaveTextContent('FAILED')
    expect(banner).toHaveTextContent('Last mail server failure')
    expect(banner).toHaveTextContent('logging in to the mail server failed')
  })

  it('says what the notifier reported of its mail settings, as reported', async () => {
    setup(
      systemStatus({
        notifier: notifier({ smtpConfigured: true, authenticationConfigured: false }),
      }),
    )
    const banner = await notifierBanner()
    expect(banner).toHaveTextContent('mail server set')
    expect(banner).toHaveTextContent('login not configured')
    expect(banner).toHaveTextContent('last reached 5m ago')
    expect(banner).toHaveTextContent('(as the notifier reported)')
  })

  it('says the five states apart by word', async () => {
    const words: Record<string, string> = {
      running: 'RUNNING',
      failed: 'FAILED',
      stale: 'STALE',
      never_started: 'NEVER STARTED',
      disabled: 'DISABLED',
    }
    for (const [state, word] of Object.entries(words)) {
      const { unmount } = renderApp(<SystemPage />, {
        api: createTestApi({
          source: 'http',
          getSystemStatus: async () =>
            systemStatus({ notifier: notifier({ state: state as never }) }),
        }),
        auth: createFakeAuth({ capabilities: can('viewSystemStatus') }),
      })
      expect(await notifierBanner()).toHaveTextContent(word)
      unmount()
    }
  })
})

describe('the outbox', () => {
  it('counts what waits, what is being sent and the oldest, and the last day', async () => {
    setup(
      systemStatus({
        outbox: outbox({
          pending: 7,
          sending: 2,
          oldestPendingAt: iso(600),
          last24Hours: {
            created: 30,
            sent: 25,
            failed: 3,
            cancelled: 2,
            failures: { timeout: 2, recipient_unavailable: 1 },
          },
        }),
      }),
    )
    const panel = await screen.findByRole('region', { name: 'Notification outbox' })
    expect(within(panel).getByText('Waiting to send').nextSibling).toHaveTextContent('7')
    expect(within(panel).getByText('Being sent').nextSibling).toHaveTextContent('2')
    expect(within(panel).getByText('Oldest waiting').nextSibling).toHaveTextContent('10m old')
    const day = within(panel).getByRole('region', { name: 'Last 24 hours' })
    expect(within(day).getByText('Created').nextSibling).toHaveTextContent('30')
    expect(within(day).getByText('Sent').nextSibling).toHaveTextContent('25')
    expect(within(day).getByRole('list', { name: 'Why emails did not go' })).toHaveTextContent(
      '2 mail server timed out',
    )
    expect(day).toHaveTextContent('1 recipient unavailable')
  })

  it('says nothing is waiting, and that no email failed, when so', async () => {
    setup(
      systemStatus({
        outbox: outbox({
          pending: 0,
          oldestPendingAt: null,
          last24Hours: { created: 3, sent: 3, failed: 0, cancelled: 0, failures: {} },
        }),
      }),
    )
    const panel = await screen.findByRole('region', { name: 'Notification outbox' })
    expect(within(panel).getByText('Oldest waiting').nextSibling).toHaveTextContent('none waiting')
    expect(panel).toHaveTextContent('No email failed or was cancelled in the last day.')
  })

  it('says overdue emails are late, and will be dropped rather than sent late', async () => {
    setup(systemStatus({ outbox: outbox({ overdue: 3 }) }))
    const panel = await screen.findByRole('region', { name: 'Notification outbox' })
    expect(within(panel).getByText('LATE')).toBeInTheDocument()
    expect(panel).toHaveTextContent(/3 emails have waited longer than the 24 hours an email may/)
    expect(panel).toHaveTextContent(/dropped, not sent late/)
  })

  it('does not call a single overdue email plural', async () => {
    setup(systemStatus({ outbox: outbox({ overdue: 1 }) }))
    expect(await screen.findByText(/1 email has waited/)).toBeInTheDocument()
  })

  it('says the test emails: how many are open, and the last day by status', async () => {
    setup(
      systemStatus({
        outbox: outbox({
          testEmails: {
            open: 1,
            last24Hours: { pending: 0, sending: 0, sent: 4, failed: 1, cancelled: 0, expired: 0 },
          },
        }),
      }),
    )
    const tests = await screen.findByRole('region', { name: 'Test emails' })
    expect(tests).toHaveTextContent('1 open; last 24 hours: 4 sent, 1 failed')
  })
})

describe('what the deployment sets', () => {
  it('shows the mail server, port, connection, from address, timeout, longest wait and the console address', async () => {
    setup()
    const panel = await screen.findByRole('region', { name: 'Email, as the deployment sets it' })
    const value = (label: string) => within(panel).getByText(label).nextSibling
    expect(value('Email')).toHaveTextContent('ON')
    expect(value('Mail server')).toHaveTextContent('smtp.example.com')
    expect(value('Port')).toHaveTextContent('587')
    expect(value('Connection')).toHaveTextContent('STARTTLS')
    expect(value('From address')).toHaveTextContent('sentinel@example.com')
    expect(value('Timeout')).toHaveTextContent('10s')
    expect(value('Longest an email waits')).toHaveTextContent('24 h')
    expect(value('Console address in emails')).toHaveTextContent('https://sentinel.example.com')
  })

  it('says email is off, and no mail server is set, when the deployment sets none', async () => {
    const status = systemStatus()
    setup({
      ...status,
      environment: {
        ...status.environment,
        email: {
          ...status.environment.email,
          enabled: false,
          host: null,
          fromAddress: null,
          consoleUrl: null,
          security: 'none',
        },
      },
    })
    const panel = await screen.findByRole('region', { name: 'Email, as the deployment sets it' })
    expect(panel).toHaveTextContent('OFF: NO MAIL SERVER')
    expect(panel).toHaveTextContent('none (unencrypted)')
    expect(within(panel).getByText('Mail server').nextSibling).toHaveTextContent('not set')
    expect(within(panel).queryByText('ON')).not.toBeInTheDocument()
  })

  it('shows how long each kind of record is kept', async () => {
    setup()
    const panel = await screen.findByRole('region', { name: 'Retention' })
    const value = (label: string) => within(panel).getByText(label).nextSibling
    expect(value('Incidents')).toHaveTextContent('365 days')
    expect(value('Notifications')).toHaveTextContent('90 days')
    expect(value('Absent containers')).toHaveTextContent('14 days')
  })

  it('shows the limits the server judges health by', async () => {
    setup()
    const panel = await screen.findByRole('region', { name: 'Monitoring limits' })
    expect(within(panel).getByText('Server offline after').nextSibling).toHaveTextContent('3m 0s')
    expect(within(panel).getByText('Resource critical at').nextSibling).toHaveTextContent('95%')
    expect(within(panel).getByText('Probe latency warning at').nextSibling).toHaveTextContent(
      '150 ms',
    )
  })

  it('shows and asks for no secret: no password, user name or key anywhere', async () => {
    setup()
    await notifierBanner()
    expect(document.body.textContent).not.toMatch(/secret|api key|token|smtp user/i)
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

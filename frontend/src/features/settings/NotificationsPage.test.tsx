import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import type { NotificationSettings } from '@/api/types'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import NotificationsPage from './NotificationsPage'
import { can, iso, notificationSettings, testEmail } from './testing'

const shell = createFakeShell()
beforeEach(() => {
  vi.mocked(shell.announce).mockClear()
})

function setup(
  settings: NotificationSettings | Error = notificationSettings(),
  capabilities = can('manageOwnNotifications', 'sendTestEmail'),
) {
  const getNotificationSettings = vi.fn<SentinelApi['getNotificationSettings']>(async () => {
    if (settings instanceof Error) throw settings
    return settings
  })
  const saveNotificationPreferences = vi.fn<SentinelApi['saveNotificationPreferences']>(
    async (input) => ({
      ...notificationSettings({ ...input, updatedAt: iso(0) }),
    }),
  )
  const requestTestEmail = vi.fn<SentinelApi['requestTestEmail']>()
  const getTestEmail = vi.fn<SentinelApi['getTestEmail']>()
  const api = createTestApi({
    source: 'http',
    getNotificationSettings,
    saveNotificationPreferences,
    requestTestEmail,
    getTestEmail,
  })
  renderApp(<NotificationsPage />, {
    api,
    withShell: shell,
    auth: createFakeAuth({ capabilities }),
  })
  return {
    api,
    getNotificationSettings,
    saveNotificationPreferences,
    requestTestEmail,
    getTestEmail,
  }
}

const enabledBox = () => screen.getByRole('checkbox', { name: 'Email me about incidents' })
const recoveryBox = () =>
  screen.getByRole('checkbox', { name: 'Email me when an incident recovers' })
const severity = (name: RegExp) => screen.getByRole('radio', { name })
const saveButton = () => screen.getByRole('button', { name: 'Save preferences' })
const loaded = () => screen.findByRole('checkbox', { name: 'Email me about incidents' })

describe('who may see it', () => {
  it('says so, and asks the server for nothing, when the account may not manage its own notifications', () => {
    const served = setup(notificationSettings(), can('viewAlertRules'))
    expect(screen.getByText('Notifications are not available to this account')).toBeInTheDocument()
    expect(served.getNotificationSettings).not.toHaveBeenCalled()
  })

  it('asks nothing in the sample fleet, where no capability is offered', () => {
    const served = setup(notificationSettings(), can())
    expect(served.getNotificationSettings).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('reading the preferences', () => {
  it('shows the account’s own address read-only, the choices and when they were saved', async () => {
    setup(
      notificationSettings({
        enabled: true,
        minSeverity: 'warning',
        sendRecovery: true,
        updatedAt: '2026-10-17T08:00:00Z',
      }),
    )
    expect(await loaded()).toBeChecked()
    expect(recoveryBox()).toBeChecked()
    expect(severity(/^Warning and critical/)).toBeChecked()
    expect(severity(/^Critical only/)).not.toBeChecked()
    const address = screen.getByLabelText('Account email')
    expect(address).toHaveValue('maria@example.com')
    expect(address).toHaveAttribute('readonly')
    expect(screen.getByText(/^Saved \d/)).toBeInTheDocument()
  })

  it('shows the defaults of an account that never saved, and says so', async () => {
    setup()
    expect(await loaded()).not.toBeChecked()
    expect(recoveryBox()).not.toBeChecked()
    expect(severity(/^Critical only/)).toBeChecked()
    expect(screen.getByText('Not saved yet: these are the defaults.')).toBeInTheDocument()
  })

  it('says the server sends no email, and lets the preferences be kept', async () => {
    setup(notificationSettings({ available: false }))
    expect(await loaded()).toBeEnabled()
    expect(screen.getByText('NO EMAIL HERE')).toBeInTheDocument()
    expect(
      screen.getByText(/This server sends no email: no mail server is set\./),
    ).toBeInTheDocument()
  })

  it('says an account with no address cannot switch emails on, and does not offer it', async () => {
    setup(notificationSettings({ email: null }))
    expect(await loaded()).toBeDisabled()
    expect(screen.getByText('NO ADDRESS')).toBeInTheDocument()
    expect(screen.getByLabelText('Account email')).toHaveValue('')
  })

  it('still lets an account with no address switch emails off', async () => {
    setup(notificationSettings({ email: null, enabled: true }))
    expect(await loaded()).toBeEnabled()
  })

  it('says a failed read, with Retry that reads again', async () => {
    const served = setup(new ApiError('The database is down.', 503, 'unavailable'))
    expect(await screen.findByRole('alert')).toHaveTextContent('The database is down.')
    served.getNotificationSettings.mockResolvedValueOnce(notificationSettings())
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await loaded()).toBeInTheDocument()
    expect(served.getNotificationSettings).toHaveBeenCalledTimes(2)
  })

  it('says a refused read is not permitted, with no Retry', async () => {
    setup(new ApiError('Forbidden.', 403, 'forbidden'))
    expect(await screen.findByText('Not permitted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('saving the preferences', () => {
  it('offers Save only once something changed, and Discard puts it back', async () => {
    const user = userEvent.setup()
    setup()
    await loaded()
    expect(saveButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
    await user.click(severity(/^Warning and critical/))
    expect(saveButton()).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(severity(/^Critical only/)).toBeChecked()
    expect(saveButton()).toBeDisabled()
  })

  it('sends exactly the three preferences, then shows what the server kept', async () => {
    const user = userEvent.setup()
    const served = setup()
    await loaded()
    await user.click(enabledBox())
    await user.click(severity(/^Warning and critical/))
    await user.click(recoveryBox())
    await user.click(saveButton())
    await waitFor(() =>
      expect(served.saveNotificationPreferences).toHaveBeenCalledWith({
        enabled: true,
        minSeverity: 'warning',
        sendRecovery: true,
      }),
    )
    expect(await screen.findByText('Your preferences are saved.')).toBeInTheDocument()
    expect(screen.getByText('SAVED')).toBeInTheDocument()
    expect(shell.announce).toHaveBeenCalledWith('Notification preferences saved.')
    expect(screen.getByText(/^Saved \d/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(enabledBox()).toBeChecked()
  })

  it('takes the server’s answer for the preferences, not its own idea of them', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.saveNotificationPreferences.mockResolvedValueOnce(
      notificationSettings({
        enabled: true,
        minSeverity: 'critical',
        sendRecovery: false,
        updatedAt: iso(0),
      }),
    )
    await loaded()
    await user.click(enabledBox())
    await user.click(recoveryBox())
    await user.click(saveButton())
    await screen.findByText('Your preferences are saved.')
    expect(recoveryBox()).not.toBeChecked()
  })

  it('goes back to Save when a saved form is changed again, and drops the saved notice', async () => {
    const user = userEvent.setup()
    setup()
    await loaded()
    await user.click(enabledBox())
    await user.click(saveButton())
    await screen.findByText('Your preferences are saved.')
    await user.click(recoveryBox())
    expect(screen.queryByText('Your preferences are saved.')).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it('says what the server finds wrong with a field, under that field, and keeps the form as it was', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.saveNotificationPreferences.mockRejectedValueOnce(
      new ApiError('Invalid request.', 400, 'validation_error', {
        fields: { minSeverity: ['Expected one of critical, warning.'] },
      }),
    )
    await loaded()
    await user.click(severity(/^Warning and critical/))
    await user.click(saveButton())
    const group = await screen.findByRole('group', { name: 'Minimum severity' })
    expect(within(group).getByText('Expected one of critical, warning.')).toBeInTheDocument()
    expect(severity(/^Warning and critical/)).toBeChecked()
    expect(saveButton()).toBeEnabled()
    expect(shell.announce).toHaveBeenCalledWith('Notification preferences were not saved.')
  })

  it('lists a problem of the whole form on top, as it came', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.saveNotificationPreferences.mockRejectedValueOnce(
      new ApiError('Invalid request.', 400, 'validation_error', {
        fields: { nonField: ['Preferences need console access.'] },
      }),
    )
    await loaded()
    await user.click(enabledBox())
    await user.click(saveButton())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('NOT SAVED')
    expect(alert).toHaveTextContent('Preferences need console access.')
  })

  it('says under the switch that emails need an address, when the server refuses with no_email_address', async () => {
    const user = userEvent.setup()
    const served = setup()
    served.saveNotificationPreferences.mockRejectedValueOnce(
      new ApiError('This account has no email address.', 409, 'no_email_address'),
    )
    await loaded()
    await user.click(enabledBox())
    await user.click(saveButton())
    await waitFor(() => expect(enabledBox()).toHaveAccessibleDescription(/no email address/))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a refused change is refused, and a lost connection is not known to have saved', async () => {
    const user = userEvent.setup()
    const served = setup()
    await loaded()
    served.saveNotificationPreferences.mockRejectedValueOnce(
      new ApiError('Forbidden.', 403, 'forbidden'),
    )
    await user.click(enabledBox())
    await user.click(saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account may not make this change.',
    )

    served.saveNotificationPreferences.mockRejectedValueOnce(
      new ApiError('Cannot reach the server.', null, 'network'),
    )
    await user.click(saveButton())
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Nothing is known to have changed/),
    )
  })

  it('shows the form busy and sends once while a save is in flight', async () => {
    const user = userEvent.setup()
    const served = setup()
    let finish: (settings: NotificationSettings) => void = () => {}
    served.saveNotificationPreferences.mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    )
    await loaded()
    await user.click(enabledBox())
    await user.click(saveButton())
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(enabledBox()).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(served.saveNotificationPreferences).toHaveBeenCalledTimes(1)
    finish(notificationSettings({ enabled: true, updatedAt: iso(0) }))
    await screen.findByText('Your preferences are saved.')
  })
})

describe('the test email panel in the page', () => {
  it('is offered with the preferences, and says what the latest test email did', async () => {
    setup(
      notificationSettings({
        latest: testEmail('sent'),
      }),
    )
    await loaded()
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled()
    const latest = screen.getByRole('region', { name: 'Latest test email' })
    expect(within(latest).getByText('SENT')).toBeInTheDocument()
  })

  it('never asks for or shows a mail server’s credentials', async () => {
    setup()
    await loaded()
    expect(document.body.textContent).not.toMatch(/password|smtp user|username/i)
    expect(screen.queryByLabelText(/password|smtp/i)).not.toBeInTheDocument()
  })
})

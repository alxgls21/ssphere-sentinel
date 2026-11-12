import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SentinelApi } from '@/api/client'
import { ApiError } from '@/api/errors'
import { createFakeAuth, createFakeShell, createTestApi, renderApp } from '@/test/render'
import AccountPage from './AccountPage'
import { can } from './testing'

const shell = createFakeShell()

function setup(
  changeOwnPassword = vi.fn<SentinelApi['changeOwnPassword']>(async () => ({
    generatedAt: '2026-10-18T10:00:00.000Z',
    changedAt: '2026-10-18T10:00:00.000Z',
  })),
  capabilities = can('manageOwnAccount'),
) {
  const api = createTestApi({ source: 'http', changeOwnPassword })
  renderApp(<AccountPage />, {
    api,
    withShell: shell,
    auth: createFakeAuth({ capabilities, user: { username: 'maria', displayName: 'Maria' } }),
  })
  return { changeOwnPassword }
}

const field = (label: string) => screen.getByLabelText(label)
const submit = () => screen.getByRole('button', { name: 'Change password' })

describe('Account', () => {
  it('is offered only to a real account', () => {
    setup(undefined, can('manageOwnNotifications'))
    expect(screen.getByText('Not permitted to change the password here')).toBeInTheDocument()
  })

  it('changes the password with the current one, and says the other sessions ended', async () => {
    const user = userEvent.setup()
    const { changeOwnPassword } = setup()
    expect(screen.getByText('maria')).toBeInTheDocument()
    await user.type(field('Current password'), 'old-passphrase')
    await user.type(field('New password'), 'a-long-passphrase')
    await user.type(field('Repeat the new password'), 'a-long-passphrase')
    await user.click(submit())
    await waitFor(() =>
      expect(changeOwnPassword).toHaveBeenCalledWith({
        currentPassword: 'old-passphrase',
        newPassword: 'a-long-passphrase',
      }),
    )
    expect(await screen.findByText(/Your password is changed/)).toBeInTheDocument()
    expect(field('Current password')).toHaveValue('')
    expect(shell.announce).toHaveBeenCalledWith('Password changed. Your other sessions have ended.')
  })

  it('refuses two new passwords that differ, and a missing current one, here', async () => {
    const user = userEvent.setup()
    const { changeOwnPassword } = setup()
    await user.type(field('New password'), 'a-long-passphrase')
    await user.type(field('Repeat the new password'), 'b-long-passphrase')
    await user.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent('currentPassword, confirm')
    expect(changeOwnPassword).not.toHaveBeenCalled()
  })

  it('shows a wrong current password under its field, as the server says it', async () => {
    const user = userEvent.setup()
    setup(
      vi.fn(async () => {
        throw new ApiError('Some values are not valid.', 400, 'validation_error', {
          fields: { currentPassword: ['The current password is not right.'] },
        })
      }),
    )
    await user.type(field('Current password'), 'wrong')
    await user.type(field('New password'), 'a-long-passphrase')
    await user.type(field('Repeat the new password'), 'a-long-passphrase')
    await user.click(submit())
    expect(await screen.findByText('The current password is not right.')).toBeInTheDocument()
  })

  it('says the account is locked after too many wrong passwords', async () => {
    const user = userEvent.setup()
    setup(
      vi.fn(async () => {
        throw new ApiError('Too many wrong passwords.', 429, 'too_many_attempts', {
          retryAfterSeconds: 600,
        })
      }),
    )
    await user.type(field('Current password'), 'wrong')
    await user.type(field('New password'), 'a-long-passphrase')
    await user.type(field('Repeat the new password'), 'a-long-passphrase')
    await user.click(submit())
    expect(await screen.findByText('LOCKED')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/locked for a while/)
  })
})

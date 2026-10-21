import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { AuthApi } from '@/app/auth/auth'
import { createFakeAuth, renderApp } from '@/test/render'
import SetupPage from './SetupPage'

function Where() {
  const { pathname } = useLocation()
  return <span data-testid="where">{pathname}</span>
}

function renderSetup(auth: Partial<AuthApi> = {}) {
  const fake = createFakeAuth({
    status: 'anonymous',
    checkSetup: vi.fn(async () => true),
    ...auth,
  })
  renderApp(
    <>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<p>sign-in page</p>} />
        <Route path="/" element={<p>the console</p>} />
      </Routes>
      <Where />
    </>,
    { route: '/setup', auth: fake },
  )
  return fake
}

const form = () => screen.findByLabelText('Setup code')
const where = () => screen.getByTestId('where').textContent

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  over: Partial<Record<'code' | 'username' | 'email' | 'password' | 'confirm', string>> = {},
) {
  const values = {
    code: 'K7QX-M2P9-A4TR',
    username: 'root',
    email: '',
    password: 'a-long-passphrase',
    confirm: 'a-long-passphrase',
    ...over,
  }
  await user.type(await form(), values.code)
  await user.type(screen.getByLabelText('User name'), values.username)
  if (values.email) await user.type(screen.getByLabelText('Email (optional)'), values.email)
  await user.type(screen.getByLabelText('Password'), values.password)
  await user.type(screen.getByLabelText('Confirm password'), values.confirm)
}
const submit = () => screen.getByRole('button', { name: /^Create administrator|Creating/ })

describe('SetupPage', () => {
  it('asks once, and shows a labelled form with where the code is', async () => {
    const auth = renderSetup()
    expect(await form()).toBeVisible()
    expect(auth.checkSetup).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Create the first administrator' }),
    ).toBeVisible()
    expect(screen.getByText('docker compose logs web | grep setup:')).toBeVisible()
    for (const label of [
      'Setup code',
      'User name',
      'Email (optional)',
      'Password',
      'Confirm password',
    ]) {
      expect(screen.getByLabelText(label), label).toBeInTheDocument()
    }
  })

  it('gives each field the right autofill hints, and never remembers the code', async () => {
    renderSetup()
    expect(await form()).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByLabelText('User name')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Email (optional)')).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password')
  })

  it('offers Create only once the code, user name and both passwords are filled', async () => {
    const user = userEvent.setup()
    renderSetup()
    await form()
    expect(submit()).toBeDisabled()
    await fill(user)
    expect(submit()).toBeEnabled()
  })

  it('goes to the sign-in page when no setup is pending', async () => {
    renderSetup({ checkSetup: vi.fn(async () => false) })
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
    expect(where()).toBe('/login')
  })

  it('goes to the sign-in page when the check fails: the server refuses a setup that is not pending anyway', async () => {
    renderSetup({ checkSetup: vi.fn(async () => Promise.reject(new ApiError('x', 503))) })
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
  })

  it('goes to the console for someone already signed in, and asks nothing', () => {
    const auth = renderSetup({ status: 'authenticated' })
    expect(screen.getByText('the console')).toBeInTheDocument()
    expect(auth.checkSetup).not.toHaveBeenCalled()
  })

  it('does not ask or show the form while the session is not known', () => {
    const auth = renderSetup({ status: 'checking' })
    expect(screen.queryByLabelText('Setup code')).not.toBeInTheDocument()
    expect(auth.checkSetup).not.toHaveBeenCalled()
  })

  it('says the passwords differ, and sends nothing', async () => {
    const user = userEvent.setup()
    const auth = renderSetup()
    await fill(user, { confirm: 'something-else' })
    await user.click(submit())
    expect(screen.getByLabelText('Confirm password')).toHaveAccessibleDescription(
      /The two passwords are not the same\./,
    )
    expect(auth.completeSetup).not.toHaveBeenCalled()
  })

  it('creates the administrator with what was typed, and the code as pasted', async () => {
    const user = userEvent.setup()
    const auth = renderSetup()
    await fill(user, { code: 'k7qx m2p9 a4tr', email: 'root@example.com' })
    await user.click(submit())
    await waitFor(() =>
      expect(auth.completeSetup).toHaveBeenCalledWith({
        code: 'k7qx m2p9 a4tr',
        username: 'root',
        email: 'root@example.com',
        password: 'a-long-passphrase',
      }),
    )
  })

  it('creates with the Enter key from a field: it is a form', async () => {
    const user = userEvent.setup()
    const auth = renderSetup()
    await fill(user)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(auth.completeSetup).toHaveBeenCalledTimes(1))
  })

  it('shows the form busy and sends once while the server works', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    const auth = renderSetup({
      completeSetup: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    })
    await fill(user)
    await user.click(submit())
    expect(screen.getByRole('button', { name: 'Creating' })).toBeDisabled()
    expect(screen.getByLabelText('Setup code')).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(auth.completeSetup).toHaveBeenCalledTimes(1)
    finish()
  })

  it('says a wrong code under the code field, with the server’s words, and keeps what was typed', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError(
          'The setup code is not valid. The server’s log has the current one.',
          400,
          'invalid_code',
        )
      }),
    })
    await fill(user)
    await user.click(submit())
    await waitFor(() =>
      expect(screen.getByLabelText('Setup code')).toHaveAccessibleDescription(
        /The setup code is not valid\./,
      ),
    )
    expect(screen.getByLabelText('Setup code')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('User name')).toHaveValue('root')
    expect(screen.getByLabelText('Password')).toHaveValue('a-long-passphrase')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says what is wrong with each field, the password rules included', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError('Invalid request.', 400, 'validation_error', {
          fields: {
            username: ['A user with that username already exists.'],
            email: ['Enter a valid email address.'],
            password: ['This password is too short.', 'This password is too common.'],
          },
        })
      }),
    })
    await fill(user, { email: 'nope' })
    await user.click(submit())
    await waitFor(() =>
      expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
        /too short.*too common/s,
      ),
    )
    expect(screen.getByLabelText('User name')).toHaveAccessibleDescription(/already exists/)
    expect(screen.getByLabelText('Email (optional)')).toHaveAccessibleDescription(/valid email/)
    expect(screen.getByLabelText('Setup code')).not.toHaveAttribute('aria-invalid')
  })

  it('says too many wrong codes in the server’s words', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError(
          'Too many wrong setup codes. Wait a while, then try again.',
          429,
          'too_many_attempts',
        )
      }),
    })
    await fill(user)
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many wrong setup codes.')
  })

  it('says a malformed request plainly', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError('code, username and password are required.', 400, 'invalid_request')
      }),
    })
    await fill(user)
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent(/Fill in the setup code/)
  })

  it('says it could not be reached, without the internals', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError('Cannot reach the server.', null, 'network')
      }),
    })
    await fill(user)
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached/)
  })

  it('goes to the sign-in page when the server finds no setup pending any more', async () => {
    const user = userEvent.setup()
    renderSetup({
      completeSetup: vi.fn(async () => {
        throw new ApiError('Not found.', 404, 'not_found')
      }),
    })
    await fill(user)
    await user.click(submit())
    expect(await screen.findByText('sign-in page')).toBeInTheDocument()
  })
})

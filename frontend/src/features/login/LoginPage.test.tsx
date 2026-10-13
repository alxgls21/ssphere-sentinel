import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import type { AuthApi } from '@/app/auth/auth'
import { createFakeAuth, renderApp } from '@/test/render'
import LoginPage from './LoginPage'
import { describeSignInError } from './signInError'

function Where() {
  const { pathname, search } = useLocation()
  return <span data-testid="location">{pathname + search}</span>
}

function renderLogin(auth: Partial<AuthApi> = {}, route = '/login') {
  const fake = createFakeAuth({ status: 'anonymous', ...auth })
  renderApp(
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<p>somewhere</p>} />
      </Routes>
      <Where />
    </>,
    { route, auth: fake },
  )
  return fake
}

const fill = async (user: ReturnType<typeof userEvent.setup>, name = 'alice', pw = 'secret') => {
  await user.type(screen.getByLabelText('User name'), name)
  await user.type(screen.getByLabelText('Password'), pw)
}

describe('LoginPage', () => {
  it('is a labelled form for a user name and a password, with the right autofill hints', () => {
    renderLogin()
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
    expect(screen.getByLabelText('User name')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByLabelText('User name')).toHaveFocus()
    expect(document.title).toBe('Sign in - Sentinel')
  })

  it('does not offer a sign-in with an empty field', () => {
    renderLogin()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })

  it('signs in with what was typed', async () => {
    const user = userEvent.setup()
    const auth = renderLogin()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(auth.signIn).toHaveBeenCalledWith('alice', 'secret')
  })

  it('submits with Enter', async () => {
    const user = userEvent.setup()
    const auth = renderLogin()
    await fill(user)
    await user.keyboard('{Enter}')
    expect(auth.signIn).toHaveBeenCalledTimes(1)
  })

  it('shows the server’s refusal, clears the password and puts the cursor back in it', async () => {
    const user = userEvent.setup()
    renderLogin({
      signIn: vi.fn(async () => {
        throw new ApiError('Invalid user name or password.', 401, 'invalid_credentials')
      }),
    })
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid user name or password.')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByLabelText('User name')).toHaveValue('alice')
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus())
  })

  it('does not send a second request while the first is in flight', async () => {
    const user = userEvent.setup()
    const never = new Promise<void>(() => {})
    const auth = renderLogin({ signIn: vi.fn(() => never) })
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(auth.signIn).toHaveBeenCalledTimes(1)
  })

  it('explains an ended session', () => {
    renderLogin({}, '/login?reason=expired')
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended')
  })

  it('ignores any other reason', () => {
    renderLogin({}, '/login?reason=<b>hacked</b>')
    expect(screen.queryByRole('status')).toBeNull()
  })

  describe('once signed in', () => {
    it('returns to the page it came from', () => {
      renderLogin({ status: 'authenticated' }, '/login?next=%2Fservers%2Fabc%3Frange%3D6h')
      expect(screen.getByTestId('location')).toHaveTextContent('/servers/abc?range=6h')
    })

    it('goes home when there is nowhere to return to', () => {
      renderLogin({ status: 'authenticated' })
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
    })

    it.each([
      ['an absolute URL', 'https://evil.example/'],
      ['a protocol-relative URL', '//evil.example/'],
      ['a backslash trick', '/\\evil.example'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['the sign-in page itself', '/login'],
    ])('never follows %s', (_name, next) => {
      renderLogin({ status: 'authenticated' }, `/login?next=${encodeURIComponent(next)}`)
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
    })
  })

  it.each(['checking', 'unreachable', 'denied', 'signing-out', 'signout-failed'] as const)(
    'shows the session screen, not the form, while %s',
    (status) => {
      renderLogin({ status, refresh: vi.fn(), error: 'x' })
      expect(screen.queryByLabelText('Password')).toBeNull()
    },
  )
})

describe('describeSignInError', () => {
  it('passes on a refusal as the server worded it', () => {
    expect(
      describeSignInError(new ApiError('Locked for a while.', 401, 'invalid_credentials')),
    ).toBe('Locked for a while.')
  })

  it('tells each kind of failure apart without echoing anything it was sent', () => {
    expect(describeSignInError(new ApiError('x', 400, 'invalid_request'))).toMatch(
      /Enter your user name/,
    )
    expect(describeSignInError(new ApiError('x', null, 'network'))).toMatch(
      /Cannot reach the server/,
    )
    expect(describeSignInError(new ApiError('x', null, 'timeout'))).toMatch(
      /Cannot reach the server/,
    )
    expect(describeSignInError(new ApiError('x', 403, 'csrf_failed'))).toMatch(/Reload the page/)
    expect(describeSignInError(new ApiError('x', 502))).toMatch(/Try again shortly/)
    expect(describeSignInError(new Error('boom'))).toBe('The sign-in failed. Try again.')
  })
})

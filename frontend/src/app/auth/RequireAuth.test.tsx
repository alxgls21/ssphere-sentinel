import { screen } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { createFakeAuth, renderApp } from '@/test/render'
import { RequireAuth } from './RequireAuth'
import type { AuthApi } from './auth'

function Where() {
  const { pathname, search } = useLocation()
  return <output aria-label="location">{pathname + search}</output>
}

function renderGuarded(auth: Partial<AuthApi>, route = '/servers/abc?range=6h') {
  return renderApp(
    <>
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route element={<RequireAuth />}>
          <Route path="/servers/:id" element={<p>protected page</p>} />
        </Route>
      </Routes>
      <Where />
    </>,
    { route, auth: createFakeAuth(auth) },
  )
}

describe('RequireAuth', () => {
  it('lets a signed-in user through', () => {
    renderGuarded({ status: 'authenticated' })
    expect(screen.getByText('protected page')).toBeInTheDocument()
  })

  it('sends an anonymous visitor to the sign-in page, remembering the page and its view', () => {
    renderGuarded({ status: 'anonymous' })
    expect(screen.queryByText('protected page')).toBeNull()
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/login?next=%2Fservers%2Fabc%3Frange%3D6h',
    )
  })

  it('says why when the session ran out', () => {
    renderGuarded({ status: 'expired' })
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/login?next=%2Fservers%2Fabc%3Frange%3D6h&reason=expired',
    )
  })

  it('forgets the page after a deliberate sign-out', () => {
    renderGuarded({ status: 'anonymous', signedOut: true })
    expect(screen.getByLabelText('location')).toHaveTextContent(/^\/login$/)
  })

  it.each(['checking', 'unreachable', 'denied', 'signing-out', 'signout-failed'] as const)(
    'shows nothing of the page while the session is %s',
    (status) => {
      renderGuarded({ status, refresh: vi.fn(), error: 'x' })
      expect(screen.queryByText('protected page')).toBeNull()
      expect(screen.queryByText('login page')).toBeNull()
    },
  )
})

import { Navigate, Outlet, useLocation } from 'react-router'
import { AuthGate } from '@/features/login/AuthGate'
import { useAuth } from './auth'
import { loginPath } from './safeNext'

/**
 * Layout route: everything inside needs a signed-in user. Anyone else is sent
 * to the sign-in page, which brings them back to the page they asked for.
 */
export function RequireAuth() {
  const { status, signedOut } = useAuth()
  const location = useLocation()
  if (status === 'anonymous' || status === 'expired') {
    // After an explicit sign-out nothing of the previous session (not even its page) is carried over.
    const here = signedOut ? '/' : `${location.pathname}${location.search}${location.hash}`
    return <Navigate replace to={loginPath(here, status === 'expired' ? 'expired' : undefined)} />
  }
  if (status !== 'authenticated') return <AuthGate />
  return <Outlet />
}

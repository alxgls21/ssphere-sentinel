import { useAuth } from '@/app/auth/auth'
import { Button } from '@/ui/controls'
import { Skeleton } from '@/ui/states'
import { AuthFrame } from './AuthFrame'

/**
 * What is shown while the session is not known to be good: checking, the
 * server cannot be reached, a sign-out is under way or failed, or the account
 * may not use the console. Nothing
 * of the application renders behind it.
 */
export function AuthGate() {
  const { status, error, refresh, signOut } = useAuth()

  if (status === 'unreachable') {
    return (
      <AuthFrame title="Cannot reach the server">
        <p role="alert" className="type-body text-fg-muted">
          {error ?? 'The console could not check your session.'} Nothing is shown until it can.
        </p>
        <Button variant="primary" onClick={refresh}>
          Try again
        </Button>
      </AuthFrame>
    )
  }

  if (status === 'signout-failed') {
    return (
      <AuthFrame title="Sign-out failed">
        <p role="alert" className="type-body text-fg-muted">
          {error ?? 'The server could not be told.'} You may still be signed in on the server, so
          nothing is shown. Try again, or close this tab.
        </p>
        <Button variant="primary" onClick={() => void signOut()}>
          Try sign-out again
        </Button>
      </AuthFrame>
    )
  }

  if (status === 'signing-out') {
    return (
      <AuthFrame title="Signing out">
        <output className="type-body text-fg-muted">Ending your session.</output>
      </AuthFrame>
    )
  }

  if (status === 'denied') {
    return (
      <AuthFrame title="No console access">
        <p className="type-body text-fg-muted">
          This account is signed in but may not use the console. Ask an administrator to grant it
          access, or sign in with another account.
        </p>
        <Button onClick={() => void signOut()}>Sign out</Button>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title="Checking your session">
      <output className="sr-only">Checking your session</output>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </AuthFrame>
  )
}

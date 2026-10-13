import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useAuth } from '@/app/auth/auth'
import { safeNextPath } from '@/app/auth/safeNext'
import { Button, TextField } from '@/ui/controls'
import { AuthFrame } from './AuthFrame'
import { AuthGate } from './AuthGate'
import { describeSignInError } from './signInError'

/**
 * The sign-in page. It returns to `?next=` afterwards, but only to a path inside
 * this application (see safeNextPath). `?reason=expired` explains why the
 * page appeared.
 */
export default function LoginPage() {
  const { status, signIn } = useAuth()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  const expired = params.get('reason') === 'expired' || status === 'expired'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const userRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const askable = status === 'anonymous' || status === 'expired'
  useEffect(() => {
    if (askable) userRef.current?.focus()
  }, [askable])

  // Back to the password once the form is enabled again (a disabled field cannot take focus).
  useEffect(() => {
    if (error && !busy) passwordRef.current?.focus()
  }, [error, busy])

  useEffect(() => {
    document.title = 'Sign in - Sentinel'
  }, [])

  if (status === 'authenticated') return <Navigate replace to={next} />
  if (!askable) return <AuthGate />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(username, password)
    } catch (failure) {
      setError(describeSignInError(failure))
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <AuthFrame title="Sign in">
      {expired ? (
        <output className="type-body block rounded-sm border border-border-strong bg-raised px-3 py-2">
          Your session ended. Sign in again to continue where you were.
        </output>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <TextField
          ref={userRef}
          label="User name"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={150}
          required
          disabled={busy}
        />
        <TextField
          ref={passwordRef}
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          maxLength={1024}
          required
          disabled={busy}
        />
        {error ? (
          <p role="alert" className="type-body text-fg">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || username === '' || password === ''}
        >
          {busy ? 'Signing in' : 'Sign in'}
        </Button>
      </form>
    </AuthFrame>
  )
}

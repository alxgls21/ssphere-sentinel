import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { ApiError } from '@/api/errors'
import { useAuth } from '@/app/auth/auth'
import { LOGIN_PATH } from '@/app/auth/safeNext'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'
import { Button, FieldInput } from '@/ui/controls'
import { Notice } from '@/ui/states'
import { AuthFrame } from './AuthFrame'
import { AuthGate } from './AuthGate'
import { useSetupRequired } from './useSetupRequired'

const FIELDS = ['code', 'username', 'email', 'password'] as const

/** What the server's refusals mean here: a wrong code belongs to the code field, everything else as a form write. */
function describe(error: unknown): FormFailure {
  const failure = describeWriteFailure(error, FIELDS)
  if (error instanceof ApiError && error.code === 'invalid_code') {
    return { ...failure, fields: { ...failure.fields, code: [error.message] }, message: null }
  }
  if (error instanceof ApiError && error.code === 'too_many_attempts') {
    return { ...failure, message: error.message }
  }
  if (error instanceof ApiError && error.status === 400 && error.code === 'invalid_request') {
    return { ...failure, message: 'Fill in the setup code, a user name and a password.' }
  }
  return failure
}

/**
 * First-run setup: shown instead of the sign-in page while the installation has no user. The setup code
 * is printed in the server's log, so only someone who can read it can create the first administrator.
 * It asks the server once; a setup that is not pending goes to the sign-in page, and a created
 * administrator is signed in at once. Nothing typed is kept anywhere but this form.
 */
export default function SetupPage() {
  const { status, completeSetup } = useAuth()
  const askable = status === 'anonymous' || status === 'expired'
  const required = useSetupRequired(askable)

  const [code, setCode] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [done, setDone] = useState(false)
  const summary = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = 'Set up - Sentinel'
  }, [])

  if (status === 'authenticated') return <Navigate replace to="/" />
  if (!askable) return <AuthGate />
  if (required === null) return <AuthGate />
  if (!required || done) return <Navigate replace to={LOGIN_PATH} />

  const lines = summaryOf(failure)
  const filled = code.trim() !== '' && username.trim() !== '' && password !== '' && confirm !== ''

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !filled) return
    if (password !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    setBusy(true)
    setFailure(null)
    try {
      await completeSetup({ code, username, email, password })
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Nothing is pending any more (an administrator exists now): the sign-in page is the place.
        setDone(true)
        return
      }
      setFailure(describe(error))
      requestAnimationFrame(() => summary.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame title="Create the first administrator">
      <p className="type-body text-fg-muted">
        This installation has no user yet. The setup code is printed in the server’s log:{' '}
        <code className="type-data text-fg">docker compose logs web | grep setup:</code>
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate aria-busy={busy}>
        <div ref={summary} tabIndex={-1} className="outline-none">
          {lines.length > 0 ? (
            <Notice status="critical" word="NOT CREATED" live="alert">
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </Notice>
          ) : null}
        </div>
        <FieldInput
          label="Setup code"
          value={code}
          onChange={setCode}
          error={failure?.fields.code}
          hint="Like K7QX-M2P9-A4TR. Case, spaces and dashes do not matter."
          input={{
            autoComplete: 'off',
            autoCapitalize: 'characters',
            spellCheck: false,
            maxLength: 64,
            required: true,
            disabled: busy,
            autoFocus: true,
          }}
        />
        <FieldInput
          label="User name"
          value={username}
          onChange={setUsername}
          error={failure?.fields.username}
          input={{
            autoComplete: 'username',
            autoCapitalize: 'none',
            spellCheck: false,
            maxLength: 150,
            required: true,
            disabled: busy,
          }}
        />
        <FieldInput
          label="Email (optional)"
          value={email}
          onChange={setEmail}
          error={failure?.fields.email}
          hint="Needed for email notifications; it can be set later."
          input={{
            type: 'email',
            autoComplete: 'email',
            spellCheck: false,
            maxLength: 254,
            disabled: busy,
          }}
        />
        <FieldInput
          label="Password"
          value={password}
          onChange={setPassword}
          error={failure?.fields.password}
          input={{
            type: 'password',
            autoComplete: 'new-password',
            maxLength: 1024,
            required: true,
            disabled: busy,
          }}
        />
        <FieldInput
          label="Confirm password"
          value={confirm}
          onChange={(value) => {
            setConfirm(value)
            setMismatch(false)
          }}
          error={mismatch ? 'The two passwords are not the same.' : undefined}
          input={{
            type: 'password',
            autoComplete: 'new-password',
            maxLength: 1024,
            required: true,
            disabled: busy,
          }}
        />
        <Button type="submit" variant="primary" disabled={busy || !filled} aria-busy={busy}>
          {busy ? 'Creating' : 'Create administrator'}
        </Button>
      </form>
    </AuthFrame>
  )
}

import { useContext, useRef, useState } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import { useAuth } from '@/app/auth/auth'
import { ShellContext } from '@/app/shell'
import { useSaveForm } from '@/hooks/useSaveForm'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, FieldInput } from '@/ui/controls'
import { Notice } from '@/ui/states'
import { NotPermitted } from './AdminParts'
import { MIN_PASSWORD_LENGTH, validatePassword } from './usersModel'

const FIELDS = ['currentPassword', 'newPassword', 'confirm'] as const

/**
 * Settings > Account: the signed-in account's own password. The current one must be right (a
 * wrong one counts as a failed sign-in, and too many lock the account for a while), the new one
 * must pass the installation's rules. This session goes on; every other one ends.
 */
export default function AccountPage() {
  const api = useApi()
  const shell = useContext(ShellContext)
  const { capabilities, user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(FIELDS, shell?.announce, summary)

  if (!capabilities.manageOwnAccount) {
    return (
      <NotPermitted
        what="change the password here"
        hint="The sample fleet has no accounts. Signed in to a real server, every account changes its own password here."
      />
    )
  }

  const locked = form.failure?.code === 'too_many_attempts'
  const lines = locked
    ? [
        `Too many wrong passwords: the account is locked for a while${
          form.failure?.status === 429 && form.failure.message ? '' : ''
        }. Wait, or ask an administrator to unlock it.`,
      ]
    : form.lines

  const submit = () => {
    const found: { currentPassword?: string[]; newPassword?: string[]; confirm?: string[] } = {}
    if (current === '') found.currentPassword = ['Required.']
    const password = validatePassword(next, confirm)
    if (password.password) found.newPassword = password.password
    if (password.confirm) found.confirm = password.confirm
    return form.submit(
      found,
      async () => {
        try {
          const done = await api.changeOwnPassword({ currentPassword: current, newPassword: next })
          setChangedAt(done.changedAt)
          setCurrent('')
          setNext('')
          setConfirm('')
          shell?.announce('Password changed. Your other sessions have ended.')
        } catch (error) {
          // The server names the new password's field `newPassword` as this form does; nothing to map.
          throw error instanceof ApiError ? error : new Error('The password could not be changed.')
        }
      },
      { failed: 'The password was not changed.' },
    )
  }

  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    form.touched()
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="type-title">Account</h2>
        {user ? <p className="type-data text-fg-muted">{user.username}</p> : null}
      </header>
      <Panel title="Password" features="settings" scope="NOW" className="max-w-4xl">
        <form
          className="flex flex-col gap-4"
          noValidate
          aria-busy={form.saving}
          onSubmit={(event) => {
            event.preventDefault()
            if (!form.saving) void submit()
          }}
        >
          <FormNotice
            ref={summary}
            invalid={form.invalid}
            lines={lines}
            word={locked ? 'LOCKED' : 'NOT CHANGED'}
          >
            {changedAt ? (
              <Notice status="healthy" word="CHANGED" live="status">
                Your password is changed. This session goes on; every other session of your account
                has ended.
              </Notice>
            ) : null}
          </FormNotice>
          <div className="grid gap-4 md:grid-cols-2">
            <FieldInput
              label="Current password"
              value={current}
              onChange={edit(setCurrent)}
              error={form.errors.currentPassword}
              input={{
                disabled: form.saving,
                autoComplete: 'current-password',
                type: 'password',
                required: true,
              }}
              hint="A wrong one counts as a failed sign-in."
              className="md:col-span-2"
            />
            <FieldInput
              label="New password"
              value={next}
              onChange={edit(setNext)}
              error={form.errors.newPassword}
              input={{
                disabled: form.saving,
                autoComplete: 'new-password',
                type: 'password',
                required: true,
              }}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters, not too common, not like your user name.`}
            />
            <FieldInput
              label="Repeat the new password"
              value={confirm}
              onChange={edit(setConfirm)}
              error={form.errors.confirm}
              input={{
                disabled: form.saving,
                autoComplete: 'new-password',
                type: 'password',
                required: true,
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={form.saving} aria-busy={form.saving}>
              {form.saving ? 'Changing…' : 'Change password'}
            </Button>
            <span className="type-body text-fg-muted">
              Ends your other sessions; this one goes on.
            </span>
          </div>
        </form>
      </Panel>
    </div>
  )
}

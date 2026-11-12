import { useContext, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { Account, AccountDetail, ScopeOptions, UserRole } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { usePrefs } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import { useViewSearch, useViewTo } from '@/app/viewSearch'
import { useResource } from '@/hooks/useResource'
import { useSaveForm } from '@/hooks/useSaveForm'
import { formatAgo, formatClock } from '@/lib/format'
import { Fact } from '@/ui/Fact'
import { FormNotice } from '@/ui/FormNotice'
import { Panel } from '@/ui/Panel'
import { Button, Checkbox, FieldInput, FieldSelect } from '@/ui/controls'
import { EmptyState, Notice, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { BackLink, FlashNotice, NotPermitted, type Flash } from './AdminParts'
import { useArrivalState, useListBack } from './adminHooks'
import {
  ACCOUNT_FIELDS,
  EMPTY_ACCOUNT,
  LIMITS,
  MIN_PASSWORD_LENGTH,
  ROLES,
  ROLE_HINT,
  ROLE_LABEL,
  accountDraft,
  accountInput,
  accountPatch,
  scopedRole,
  validateAccount,
  validatePassword,
  type AccountDraft,
} from './usersModel'
import { userPath } from './sections'

const NOT_PERMITTED = (
  <NotPermitted
    what="manage accounts"
    hint="Accounts, roles, grants, passwords and lockouts are offered to administrators only. The server checks it on every request."
  />
)

/** The customers and the sites an account is granted: one checkbox each, named with the customer. */
function Grants({
  scope,
  draft,
  disabled,
  onChange,
}: {
  scope: ScopeOptions
  draft: AccountDraft
  disabled: boolean
  onChange: (changes: Partial<AccountDraft>) => void
}) {
  const customers = new Map(scope.customers.map((customer) => [customer.id, customer.name]))
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id)
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
        <legend className="type-label text-fg-muted">Customers (every site, now and later)</legend>
        {scope.customers.length === 0 ? (
          <p className="type-body text-fg-faint">There is no customer yet.</p>
        ) : (
          scope.customers.map((customer) => (
            <Checkbox
              key={customer.id}
              label={customer.name}
              checked={draft.customerIds.includes(customer.id)}
              onChange={(on) =>
                onChange({ customerIds: toggle(draft.customerIds, customer.id, on) })
              }
              disabled={disabled}
            />
          ))
        )}
      </fieldset>
      <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
        <legend className="type-label text-fg-muted">Single sites</legend>
        {scope.sites.length === 0 ? (
          <p className="type-body text-fg-faint">There is no site yet.</p>
        ) : (
          scope.sites.map((site) => (
            <Checkbox
              key={site.id}
              label={`${customers.get(site.customerId) ?? 'Unknown customer'} / ${site.name}`}
              checked={draft.siteIds.includes(site.id)}
              onChange={(on) => onChange({ siteIds: toggle(draft.siteIds, site.id, on) })}
              disabled={disabled}
            />
          ))
        )}
      </fieldset>
    </div>
  )
}

interface EditorProps {
  account?: Account
  scope: ScopeOptions
  onSaved: (detail: AccountDetail) => void
  onCreated: (detail: AccountDetail) => void
}

/**
 * The form of an account: who it is, its role (the least that does the job), what it sees, whether
 * it is active, and, for a new one, its first password typed twice. The server decides again:
 * your own account is neither deactivated nor demoted here, and the last administrator stays.
 */
function Editor({ account, scope, onSaved, onCreated }: EditorProps) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState<AccountDraft>(() =>
    account ? accountDraft(account) : EMPTY_ACCOUNT,
  )
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(ACCOUNT_FIELDS, shell?.announce, summary)
  const taken =
    form.failure?.code === 'user_exists' && form.failure.message ? [form.failure.message] : null
  const errors = { ...form.errors, ...(taken ? { username: taken } : {}) }
  const lines = taken ? [] : form.lines
  const changed = account ? accountPatch(draft, account) !== null : true
  const scoped = scopedRole(draft.role)
  const self = account?.self ?? false

  const edit = (changes: Partial<AccountDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    form.touched()
  }

  const submit = () =>
    form.submit(
      validateAccount(draft, account === undefined),
      async () => {
        if (account) {
          const body = accountPatch(draft, account)
          if (body === null) return
          onSaved(await api.updateUser(account.id, body))
          shell?.announce('Account saved.')
        } else {
          onCreated(await api.createUser(accountInput(draft)))
          setDraft((current) => ({ ...current, password: '', confirm: '' }))
          shell?.announce('Account created.')
        }
      },
      { failed: 'The account was not saved.' },
    )

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={form.saving}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.saving) void submit()
      }}
    >
      <FormNotice
        ref={summary}
        invalid={Object.keys(errors).filter(
          (name) => (errors[name as keyof typeof errors]?.length ?? 0) > 0,
        )}
        lines={lines}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <FieldInput
          label="User name"
          value={draft.username}
          onChange={(username) => edit({ username })}
          error={errors.username}
          input={{ disabled: form.saving, autoComplete: 'off', spellCheck: false, required: true }}
          hint={`What the account signs in with. Letters, digits and @ . + - _; up to ${LIMITS.username} characters.`}
        />
        <FieldInput
          label="Email"
          value={draft.email}
          onChange={(email) => edit({ email })}
          error={errors.email}
          input={{ disabled: form.saving, autoComplete: 'off', spellCheck: false, type: 'email' }}
          hint="Optional. Where Sentinel emails this account about incidents, if it asks for that."
        />
        <FieldInput
          label="First name"
          value={draft.firstName}
          onChange={(firstName) => edit({ firstName })}
          error={errors.firstName}
          input={{ disabled: form.saving, autoComplete: 'off' }}
          hint="Optional."
        />
        <FieldInput
          label="Last name"
          value={draft.lastName}
          onChange={(lastName) => edit({ lastName })}
          error={errors.lastName}
          input={{ disabled: form.saving, autoComplete: 'off' }}
          hint="Optional."
        />
        {account === undefined ? (
          <>
            <FieldInput
              label="First password"
              value={draft.password}
              onChange={(password) => edit({ password })}
              error={errors.password}
              input={{
                disabled: form.saving,
                autoComplete: 'new-password',
                type: 'password',
                required: true,
              }}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters, not too common, not like the user name. Tell it to the user, who changes it from Settings > Account.`}
            />
            <FieldInput
              label="Repeat the password"
              value={draft.confirm}
              onChange={(confirm) => edit({ confirm })}
              error={errors.confirm}
              input={{
                disabled: form.saving,
                autoComplete: 'new-password',
                type: 'password',
                required: true,
              }}
            />
          </>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <FieldSelect
          label="Role"
          value={draft.role}
          onChange={(role: UserRole) => edit({ role })}
          options={ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
          error={errors.role}
          disabled={form.saving || (self && account?.role === 'administrator')}
          hint={
            self && account?.role === 'administrator'
              ? 'Your own role is not changed here: another administrator must do it.'
              : ROLE_HINT[draft.role]
          }
        />
        <div className="flex flex-col gap-3">
          {scoped ? (
            <Checkbox
              label="Sees every customer"
              description="Otherwise the account sees only the customers and sites granted below."
              checked={draft.allCustomers}
              onChange={(allCustomers) => edit({ allCustomers })}
              disabled={form.saving}
              error={errors.allCustomers}
            />
          ) : (
            <p className="type-body text-fg-muted">
              {ROLE_LABEL[draft.role]}s see every customer: there is no scope to choose.
            </p>
          )}
          {account !== undefined ? (
            <Checkbox
              label="Active"
              description={
                self
                  ? 'Your own account is not deactivated here: another administrator must do it.'
                  : 'A deactivated account cannot sign in and its sessions end; its grants and preferences stay.'
              }
              checked={draft.active}
              onChange={(active) => edit({ active })}
              disabled={form.saving || self}
              error={errors.active}
            />
          ) : null}
        </div>
      </div>

      {scoped && !draft.allCustomers ? (
        <Grants scope={scope} draft={draft} disabled={form.saving} onChange={edit} />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={form.saving || !changed}
          aria-busy={form.saving}
        >
          {form.saving ? 'Saving…' : account ? 'Save changes' : 'Create account'}
        </Button>
        {account && !changed ? (
          <span className="type-body text-fg-muted">Nothing changed yet.</span>
        ) : null}
      </div>
    </form>
  )
}

/** An administrator sets another account's password: typed twice, never shown again, ending that account's sessions. */
function PasswordPanel({
  account,
  onDone,
}: {
  account: Account
  onDone: (detail: AccountDetail) => void
}) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const summary = useRef<HTMLDivElement>(null)
  const form = useSaveForm(['password', 'confirm'] as const, shell?.announce, summary)

  const submit = () =>
    form.submit(
      validatePassword(password, confirm),
      async () => {
        onDone(await api.resetUserPassword(account.id, password))
        setPassword('')
        setConfirm('')
        setDone(true)
        shell?.announce('Password set. The account’s sessions have ended.')
      },
      { failed: 'The password was not set.' },
    )

  if (account.self) {
    return (
      <p className="type-body text-fg-muted">
        Your own password is changed from Settings &gt; Account.
      </p>
    )
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      aria-busy={form.saving}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault()
        if (!form.saving) void submit()
      }}
    >
      <FormNotice ref={summary} invalid={form.invalid} lines={form.lines} word="NOT SET">
        {done ? (
          <Notice status="healthy" word="PASSWORD SET" live="status">
            The new password is set and every session of “{account.username}” has ended. Tell it to
            the user, who can change it from Settings &gt; Account.
          </Notice>
        ) : null}
      </FormNotice>
      <div className="grid gap-4 md:grid-cols-2">
        <FieldInput
          label="New password"
          value={password}
          onChange={(value) => {
            setPassword(value)
            form.touched()
          }}
          error={form.errors.password}
          input={{ disabled: form.saving, autoComplete: 'new-password', type: 'password' }}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters, not too common, not like the user name.`}
        />
        <FieldInput
          label="Repeat the new password"
          value={confirm}
          onChange={(value) => {
            setConfirm(value)
            form.touched()
          }}
          error={form.errors.confirm}
          input={{ disabled: form.saving, autoComplete: 'new-password', type: 'password' }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={form.saving || password === ''} aria-busy={form.saving}>
          {form.saving ? 'Setting…' : 'Set password'}
        </Button>
        <span className="type-body text-fg-muted">Ends every session of the account at once.</span>
      </div>
    </form>
  )
}

/** The sign-in lockout of an account, and the unlock, as `manage.py unlock_login` does it. */
function SignInPanel({
  account,
  nowMs,
  onDone,
}: {
  account: Account
  nowMs: number
  onDone: (detail: AccountDetail) => void
}) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const { tz } = usePrefs()
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<Flash | null>(null)

  const unlock = async () => {
    setBusy(true)
    setFlash(null)
    try {
      onDone(await api.unlockUser(account.id))
      setFlash({
        tone: 'ok',
        text: 'The failed sign-ins are forgotten: the account may sign in now.',
      })
      shell?.announce('Account unlocked.')
    } catch (error) {
      setFlash({
        tone: 'error',
        text: error instanceof ApiError ? error.message : 'The account could not be unlocked.',
      })
      shell?.announce('The account was not unlocked.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @2xl:grid-cols-4">
        <Fact label="Last sign-in">
          {account.lastLoginAt ? (
            <span title={formatClock(Date.parse(account.lastLoginAt), tz)}>
              {formatAgo(account.lastLoginAt, nowMs)}
            </span>
          ) : (
            'never'
          )}
        </Fact>
        <Fact label="Sign-in">
          {account.locked ? (
            <StatusTag status="warning" word="LOCKED" variant="tag" />
          ) : (
            <StatusTag status="healthy" word="ALLOWED" variant="tag" />
          )}
        </Fact>
        <Fact label="Locked until">
          {account.lockedUntil ? formatClock(Date.parse(account.lockedUntil), tz) : '—'}
        </Fact>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void unlock()} disabled={busy} aria-busy={busy}>
          {busy ? 'Unlocking…' : 'Unlock sign-in'}
        </Button>
        <span className="type-body text-fg-muted">
          {account.locked
            ? 'Repeated wrong passwords locked the account for a while; unlocking ends that now.'
            : 'Not locked. Unlocking forgets any failed sign-ins counted so far.'}
        </span>
      </div>
    </div>
  )
}

/**
 * Settings > Users & access > one account, or a new one: the account itself (name, role, scope,
 * state), a new password set by the administrator, and the sign-in lockout. Accounts are
 * deactivated, never deleted: the audit trail refers to them.
 */
export default function UserPage() {
  const api = useApi()
  const { id } = useParams()
  const creating = id === undefined
  const userId = Number(id)
  const navigate = useNavigate()
  const viewTo = useViewTo()
  const view = useViewSearch()
  const { capabilities } = useAuth()
  const may = capabilities.manageUsers
  const back = useListBack('/settings/users', view)
  const arrival = useArrivalState<{ created?: boolean }>()

  const detail = useResource(`user:${id ?? 'new'}:${may}`, async (signal) =>
    may && !creating && Number.isInteger(userId) && userId > 0
      ? api.getUser(userId, { signal })
      : null,
  )
  const scope = useResource<ScopeOptions | null>(`user-scope:${may}`, async (signal) =>
    may ? api.getScopeOptions({ signal }) : null,
  )
  const [saved, setSaved] = useState<{ at: string | undefined; detail: AccountDetail } | null>(null)
  if (saved !== null && saved.at !== id) setSaved(null)
  const current = saved !== null && saved.at === id ? saved.detail : (detail.data ?? undefined)
  const account = current?.item
  const nowMs = current ? Date.parse(current.generatedAt) : 0

  if (!may) return NOT_PERMITTED

  const notFound =
    (!creating && !(Number.isInteger(userId) && userId > 0)) ||
    (detail.error instanceof ApiError && detail.error.status === 404 && current === undefined)
  const loading = scope.data == null || (!creating && account === undefined)
  const failed = scope.error ?? detail.error
  const answered = (next: AccountDetail) => setSaved({ at: id, detail: next })

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <BackLink to={back}>Users & access</BackLink>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="type-title">
            {creating ? (
              'New user'
            ) : account ? (
              account.username
            ) : failed ? (
              'Account'
            ) : (
              <Skeleton className="h-5 w-40" />
            )}
          </h2>
          {account ? (
            <>
              <StatusTag
                status={account.active ? 'healthy' : 'idle'}
                word={account.active ? 'ACTIVE' : 'INACTIVE'}
                variant="tag"
              />
              {account.self ? <StatusTag status="unknown" word="YOU" variant="tag" /> : null}
              <span className="type-data text-fg-muted">
                {account.role ? ROLE_LABEL[account.role] : 'No console access'}
              </span>
            </>
          ) : null}
        </div>
      </header>

      {arrival.created && !saved ? (
        <Notice status="healthy" word="CREATED" live="status">
          The account is created. Tell the user the first password: it is not shown again, and they
          change it from Settings &gt; Account.
        </Notice>
      ) : null}
      {saved ? (
        <Notice status="healthy" word="SAVED" live="status">
          The account is saved.
          {saved.detail.item.active
            ? ''
            : ' It is deactivated: its sessions have ended and it cannot sign in.'}
        </Notice>
      ) : null}

      {notFound ? (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState
            title="Account not found"
            hint="It does not exist. Accounts are never deleted from the console."
          />
        </div>
      ) : (
        <Panel
          title="Account"
          features="settings"
          scope="NOW"
          status={loading ? (failed ? 'error' : 'loading') : 'success'}
          error={loading ? failed : null}
          onRetry={() => {
            scope.refetch()
            detail.refetch()
          }}
          skeleton={<div className="h-64" />}
          className="max-w-4xl"
        >
          {scope.data && (creating || account) ? (
            <Editor
              key={account ? `${account.id}:${current?.generatedAt ?? ''}` : 'new'}
              account={account}
              scope={scope.data}
              onSaved={answered}
              onCreated={(next) =>
                void navigate(viewTo(userPath(next.item.id)), {
                  state: { created: true, list: back.search },
                })
              }
            />
          ) : null}
        </Panel>
      )}

      {account ? (
        <>
          <Panel title="Password" features="settings" scope="NOW" className="max-w-4xl">
            <PasswordPanel key={current?.generatedAt} account={account} onDone={answered} />
          </Panel>
          <Panel title="Sign-in" features="settings" scope="NOW" className="max-w-4xl">
            <SignInPanel account={account} nowMs={nowMs} onDone={answered} />
          </Panel>
        </>
      ) : null}
    </div>
  )
}

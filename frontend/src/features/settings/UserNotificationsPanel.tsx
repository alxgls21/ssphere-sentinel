import { useContext, useState } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { NotificationPreferencesInput, UserNotifications } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import { useResource } from '@/hooks/useResource'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'
import { RECEIVING_BLOCK_TEXT, changedByText } from '@/lib/settings'
import { SEVERITY_CHOICES } from '@/lib/settings'
import { Panel } from '@/ui/Panel'
import { Button, Checkbox, RadioGroup } from '@/ui/controls'
import { Notice } from '@/ui/states'
import { StatusTag } from '@/ui/status'

const FIELDS = ['enabled', 'minSeverity', 'sendRecovery'] as const

/** The refusals that belong to the "emails on" box: the account cannot receive them. */
const CANNOT_RECEIVE = new Set(['no_email_address', 'account_inactive', 'no_console_access'])

const draftOf = (settings: UserNotifications): NotificationPreferencesInput => ({
  enabled: settings.preferences.enabled,
  minSeverity: settings.preferences.minSeverity,
  sendRecovery: settings.preferences.sendRecovery,
})

const same = (a: NotificationPreferencesInput, b: NotificationPreferencesInput): boolean =>
  a.enabled === b.enabled && a.minSeverity === b.minSeverity && a.sendRecovery === b.sendRecovery

function Form({
  settings,
  onAnswer,
}: {
  settings: UserNotifications
  onAnswer: (settings: UserNotifications, note?: string) => void
}) {
  const api = useApi()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState(() => draftOf(settings))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<FormFailure | null>(null)

  const kept = draftOf(settings)
  const dirty = !same(draft, kept)
  // An account that cannot receive emails can still be switched off; it cannot be switched on.
  const blocked = settings.receivingBlockedBy !== null
  const change = (patch: Partial<NotificationPreferencesInput>) => {
    setDraft((now) => ({ ...now, ...patch }))
    setFailure(null)
  }

  const save = async () => {
    setSaving(true)
    setFailure(null)
    try {
      const answer = await api.saveUserNotifications(settings.user.id, draft)
      onAnswer(answer)
      shell?.announce('Notification preferences saved.')
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        // Nothing was saved: show what is stored, which another save just set.
        try {
          onAnswer(
            await api.getUserNotifications(settings.user.id),
            'Someone else changed this just now. The values shown are the ones stored.',
          )
        } catch {
          setFailure(describeWriteFailure(error, FIELDS))
        }
      } else {
        setFailure(describeWriteFailure(error, FIELDS))
      }
      shell?.announce('Notification preferences were not saved.')
    } finally {
      setSaving(false)
    }
  }

  const top = summaryOf(failure)
  const refused =
    failure?.code !== null && failure?.code !== undefined && CANNOT_RECEIVE.has(failure.code)
  const enabledErrors = [
    ...(failure?.fields.enabled ?? []),
    ...(refused && failure?.message ? [failure.message] : []),
  ]
  const lines = refused ? top.filter((line) => line !== failure?.message) : top

  return (
    <form
      className="flex max-w-prose flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (dirty && !saving) void save()
      }}
      aria-busy={saving}
    >
      <Checkbox
        label="Email this account about incidents"
        description="An email when an incident opens, to the account’s address, if it may see the incident’s site."
        checked={draft.enabled}
        disabled={saving || (blocked && !draft.enabled)}
        onChange={(enabled) => change({ enabled })}
        error={enabledErrors}
      />
      <RadioGroup
        legend="Minimum severity"
        name="user-minSeverity"
        value={draft.minSeverity}
        onChange={(minSeverity) => change({ minSeverity })}
        choices={SEVERITY_CHOICES}
        disabled={saving}
        error={failure?.fields.minSeverity}
      />
      <Checkbox
        label="Email when an incident recovers"
        description="One more email when the recovery is confirmed."
        checked={draft.sendRecovery}
        disabled={saving}
        onChange={(sendRecovery) => change({ sendRecovery })}
        error={failure?.fields.sendRecovery}
      />
      {lines.length > 0 ? (
        <Notice status="critical" word="NOT SAVED" live="alert">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={!dirty || saving} aria-busy={saving}>
          {saving ? 'Saving…' : 'Save preferences'}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(kept)
            setFailure(null)
          }}
        >
          Discard changes
        </Button>
      </div>
    </form>
  )
}

/**
 * Another account's incident email preferences, as an administrator sees and sets them: whether the
 * account can receive emails at all (and why not), whether they are on, from which severity, and who
 * changed them last. The address is the account's own and is not set here; a test email goes only to the
 * account that asks for it.
 */
export function UserNotificationsPanel({ userId }: { userId: number }) {
  const api = useApi()
  const { tz } = usePrefs()
  const resource = useResource(`user-notifications:${userId}`, (signal) =>
    api.getUserNotifications(userId, { signal }),
  )
  const [saved, setSaved] = useState<{
    userId: number
    settings: UserNotifications
    note: string | null
  } | null>(null)
  const current =
    saved !== null && saved.userId === userId ? saved.settings : (resource.data ?? undefined)
  const note = saved !== null && saved.userId === userId ? saved.note : null
  const nowMs = current ? Date.parse(current.generatedAt) : 0

  return (
    <Panel
      title="Notifications"
      features="settings"
      scope="NOW"
      status={current ? 'success' : resource.error ? 'error' : 'loading'}
      error={current ? null : resource.error}
      onRetry={resource.refetch}
      skeleton={<div className="h-40" />}
      className="max-w-4xl"
      footer={
        current ? (
          <span className="truncate">
            {current.preferences.changedBy
              ? changedByText(current.preferences.changedBy, tz, nowMs, 'admin')
              : 'Never saved: these are the defaults.'}
          </span>
        ) : undefined
      }
    >
      {current ? (
        <div className="flex flex-col gap-4">
          <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusTag
              status={current.receiving ? 'healthy' : 'idle'}
              word={current.receiving ? 'RECEIVING' : 'NOT RECEIVING'}
              variant="tag"
            />
            <span className="type-data text-fg-muted">
              {current.account.email ?? 'no email address'}
            </span>
          </p>
          {current.receivingBlockedBy ? (
            <Notice status="warning" word="CANNOT RECEIVE">
              {RECEIVING_BLOCK_TEXT[current.receivingBlockedBy]}
            </Notice>
          ) : null}
          {!current.email.available ? (
            <Notice status="idle" word="NO EMAIL HERE">
              This server sends no email: no mail server is set. The preferences are kept, but
              nothing is sent until an administrator sets one.
            </Notice>
          ) : null}
          {note ? (
            <Notice status="warning" word="CHANGED" live="status">
              {note}
            </Notice>
          ) : null}
          <Form
            key={JSON.stringify(current.preferences)}
            settings={current}
            onAnswer={(settings, message) => setSaved({ userId, settings, note: message ?? null })}
          />
        </div>
      ) : null}
    </Panel>
  )
}

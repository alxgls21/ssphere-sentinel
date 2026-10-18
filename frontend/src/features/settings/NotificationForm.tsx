import { useContext, useState } from 'react'
import { useApi } from '@/api/context'
import type { NotificationPreferencesInput, NotificationSettings } from '@/api/types'
import { usePrefs } from '@/app/prefs'
import { ShellContext } from '@/app/shell'
import { describeWriteFailure, summaryOf, type FormFailure } from '@/lib/forms'
import { formatClock } from '@/lib/format'
import { SEVERITY_CHOICES } from '@/lib/settings'
import { Panel } from '@/ui/Panel'
import { Button, Checkbox, Field, RadioGroup, controlClass } from '@/ui/controls'
import { Notice } from '@/ui/states'

const FIELDS = ['enabled', 'minSeverity', 'sendRecovery'] as const

interface NotificationFormProps {
  settings: NotificationSettings
  /** The preferences as the server answered a save: they replace what the page holds. */
  onSaved: (settings: NotificationSettings) => void
  className?: string
}

const draftOf = (settings: NotificationSettings): NotificationPreferencesInput => ({
  enabled: settings.preferences.enabled,
  minSeverity: settings.preferences.minSeverity,
  sendRecovery: settings.preferences.sendRecovery,
})

const same = (a: NotificationPreferencesInput, b: NotificationPreferencesInput): boolean =>
  a.enabled === b.enabled && a.minSeverity === b.minSeverity && a.sendRecovery === b.sendRecovery

/**
 * The user's own email preferences: emails on or off, from which severity, and whether recoveries
 * are mailed too. The address is the account's own and read-only. The server says what is wrong
 * with a value, field by field, and the screen shows it under the field; a save that is refused
 * leaves the form as it was, and one that succeeds shows what the server kept.
 */
export function NotificationForm({ settings, onSaved, className }: NotificationFormProps) {
  const api = useApi()
  const { tz } = usePrefs()
  const shell = useContext(ShellContext)
  const [draft, setDraft] = useState(() => draftOf(settings))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<FormFailure | null>(null)
  const [saved, setSaved] = useState(false)

  const kept = draftOf(settings)
  const dirty = !same(draft, kept)
  const noAddress = settings.account.email === null
  // Without an address emails cannot be switched on, but they can always be switched off.
  const cannotEnable = noAddress && !draft.enabled
  const change = (patch: Partial<NotificationPreferencesInput>) => {
    setDraft((now) => ({ ...now, ...patch }))
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    setFailure(null)
    setSaved(false)
    try {
      const answer = await api.saveNotificationPreferences(draft)
      setDraft(draftOf(answer))
      setSaved(true)
      onSaved(answer)
      shell?.announce('Notification preferences saved.')
    } catch (error) {
      const found = describeWriteFailure(error, FIELDS)
      setFailure(found)
      shell?.announce('Notification preferences were not saved.')
    } finally {
      setSaving(false)
    }
  }

  const top = summaryOf(failure)
  // The one refusal that belongs to a field: emails cannot be switched on without an address.
  const enabledErrors = [
    ...(failure?.fields.enabled ?? []),
    ...(failure?.code === 'no_email_address' && failure.message ? [failure.message] : []),
  ]
  const lines =
    failure?.code === 'no_email_address' ? top.filter((line) => line !== failure.message) : top

  return (
    <Panel
      title="Email notifications"
      features="settings"
      scope="NOW"
      className={className}
      footer={
        <span className="truncate">
          {settings.preferences.updatedAt
            ? `Saved ${formatClock(Date.parse(settings.preferences.updatedAt), tz)}`
            : 'Not saved yet: these are the defaults.'}
        </span>
      }
    >
      <form
        className="flex max-w-prose flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (dirty && !saving) void save()
        }}
        aria-busy={saving}
      >
        {!settings.email.available ? (
          <Notice status="idle" word="NO EMAIL HERE">
            This server sends no email: no mail server is set. You can keep your preferences, but
            nothing is sent until an administrator sets one.
          </Notice>
        ) : null}
        {noAddress ? (
          <Notice status="warning" word="NO ADDRESS">
            Your account has no email address, so emails cannot be switched on. An administrator
            sets it on your account.
          </Notice>
        ) : null}

        <Field
          label="Account email"
          hint="Set on your account by an administrator. It cannot be changed here."
        >
          {(aria) => (
            <input
              {...aria}
              type="email"
              readOnly
              value={settings.account.email ?? ''}
              placeholder="none"
              className={controlClass(false, 'bg-raised hover:bg-raised')}
            />
          )}
        </Field>

        <Checkbox
          label="Email me about incidents"
          description="An email when an incident opens, to your account’s address, if you may see the incident’s site."
          checked={draft.enabled}
          disabled={saving || cannotEnable}
          onChange={(enabled) => change({ enabled })}
          error={enabledErrors}
        />

        <RadioGroup
          legend="Minimum severity"
          name="minSeverity"
          value={draft.minSeverity}
          onChange={(minSeverity) => change({ minSeverity })}
          choices={SEVERITY_CHOICES}
          disabled={saving}
          error={failure?.fields.minSeverity}
        />

        <Checkbox
          label="Email me when an incident recovers"
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
        {saved ? (
          <Notice status="healthy" word="SAVED" live="status">
            Your preferences are saved.
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
    </Panel>
  )
}

import { useState } from 'react'
import { useApi } from '@/api/context'
import type { NotificationSettings } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { useResource } from '@/hooks/useResource'
import { ApiError } from '@/api/errors'
import { Panel } from '@/ui/Panel'
import { EmptyState } from '@/ui/states'
import { NotificationForm } from './NotificationForm'
import { TestEmailPanel } from './TestEmailPanel'

/**
 * Settings > Notifications: the signed-in user's own email preferences, and a test email. Read once,
 * and again only when asked (a refusal, or Retry): a form being filled is never replaced under the
 * person typing. An account that may not manage these is told so and no request is made.
 */
export default function NotificationsPage() {
  const api = useApi()
  const { capabilities } = useAuth()
  const permitted = capabilities.manageOwnNotifications
  const resource = useResource<NotificationSettings | null>(
    `notification-settings:${permitted}`,
    async (signal) => (permitted ? api.getNotificationSettings({ signal }) : null),
  )
  // What a save answered replaces what was read, until the settings are read again. `epoch` counts
  // those readings: the form starts again from one, never from a save (it has just shown it).
  const [saved, setSaved] = useState<NotificationSettings | null>(null)
  const [epoch, setEpoch] = useState(0)
  const settings = saved ?? resource.data ?? null

  if (!permitted) {
    return (
      <div className="rounded-sm border border-border bg-panel">
        <EmptyState
          title="Notifications are not available to this account"
          hint="Email preferences belong to a signed-in console user. The sample fleet has none."
        />
      </div>
    )
  }

  const reload = () => {
    setSaved(null)
    setEpoch((count) => count + 1)
    resource.refetch()
  }

  if (settings === null) {
    if (resource.error instanceof ApiError && resource.error.status === 403) {
      return (
        <div className="rounded-sm border border-border bg-panel">
          <EmptyState
            title="Not permitted"
            hint="This account may not use the console’s notification settings."
          />
        </div>
      )
    }
    return (
      <Panel
        title="Email notifications"
        features="settings"
        status={resource.status}
        error={resource.error}
        onRetry={reload}
        skeleton={<div className="h-48" />}
        className="max-w-3xl"
      >
        {null}
      </Panel>
    )
  }

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <NotificationForm
        key={epoch}
        settings={settings}
        onSaved={setSaved}
        className="xl:col-span-1"
      />
      <TestEmailPanel
        settings={settings}
        permitted={capabilities.sendTestEmail}
        onRefresh={reload}
        className="xl:col-span-1"
      />
    </div>
  )
}

import { useMemo, type ReactNode } from 'react'
import { useApi } from '@/api/context'
import { ApiError } from '@/api/errors'
import type { EngineStatus, SystemStatus } from '@/api/types'
import { useAuth } from '@/app/auth/auth'
import { useLiveResource } from '@/hooks/useLiveResource'
import type { Resource } from '@/hooks/useResource'
import { EMPTY, formatAge, formatDuration, formatInteger } from '@/lib/format'
import { TEST_EMAIL_WORD, failureRows, failureText } from '@/lib/settings'
import { EngineStatusBanner } from '@/ui/incidents'
import { Panel } from '@/ui/Panel'
import { EmptyState, ErrorState, Skeleton } from '@/ui/states'
import { StatusTag } from '@/ui/status'
import { NotifierBanner } from './NotifierBanner'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-label text-fg-faint">{label}</dt>
      <dd className="type-data min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

const SECURITY_WORD = { starttls: 'STARTTLS', tls: 'TLS', none: 'none (unencrypted)' } as const

function OutboxPanel({ status, className }: { status: SystemStatus; className?: string }) {
  const { outbox, environment } = status
  const nowMs = Date.parse(status.generatedAt)
  const day = outbox.last24Hours
  const tests = outbox.testEmails.last24Hours
  const failures = failureRows(day.failures)
  const testRows = (Object.keys(tests) as (keyof typeof tests)[]).filter((name) => tests[name] > 0)
  return (
    <Panel title="Notification outbox" features="settings" scope="NOW" className={className}>
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @2xl:grid-cols-4">
          <Fact label="Waiting to send">{formatInteger(outbox.pending)}</Fact>
          <Fact label="Being sent">{formatInteger(outbox.sending)}</Fact>
          <Fact label="Oldest waiting">
            {outbox.oldestPendingAt
              ? `${formatAge(outbox.oldestPendingAt, nowMs)} old`
              : 'none waiting'}
          </Fact>
          <Fact label="Overdue">
            <span className="flex flex-wrap items-center gap-2">
              {formatInteger(outbox.overdue)}
              {outbox.overdue > 0 ? <StatusTag status="warning" word="LATE" /> : null}
            </span>
          </Fact>
        </dl>
        {outbox.overdue > 0 ? (
          <p className="type-body text-fg-muted">
            {formatInteger(outbox.overdue)} {outbox.overdue === 1 ? 'email has' : 'emails have'}{' '}
            waited longer than the {environment.email.maxAgeHours} hours an email may: it will be
            dropped, not sent late.
          </p>
        ) : null}
        <section aria-label="Last 24 hours" className="flex flex-col gap-1.5">
          <h3 className="type-label text-fg-faint">LAST 24 HOURS</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @2xl:grid-cols-4">
            <Fact label="Created">{formatInteger(day.created)}</Fact>
            <Fact label="Sent">{formatInteger(day.sent)}</Fact>
            <Fact label="Failed">{formatInteger(day.failed)}</Fact>
            <Fact label="Cancelled">{formatInteger(day.cancelled)}</Fact>
          </dl>
          {failures.length > 0 ? (
            <ul
              aria-label="Why emails did not go"
              className="type-data flex flex-wrap gap-x-4 gap-y-1 text-fg-muted"
            >
              {failures.map(({ category, count }) => (
                <li key={category}>
                  {formatInteger(count)} {failureText(category)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body text-fg-muted">
              No email failed or was cancelled in the last day.
            </p>
          )}
        </section>
        <section aria-label="Test emails" className="flex flex-col gap-1.5">
          <h3 className="type-label text-fg-faint">TEST EMAILS</h3>
          <p className="type-data text-fg-muted">
            {formatInteger(outbox.testEmails.open)} open
            {testRows.length > 0
              ? `; last 24 hours: ${testRows.map((name) => `${formatInteger(tests[name])} ${TEST_EMAIL_WORD[name].toLowerCase()}`).join(', ')}`
              : '; none in the last 24 hours'}
          </p>
        </section>
      </div>
    </Panel>
  )
}

function DeploymentPanel({ status, className }: { status: SystemStatus; className?: string }) {
  const { email } = status.environment
  return (
    <Panel
      title="Email, as the deployment sets it"
      features="settings"
      scope="NOW"
      className={className}
      footer={
        <span className="truncate">
          Set in the deployment, changed there. No password is shown.
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 @2xl:grid-cols-3">
        <Fact label="Email">
          {email.enabled ? (
            <StatusTag status="healthy" word="ON" />
          ) : (
            <StatusTag status="idle" word="OFF: NO MAIL SERVER" />
          )}
        </Fact>
        <Fact label="Mail server">
          {email.host ?? <span className="text-fg-muted">not set</span>}
        </Fact>
        <Fact label="Port">{email.port}</Fact>
        <Fact label="Connection">{SECURITY_WORD[email.security]}</Fact>
        <Fact label="From address">
          {email.fromAddress ?? <span className="text-fg-muted">not set</span>}
        </Fact>
        <Fact label="Timeout">{formatDuration(email.timeoutSeconds)}</Fact>
        <Fact label="Longest an email waits">{email.maxAgeHours} h</Fact>
        <Fact label="Console address in emails">
          {email.consoleUrl ?? <span className="text-fg-muted">not set</span>}
        </Fact>
      </dl>
    </Panel>
  )
}

function RetentionPanel({ status, className }: { status: SystemStatus; className?: string }) {
  const { retention } = status.environment
  const rows: [string, number][] = [
    ['Incidents', retention.incidentDays],
    ['Notifications', retention.notificationDays],
    ['Network measurements', retention.networkMeasurementDays],
    ['SNMP samples and polls', retention.snmpDays],
    ['Server telemetry', retention.telemetryDays],
    ['Absent containers', retention.absentContainerDays],
  ]
  return (
    <Panel
      title="Retention"
      features="settings"
      scope="NOW"
      className={className}
      footer={<span className="truncate">How long each kind of record is kept, in days.</span>}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        {rows.map(([label, days]) => (
          <Fact key={label} label={label}>
            {formatInteger(days)} days
          </Fact>
        ))}
      </dl>
    </Panel>
  )
}

function MonitoringPanel({ status, className }: { status: SystemStatus; className?: string }) {
  const { monitoring } = status.environment
  const t = monitoring.thresholds
  return (
    <Panel
      title="Monitoring limits"
      features="settings"
      scope="NOW"
      className={className}
      footer={<span className="truncate">The limits the server judges health by.</span>}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label="Server offline after">
          {formatDuration(monitoring.offlineThresholdSeconds)}
        </Fact>
        <Fact label="Resource warning at">{t.resourceWarnPercent}%</Fact>
        <Fact label="Resource critical at">{t.resourceCritPercent}%</Fact>
        <Fact label="Probe loss warning at">{t.probeLossWarnPercent}%</Fact>
        <Fact label="Probe latency warning at">{t.probeLatencyWarnMs} ms</Fact>
        <Fact label="Target critical after">{t.targetCritFailures} failures</Fact>
      </dl>
    </Panel>
  )
}

/**
 * Settings > System: the alert engine, the notifier, the email outbox and what the deployment
 * sets, read-only and only for an account the server lets see it (its counts concern every
 * customer: no request is made for any other). Each state is the server's: a notifier that is
 * disabled, never started or stopped is never drawn as healthy. A failed read is an error with Retry,
 * and a refresh that fails keeps the last answer under a banner.
 */
export default function SystemPage() {
  const api = useApi()
  const { capabilities } = useAuth()
  const permitted = capabilities.viewSystemStatus
  const resource = useLiveResource<SystemStatus | null>(
    'system-status',
    `system-status:${permitted}`,
    async (signal) => (permitted ? api.getSystemStatus({ signal }) : null),
    { keepPreviousData: true },
  )
  const status = resource.data ?? undefined

  // The engine's banner is the Alerts screen's: the system status carries the same state.
  const engine = useMemo<Resource<EngineStatus>>(
    () => ({
      ...resource,
      status: status ? 'success' : resource.status,
      data: status ? { ...status.alertEngine, generatedAt: status.generatedAt } : undefined,
    }),
    [resource, status],
  )

  if (!permitted) {
    return (
      <div className="rounded-sm border border-border bg-panel">
        <EmptyState
          title="Not permitted to see the system status"
          hint="Its counts concern every customer, so the console offers it only to an account with the permission and the access to all of them. The server checks it on every request."
        />
      </div>
    )
  }

  if (!status) {
    if (resource.status === 'loading') {
      return (
        <div aria-busy="true" className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )
    }
    const forbidden = resource.error instanceof ApiError && resource.error.status === 403
    return (
      <div className="rounded-sm border border-border bg-panel">
        <ErrorState
          title={
            forbidden
              ? 'Not permitted to see the system status'
              : 'The system status could not be loaded'
          }
          message={resource.error?.message ?? EMPTY}
          onRetry={forbidden ? undefined : resource.refetch}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {resource.error ? (
        <ErrorState
          banner
          title={`Refresh failed: ${resource.error.message}`}
          lastGood="showing the last answer"
          onRetry={resource.refetch}
        />
      ) : null}
      <EngineStatusBanner resource={engine} />
      <NotifierBanner status={status.notifier} generatedAt={status.generatedAt} />
      <div className="grid gap-3 xl:grid-cols-2">
        <OutboxPanel status={status} className="xl:col-span-2" />
        <DeploymentPanel status={status} />
        <RetentionPanel status={status} />
        <MonitoringPanel status={status} />
      </div>
    </div>
  )
}

import type { SentinelApi } from '../client'
import type {
  EmailSecurity,
  NotifierStatus,
  OutboxSummary,
  SystemEnvironment,
  SystemStatus,
  TestEmailStatus,
} from '../types'
import { parseEngineBody } from './incidents'
import { NOTIFIER_STATE } from './notifications'
import { bad, flag, nullableText, nullableTime, number, oneOf, record, time, whole } from './parse'
import type { Transport } from './transport'

/**
 * The system's status (`system/status/`): the alert engine, the notifier, the email outbox and what
 * the deployment sets. Read-only, and only for an account that may see it. The adapter names each
 * field it reads, so nothing else an answer holds (a secret, were one ever sent) reaches a screen.
 */

const SECURITY: readonly EmailSecurity[] = ['starttls', 'tls', 'none']
const SMTP_CATEGORY = ['connection', 'timeout', 'tls', 'authentication'] as const
const NOTIFIER_ERROR = ['database', 'internal'] as const
const TEST_STATUS: readonly TestEmailStatus[] = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'expired',
]

function counts(raw: unknown): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [name, value] of Object.entries(record(raw))) found[name] = whole(value)
  return found
}

function parseNotifier(raw: unknown): NotifierStatus {
  const row = record(raw)
  let lastError: NotifierStatus['lastError'] = null
  if (row.lastError !== null) {
    const found = record(row.lastError)
    lastError = { at: time(found.at), category: oneOf(NOTIFIER_ERROR, found.category) }
  }
  let lastSmtpError: NotifierStatus['lastSmtpError'] = null
  if (row.lastSmtpError !== null) {
    const found = record(row.lastSmtpError)
    lastSmtpError = { at: time(found.at), category: oneOf(SMTP_CATEGORY, found.category) }
  }
  const optionalFlag = (value: unknown) => (value === null ? null : flag(value))
  return {
    state: oneOf(NOTIFIER_STATE, row.state),
    stale: flag(row.stale),
    staleAfterSeconds: whole(row.staleAfterSeconds),
    intervalSeconds: row.intervalSeconds === null ? null : whole(row.intervalSeconds, 1),
    startedAt: nullableTime(row.startedAt),
    lastSuccessAt: nullableTime(row.lastSuccessAt),
    lastAttemptAt: nullableTime(row.lastAttemptAt),
    lastActiveAt: nullableTime(row.lastActiveAt),
    lastSmtpSuccessAt: nullableTime(row.lastSmtpSuccessAt),
    lastCycleMs: row.lastCycleMs === null ? null : whole(row.lastCycleMs),
    lastError,
    lastSmtpError,
    smtpConfigured: optionalFlag(row.smtpConfigured),
    authenticationConfigured: optionalFlag(row.authenticationConfigured),
  }
}

function parseOutbox(raw: unknown): OutboxSummary {
  const row = record(raw)
  const day = record(row.last24Hours)
  const tests = record(row.testEmails)
  const testDay = counts(tests.last24Hours)
  return {
    pending: whole(row.pending),
    sending: whole(row.sending),
    oldestPendingAt: nullableTime(row.oldestPendingAt),
    overdue: whole(row.overdue),
    last24Hours: {
      created: whole(day.created),
      sent: whole(day.sent),
      failed: whole(day.failed),
      cancelled: whole(day.cancelled),
      failures: counts(day.failures),
    },
    testEmails: {
      open: whole(tests.open),
      last24Hours: Object.fromEntries(
        TEST_STATUS.map((status) => [status, testDay[status] ?? 0]),
      ) as Record<TestEmailStatus, number>,
    },
  }
}

function parseEnvironment(raw: unknown): SystemEnvironment {
  const row = record(raw)
  const email = record(row.email)
  const retention = record(row.retention)
  const monitoring = record(row.monitoring)
  const thresholds = record(monitoring.thresholds)
  const limit = (value: unknown) => {
    const found = number(value)
    if (found < 0) throw bad()
    return found
  }
  const days = (value: unknown) => whole(value, 0)
  return {
    email: {
      enabled: flag(email.enabled),
      host: nullableText(email.host),
      port: whole(email.port),
      security: oneOf(SECURITY, email.security),
      fromAddress: nullableText(email.fromAddress),
      timeoutSeconds: whole(email.timeoutSeconds),
      maxAgeHours: whole(email.maxAgeHours),
      consoleUrl: nullableText(email.consoleUrl),
    },
    retention: {
      incidentDays: days(retention.incidentDays),
      notificationDays: days(retention.notificationDays),
      networkMeasurementDays: days(retention.networkMeasurementDays),
      snmpDays: days(retention.snmpDays),
      telemetryDays: days(retention.telemetryDays),
      absentContainerDays: days(retention.absentContainerDays),
    },
    monitoring: {
      offlineThresholdSeconds: whole(monitoring.offlineThresholdSeconds),
      thresholds: {
        resourceWarnPercent: limit(thresholds.resourceWarnPercent),
        resourceCritPercent: limit(thresholds.resourceCritPercent),
        probeLossWarnPercent: limit(thresholds.probeLossWarnPercent),
        probeLatencyWarnMs: limit(thresholds.probeLatencyWarnMs),
        targetCritFailures: limit(thresholds.targetCritFailures),
      },
    },
  }
}

export function parseSystemStatus(raw: unknown): SystemStatus {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    alertEngine: parseEngineBody(record(row.alertEngine)),
    notifier: parseNotifier(row.notifier),
    outbox: parseOutbox(row.outbox),
    environment: parseEnvironment(row.environment),
  }
}

export const getSystemStatus =
  (transport: Transport): SentinelApi['getSystemStatus'] =>
  async (options) =>
    parseSystemStatus(await transport.get('system/status/', { signal: options?.signal }))

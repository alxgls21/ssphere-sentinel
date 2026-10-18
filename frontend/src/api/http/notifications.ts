import type { SentinelApi } from '../client'
import type {
  AlertSeverity,
  NotificationPreferences,
  NotificationSettings,
  NotifierState,
  TestEmail,
  TestEmailAnswer,
  TestEmailStatus,
} from '../types'
import { flag, nullableText, nullableTime, oneOf, record, text, time } from './parse'
import type { Transport } from './transport'

/**
 * A console user's own email settings (`settings/notifications/me/`) and their test emails
 * (`settings/notifications/test-email/`). Every answer is validated and mapped by naming each
 * field; one that does not fit is a `bad_response` error. A failure is a category and the server's
 * own words for it, never a mail server's message, and no address but the account's is ever read.
 */

const SEVERITY: readonly AlertSeverity[] = ['critical', 'warning']
const TEST_STATUS: readonly TestEmailStatus[] = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'expired',
]
export const NOTIFIER_STATE: readonly NotifierState[] = [
  'running',
  'failed',
  'stale',
  'never_started',
  'disabled',
]

export function parseTestEmail(raw: unknown): TestEmail {
  const row = record(raw)
  let failure: TestEmail['failure'] = null
  if (row.failure !== null) {
    const found = record(row.failure)
    failure = { category: text(found.category), label: text(found.label) }
  }
  return {
    id: text(row.id),
    status: oneOf(TEST_STATUS, row.status),
    failure,
    createdAt: time(row.createdAt),
    expiresAt: time(row.expiresAt),
    finishedAt: nullableTime(row.finishedAt),
  }
}

function parsePreferences(raw: unknown): NotificationPreferences {
  const row = record(raw)
  return {
    enabled: flag(row.enabled),
    minSeverity: oneOf(SEVERITY, row.minSeverity),
    sendRecovery: flag(row.sendRecovery),
    updatedAt: nullableTime(row.updatedAt),
  }
}

export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const row = record(raw)
  const email = record(row.email)
  const test = record(row.testEmail)
  return {
    generatedAt: time(row.generatedAt),
    preferences: parsePreferences(row.preferences),
    account: { email: nullableText(record(row.account).email) },
    email: { available: flag(email.available), deliverable: flag(email.deliverable) },
    testEmail: {
      allowed: flag(test.allowed),
      latest: test.latest === null ? null : parseTestEmail(test.latest),
    },
  }
}

export function parseTestEmailAnswer(raw: unknown): TestEmailAnswer {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseTestEmail(row.item),
    notifier: { state: oneOf(NOTIFIER_STATE, record(row.notifier).state) },
  }
}

export const getNotificationSettings =
  (transport: Transport): SentinelApi['getNotificationSettings'] =>
  async (options) =>
    parseNotificationSettings(
      await transport.get('settings/notifications/me/', { signal: options?.signal }),
    )

/** The three preferences, named one by one: nothing else is ever sent, and the address is never one of them. */
export const saveNotificationPreferences =
  (transport: Transport): SentinelApi['saveNotificationPreferences'] =>
  async (input, options) =>
    parseNotificationSettings(
      await transport.put(
        'settings/notifications/me/',
        {
          enabled: input.enabled,
          minSeverity: input.minSeverity,
          sendRecovery: input.sendRecovery,
        },
        { signal: options?.signal },
      ),
    )

/** Asks for one test email, to the account's own address: the request names no address and has no body. */
export const requestTestEmail =
  (transport: Transport): SentinelApi['requestTestEmail'] =>
  async (options) =>
    parseTestEmailAnswer(
      await transport.post('settings/notifications/test-email/', undefined, {
        signal: options?.signal,
      }),
    )

export const getTestEmail =
  (transport: Transport): SentinelApi['getTestEmail'] =>
  async (id, options) =>
    parseTestEmailAnswer(
      await transport.get(`settings/notifications/test-email/${encodeURIComponent(id)}/`, {
        signal: options?.signal,
      }),
    )

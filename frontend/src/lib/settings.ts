import type {
  HealthStatus,
  NotifierState,
  NotifierStatus,
  TestEmail,
  TestEmailStatus,
} from '@/api/types'
import { EMPTY, formatAge, formatDuration } from './format'

/**
 * What the settings screens say in words. Every state is the API's: this only names it, and never
 * works one out. A notifier that is disabled, missing or never started is never drawn as healthy,
 * and an email failure is a category and the server's own words for it, never a mail server's message.
 */

/**
 * "20s ago", or "just now" within five seconds: never "now ago". `none` stands where there is no time.
 * `nowMs` is the clock of the data, not of the page.
 */
export function agoText(iso: string | null, nowMs: number, none: string = EMPTY): string {
  if (!iso) return none
  const age = formatAge(iso, nowMs)
  if (age === EMPTY) return none
  return age === 'now' ? 'just now' : `${age} ago`
}

/* ------------------------------------------------------------- test emails */

export const TEST_EMAIL_WORD: Record<TestEmailStatus, string> = {
  pending: 'QUEUED',
  sending: 'SENDING',
  sent: 'SENT',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  expired: 'EXPIRED',
}

/** The glyph a test email is drawn in: sent is the one healthy state; waiting is neither good nor bad. */
export const TEST_EMAIL_HEALTH: Record<TestEmailStatus, HealthStatus> = {
  pending: 'unknown',
  sending: 'unknown',
  sent: 'healthy',
  failed: 'critical',
  cancelled: 'warning',
  expired: 'warning',
}

/** Still on its way: the screen asks again only for these, and stops at the first final state. */
export const isTestEmailOpen = (status: TestEmailStatus): boolean =>
  status === 'pending' || status === 'sending'

/** What the notifier's state means for a test email that is waiting. */
export function waitingNote(state: NotifierState | null): string | null {
  switch (state) {
    case null:
    case 'running':
      return null
    case 'disabled':
      return 'This server sends no email, so nothing will take it.'
    case 'never_started':
      return 'The notifier has never run, so nothing will take it until it does.'
    case 'stale':
      return 'The notifier has stopped or is stuck, so nothing will take it until it runs again.'
    case 'failed':
      return 'The notifier is failing, so it may not be sent. It is tried once.'
  }
}

/** One sentence about a test email, from the API's status and failure category. */
export function testEmailSentence(item: TestEmail, nowMs: number): string {
  const ago = (iso: string | null) => agoText(iso, nowMs)
  switch (item.status) {
    case 'pending':
      return 'Queued: waiting for the notifier to pick it up.'
    case 'sending':
      return 'Sending: the notifier is handing it to the mail server.'
    case 'sent':
      return `Sent ${ago(item.finishedAt)}, to your account’s address.`
    case 'failed':
      return `Not sent${item.failure ? `: ${item.failure.label}` : ''}. It is tried once and not again.`
    case 'cancelled':
      return `Not sent, on purpose${item.failure ? `: ${item.failure.label}` : ''}.`
    case 'expired':
      return 'Not sent: no notifier took it in time.'
  }
}

/* ----------------------------------------------------------------- notifier */

export const NOTIFIER_WORD: Record<NotifierState, string> = {
  running: 'RUNNING',
  failed: 'FAILED',
  stale: 'STALE',
  never_started: 'NEVER STARTED',
  disabled: 'DISABLED',
}

/** Disabled is idle, never ok: nothing is being sent, whatever is queued or not. */
export const NOTIFIER_HEALTH: Record<NotifierState, HealthStatus> = {
  running: 'healthy',
  failed: 'critical',
  stale: 'warning',
  never_started: 'unknown',
  disabled: 'idle',
}

export const notifierNeedsAttention = (state: NotifierState): boolean => state !== 'running'

const NOTIFIER_ERROR = { database: 'its database', internal: 'an internal error' } as const

/** The mail-server failures a notifier records, in words. */
export const SMTP_ERROR_TEXT = {
  connection: 'could not connect to the mail server',
  timeout: 'the mail server did not answer in time',
  tls: 'TLS with the mail server failed',
  authentication: 'logging in to the mail server failed',
} as const

/** What the notifier's state means, in a sentence. `nowMs` is the clock of the data. */
export function notifierSentence(status: NotifierStatus, nowMs: number): string {
  const ago = (iso: string | null) => agoText(iso, nowMs, 'never')
  switch (status.state) {
    case 'running':
      return `Sending queued email${status.intervalSeconds ? ` every ${status.intervalSeconds} s` : ''}; its latest cycle succeeded ${ago(status.lastSuccessAt)}.`
    case 'disabled':
      return 'This server sends no email: no mail server is set, so nothing is queued and nothing is sent. That is not a healthy notifier, it is none.'
    case 'never_started':
      return 'The notifier has never completed a cycle: queued email, and test emails, wait for it.'
    case 'stale':
      return `${status.lastActiveAt ? `No sign of life for ${formatAge(status.lastActiveAt, nowMs)}` : 'No sign of life'} (more than ${formatDuration(status.staleAfterSeconds)}): it has stopped or is stuck, so queued email waits.`
    case 'failed': {
      if (status.lastSmtpError) {
        return `It could not reach the mail server ${ago(status.lastSmtpError.at)}: ${SMTP_ERROR_TEXT[status.lastSmtpError.category]}. Its email waits, and is tried again.`
      }
      if (status.lastError) {
        return `Its latest cycle failed with ${NOTIFIER_ERROR[status.lastError.category]} ${ago(status.lastError.at)}. Queued email waits.`
      }
      return 'Its latest cycle failed. Queued email waits.'
    }
  }
}

/** What the notifier itself reported about its settings: said as reported, and as unknown before its first cycle. */
export function reportedText(value: boolean | null, yes: string, no: string): string {
  return value === null ? 'not reported yet' : value ? yes : no
}

/* ------------------------------------------------------------------ outbox */

const FAILURE_TEXT: Record<string, string> = {
  connection: 'could not connect',
  timeout: 'mail server timed out',
  tls: 'TLS failed',
  authentication: 'login failed',
  deferred: 'refused for now (4xx)',
  internal: 'internal error',
  rejected: 'refused (5xx)',
  recipient_refused: 'recipient refused',
  expired: 'not sent in time',
  recipient_unavailable: 'recipient unavailable',
  not_visible: 'recipient may no longer see the incident',
  unsubscribed: 'recipient unsubscribed',
}

/** A failure category in words; one this build does not know is shown as it came. */
export const failureText = (category: string): string =>
  FAILURE_TEXT[category] ?? category.replaceAll('_', ' ')

/** The failures of the last day, most first, then by name. */
export function failureRows(
  failures: Record<string, number>,
): { category: string; count: number }[] {
  return Object.entries(failures)
    .map(([category, count]) => ({ category, count }))
    .toSorted((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

/* ------------------------------------------------------------- the account */

export const SEVERITY_CHOICES = [
  {
    value: 'critical',
    label: 'Critical only',
    hint: 'An email when an incident opens at critical.',
  },
  {
    value: 'warning',
    label: 'Warning and critical',
    hint: 'An email for every incident, warning or critical.',
  },
] as const

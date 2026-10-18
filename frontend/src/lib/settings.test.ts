import { describe, expect, it } from 'vitest'
import type { NotifierState, TestEmailStatus } from '@/api/types'
import { can, iso, NOW, notifier, testEmail } from '@/features/settings/testing'
import {
  agoText,
  failureRows,
  failureText,
  isTestEmailOpen,
  NOTIFIER_HEALTH,
  NOTIFIER_WORD,
  notifierNeedsAttention,
  notifierSentence,
  reportedText,
  SEVERITY_CHOICES,
  SMTP_ERROR_TEXT,
  TEST_EMAIL_HEALTH,
  TEST_EMAIL_WORD,
  testEmailSentence,
  waitingNote,
} from './settings'

const STATES: NotifierState[] = ['running', 'failed', 'stale', 'never_started', 'disabled']
const STATUSES: TestEmailStatus[] = ['pending', 'sending', 'sent', 'failed', 'cancelled', 'expired']

describe('agoText', () => {
  it('says an age with ago, and a moment as just now, never "now ago"', () => {
    expect(agoText(iso(20), NOW)).toBe('20s ago')
    expect(agoText(iso(3), NOW)).toBe('just now')
    expect(agoText(iso(0), NOW)).toBe('just now')
    expect(agoText(iso(7200), NOW)).toBe('2h ago')
  })

  it('reads a time ahead of the clock as just now', () => {
    expect(agoText(iso(-30), NOW)).toBe('just now')
  })

  it('says what stands for no time, an em dash unless told otherwise', () => {
    expect(agoText(null, NOW)).toBe('—')
    expect(agoText(null, NOW, 'never')).toBe('never')
    expect(agoText('not a time', NOW, 'never')).toBe('never')
  })
})

describe('capability fixtures', () => {
  it('grant exactly what is named', () => {
    expect(can('viewAlertRules')).toMatchObject({ viewAlertRules: true, createAlertRules: false })
  })
})

describe('the notifier’s state', () => {
  it('has a word and a drawing for each state the API names', () => {
    for (const state of STATES) {
      expect(NOTIFIER_WORD[state], state).toBeTruthy()
      expect(NOTIFIER_HEALTH[state], state).toBeTruthy()
    }
  })

  it('draws only a running notifier as healthy', () => {
    expect(STATES.filter((state) => NOTIFIER_HEALTH[state] === 'healthy')).toEqual(['running'])
  })

  it('draws a disabled notifier idle, never healthy, and a missing one unknown', () => {
    expect(NOTIFIER_HEALTH.disabled).toBe('idle')
    expect(NOTIFIER_HEALTH.never_started).toBe('unknown')
    expect(NOTIFIER_HEALTH.failed).toBe('critical')
    expect(NOTIFIER_HEALTH.stale).toBe('warning')
  })

  it('asks for attention in every state but running', () => {
    expect(STATES.filter(notifierNeedsAttention)).toEqual([
      'failed',
      'stale',
      'never_started',
      'disabled',
    ])
  })

  it('says a running notifier’s cycle and when it last succeeded', () => {
    expect(notifierSentence(notifier(), NOW)).toBe(
      'Sending queued email every 60 s; its latest cycle succeeded 20s ago.',
    )
  })

  it('says a cycle that just ended as just now', () => {
    expect(notifierSentence(notifier({ lastSuccessAt: iso(1) }), NOW)).toMatch(
      /succeeded just now\./,
    )
  })

  it('says a stale notifier that never gave a sign of life without a time', () => {
    expect(notifierSentence(notifier({ state: 'stale', lastActiveAt: null }), NOW)).toMatch(
      /^No sign of life \(more than 12m 0s\)/,
    )
  })

  it('says a disabled notifier is none, not a healthy one', () => {
    const sentence = notifierSentence(notifier({ state: 'disabled' }), NOW)
    expect(sentence).toMatch(/sends no email/)
    expect(sentence).toMatch(/not a healthy notifier/)
  })

  it('says a notifier that never ran has not completed a cycle, and that email waits', () => {
    expect(
      notifierSentence(notifier({ state: 'never_started', lastSuccessAt: null }), NOW),
    ).toMatch(/never completed a cycle/)
  })

  it('says a stale notifier has stopped or is stuck, with the time it has been silent', () => {
    const sentence = notifierSentence(
      notifier({ state: 'stale', stale: true, lastActiveAt: iso(1800), staleAfterSeconds: 720 }),
      NOW,
    )
    expect(sentence).toMatch(/30m/)
    expect(sentence).toMatch(/12m 0s/)
    expect(sentence).toMatch(/stopped or is stuck/)
  })

  it.each([
    ['connection', /could not connect to the mail server/],
    ['timeout', /did not answer in time/],
    ['tls', /TLS with the mail server failed/],
    ['authentication', /logging in to the mail server failed/],
  ] as const)('says a failed notifier could not reach the mail server: %s', (category, words) => {
    const sentence = notifierSentence(
      notifier({ state: 'failed', lastSmtpError: { at: iso(120), category } }),
      NOW,
    )
    expect(sentence).toMatch(words)
    expect(sentence).toMatch(/tried again/)
    expect(SMTP_ERROR_TEXT[category]).toBeTruthy()
  })

  it.each([
    ['database', /its database/],
    ['internal', /an internal error/],
  ] as const)('says a failed notifier’s own failure by category: %s', (category, words) => {
    expect(
      notifierSentence(notifier({ state: 'failed', lastError: { at: iso(60), category } }), NOW),
    ).toMatch(words)
  })

  it('says a failed notifier failed, even with no category given', () => {
    expect(notifierSentence(notifier({ state: 'failed' }), NOW)).toBe(
      'Its latest cycle failed. Queued email waits.',
    )
  })

  it('says what the notifier reported, and not-yet before its first cycle', () => {
    expect(reportedText(true, 'set', 'not set')).toBe('set')
    expect(reportedText(false, 'set', 'not set')).toBe('not set')
    expect(reportedText(null, 'set', 'not set')).toBe('not reported yet')
  })
})

describe('test emails', () => {
  it('names every status the API has, and draws only sent as healthy', () => {
    for (const status of STATUSES) expect(TEST_EMAIL_WORD[status], status).toBeTruthy()
    expect(STATUSES.filter((status) => TEST_EMAIL_HEALTH[status] === 'healthy')).toEqual(['sent'])
    expect(TEST_EMAIL_HEALTH.failed).toBe('critical')
  })

  it('is open only while queued or being sent: the screen asks again for nothing else', () => {
    expect(STATUSES.filter(isTestEmailOpen)).toEqual(['pending', 'sending'])
  })

  it('says each status in a sentence', () => {
    expect(testEmailSentence(testEmail('pending'), NOW)).toMatch(/^Queued/)
    expect(testEmailSentence(testEmail('sending'), NOW)).toMatch(/^Sending/)
    expect(testEmailSentence(testEmail('sent'), NOW)).toMatch(/^Sent 5s ago/)
    expect(testEmailSentence(testEmail('sent', { finishedAt: iso(2) }), NOW)).toMatch(
      /^Sent just now, to your/,
    )
    expect(testEmailSentence(testEmail('expired'), NOW)).toMatch(/no notifier took it in time/)
  })

  it('says a failure by the server’s own label, and that it is not tried again', () => {
    const failed = testEmail('failed', {
      failure: { category: 'timeout', label: 'The mail server did not answer in time' },
    })
    expect(testEmailSentence(failed, NOW)).toBe(
      'Not sent: The mail server did not answer in time. It is tried once and not again.',
    )
  })

  it('says a cancelled test email was stopped on purpose, with the reason', () => {
    const cancelled = testEmail('cancelled', {
      failure: { category: 'recipient_unavailable', label: 'The account can no longer receive it' },
    })
    expect(testEmailSentence(cancelled, NOW)).toBe(
      'Not sent, on purpose: The account can no longer receive it.',
    )
  })

  it('says nothing of a notifier that is running, or unknown, for a waiting email', () => {
    expect(waitingNote('running')).toBeNull()
    expect(waitingNote(null)).toBeNull()
  })

  it.each(['disabled', 'never_started', 'stale', 'failed'] as const)(
    'says what a %s notifier means for an email that is waiting',
    (state) => {
      expect(waitingNote(state)).toEqual(expect.any(String))
    },
  )
})

describe('the outbox', () => {
  it('says a failure category in words, and a category it does not know as it came', () => {
    expect(failureText('timeout')).toBe('mail server timed out')
    expect(failureText('recipient_unavailable')).toBe('recipient unavailable')
    expect(failureText('some_new_category')).toBe('some new category')
  })

  it('lists failures most first, then by name', () => {
    expect(failureRows({ tls: 1, timeout: 3, connection: 1 })).toEqual([
      { category: 'timeout', count: 3 },
      { category: 'connection', count: 1 },
      { category: 'tls', count: 1 },
    ])
    expect(failureRows({})).toEqual([])
  })
})

describe('the severity choices', () => {
  it('are the two the API takes, critical first', () => {
    expect(SEVERITY_CHOICES.map((choice) => choice.value)).toEqual(['critical', 'warning'])
  })
})

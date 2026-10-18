import { describe, expect, it, vi } from 'vitest'
import {
  getNotificationSettings,
  getTestEmail,
  parseNotificationSettings,
  parseTestEmail,
  parseTestEmailAnswer,
  requestTestEmail,
  saveNotificationPreferences,
} from './notifications'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (notification_settings.py). */
const wireTest = (over: Record<string, unknown> = {}) => ({
  id: '0b6c5b1e-2c4a-4f51-9f0e-1d3f7c0a9a11',
  status: 'pending',
  failure: null,
  createdAt: '2026-10-18T09:59:30Z',
  expiresAt: '2026-10-18T10:09:30Z',
  finishedAt: null,
  ...over,
})
const wireSettings = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  preferences: {
    enabled: true,
    minSeverity: 'warning',
    sendRecovery: true,
    updatedAt: '2026-10-17T08:00:00Z',
  },
  account: { email: 'maria@example.com' },
  email: { available: true, deliverable: true },
  testEmail: { allowed: true, latest: wireTest() },
  ...over,
})
const wireAnswer = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  item: wireTest(),
  notifier: { state: 'running' },
  ...over,
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  const put = vi.fn(async () => answer)
  return { get, post, put } as unknown as Transport & {
    get: typeof get
    post: typeof post
    put: typeof put
  }
}

describe('notification settings', () => {
  it('maps the answer onto the view-model: preferences, the account, email availability, the latest test', () => {
    expect(parseNotificationSettings(wireSettings())).toEqual({
      generatedAt: '2026-10-18T10:00:00Z',
      preferences: {
        enabled: true,
        minSeverity: 'warning',
        sendRecovery: true,
        updatedAt: '2026-10-17T08:00:00Z',
      },
      account: { email: 'maria@example.com' },
      email: { available: true, deliverable: true },
      testEmail: {
        allowed: true,
        latest: {
          id: '0b6c5b1e-2c4a-4f51-9f0e-1d3f7c0a9a11',
          status: 'pending',
          failure: null,
          createdAt: '2026-10-18T09:59:30Z',
          expiresAt: '2026-10-18T10:09:30Z',
          finishedAt: null,
        },
      },
    })
  })

  it('reads the defaults of an account that never saved: updatedAt null, no address, no test yet', () => {
    const settings = parseNotificationSettings(
      wireSettings({
        preferences: {
          enabled: false,
          minSeverity: 'critical',
          sendRecovery: false,
          updatedAt: null,
        },
        account: { email: null },
        email: { available: false, deliverable: false },
        testEmail: { allowed: false, latest: null },
      }),
    )
    expect(settings.preferences.updatedAt).toBeNull()
    expect(settings.account.email).toBeNull()
    expect(settings.email).toEqual({ available: false, deliverable: false })
    expect(settings.testEmail).toEqual({ allowed: false, latest: null })
  })

  it('reads only the fields it names: nothing else in the answer reaches the screen', () => {
    const settings = parseNotificationSettings(
      wireSettings({
        account: { email: 'maria@example.com', password: 'hunter2' },
        smtp: { password: 'secret' },
      }),
    )
    expect(JSON.stringify(settings)).not.toMatch(/hunter2|secret|smtp/)
  })

  it.each([
    [
      'an unknown severity',
      { preferences: { enabled: true, minSeverity: 'info', sendRecovery: true, updatedAt: null } },
    ],
    ['a flag that is not a boolean', { email: { available: 'yes', deliverable: true } }],
    ['an address that is not text', { account: { email: 7 } }],
    ['a missing time', { generatedAt: undefined }],
    ['a time that does not parse', { generatedAt: 'tomorrow' }],
    ['a missing test email block', { testEmail: undefined }],
  ])('refuses an answer with %s', (_what, over) => {
    expect(() => parseNotificationSettings(wireSettings(over))).toThrow(/unexpected answer/)
  })

  it('asks for the signed-in user’s own settings, with no id in the path', async () => {
    const t = transport(wireSettings())
    const settings = await getNotificationSettings(t)()
    expect(t.get).toHaveBeenCalledWith('settings/notifications/me/', { signal: undefined })
    expect(settings.account.email).toBe('maria@example.com')
  })

  it('passes the caller’s signal on', async () => {
    const t = transport(wireSettings())
    const controller = new AbortController()
    await getNotificationSettings(t)({ signal: controller.signal })
    expect(t.get).toHaveBeenCalledWith('settings/notifications/me/', { signal: controller.signal })
  })
})

describe('saving preferences', () => {
  it('puts exactly the three preferences, whatever else the caller holds', async () => {
    const t = transport(wireSettings())
    const input = {
      enabled: true,
      minSeverity: 'critical',
      sendRecovery: false,
      email: 'someone-else@example.com',
      userId: 4,
    } as unknown as Parameters<ReturnType<typeof saveNotificationPreferences>>[0]
    await saveNotificationPreferences(t)(input)
    expect(t.put).toHaveBeenCalledWith(
      'settings/notifications/me/',
      { enabled: true, minSeverity: 'critical', sendRecovery: false },
      { signal: undefined },
    )
  })

  it('answers with the settings as they now are', async () => {
    const t = transport(
      wireSettings({
        preferences: {
          enabled: false,
          minSeverity: 'critical',
          sendRecovery: false,
          updatedAt: '2026-10-18T10:00:00Z',
        },
      }),
    )
    const saved = await saveNotificationPreferences(t)({
      enabled: false,
      minSeverity: 'critical',
      sendRecovery: false,
    })
    expect(saved.preferences).toEqual({
      enabled: false,
      minSeverity: 'critical',
      sendRecovery: false,
      updatedAt: '2026-10-18T10:00:00Z',
    })
  })
})

describe('test emails', () => {
  it.each(['pending', 'sending', 'sent', 'failed', 'cancelled', 'expired'])(
    'reads the %s status',
    (status) => {
      expect(parseTestEmail(wireTest({ status })).status).toBe(status)
    },
  )

  it('refuses a status it does not know, so a screen never polls on a guess', () => {
    expect(() => parseTestEmail(wireTest({ status: 'delivered' }))).toThrow(/unexpected answer/)
  })

  it('keeps the failure as a category and the server’s own label, and nothing more', () => {
    const failed = parseTestEmail(
      wireTest({
        status: 'failed',
        finishedAt: '2026-10-18T10:00:00Z',
        failure: {
          category: 'authentication',
          label: 'Logging in to the mail server failed',
          detail: '535 5.7.8 Username and Password not accepted for smtp-user',
        },
      }),
    )
    expect(failed.failure).toEqual({
      category: 'authentication',
      label: 'Logging in to the mail server failed',
    })
    expect(JSON.stringify(failed)).not.toMatch(/535|smtp-user/)
  })

  it('reads the notifier’s state with the answer, and refuses one it does not know', () => {
    expect(
      parseTestEmailAnswer(wireAnswer({ notifier: { state: 'never_started' } })).notifier,
    ).toEqual({
      state: 'never_started',
    })
    expect(() => parseTestEmailAnswer(wireAnswer({ notifier: { state: 'sleeping' } }))).toThrow(
      /unexpected answer/,
    )
  })

  it('asks for a test email with no body and no address', async () => {
    const t = transport(wireAnswer())
    const answer = await requestTestEmail(t)()
    expect(t.post).toHaveBeenCalledWith('settings/notifications/test-email/', undefined, {
      signal: undefined,
    })
    expect(answer.item.status).toBe('pending')
  })

  it('reads one test email by its id, encoded as a path segment', async () => {
    const t = transport(wireAnswer())
    await getTestEmail(t)('a/b c')
    expect(t.get).toHaveBeenCalledWith('settings/notifications/test-email/a%2Fb%20c/', {
      signal: undefined,
    })
  })
})

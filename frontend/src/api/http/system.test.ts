import { describe, expect, it, vi } from 'vitest'
import { getSystemStatus, parseSystemStatus } from './system'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (system.py). */
const wireNotifier = (over: Record<string, unknown> = {}) => ({
  state: 'running',
  stale: false,
  staleAfterSeconds: 720,
  intervalSeconds: 60,
  startedAt: '2026-10-17T10:00:00Z',
  lastSuccessAt: '2026-10-18T09:59:40Z',
  lastAttemptAt: '2026-10-18T09:59:40Z',
  lastActiveAt: '2026-10-18T09:59:40Z',
  lastSmtpSuccessAt: '2026-10-18T09:55:00Z',
  lastCycleMs: 85,
  lastError: null,
  lastSmtpError: null,
  smtpConfigured: true,
  authenticationConfigured: true,
  ...over,
})
const wire = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-18T10:00:00Z',
  alertEngine: {
    state: 'running',
    stale: false,
    staleAfterSeconds: 180,
    intervalSeconds: 60,
    startedAt: '2026-10-17T10:00:00Z',
    lastSuccessAt: '2026-10-18T09:59:48Z',
    lastAttemptAt: '2026-10-18T09:59:48Z',
    lastCycleMs: 140,
    lastError: null,
    monitoringSince: '2026-10-17T10:05:00Z',
  },
  notifier: wireNotifier(),
  outbox: {
    pending: 2,
    sending: 1,
    oldestPendingAt: '2026-10-18T09:58:30Z',
    overdue: 0,
    last24Hours: {
      created: 14,
      sent: 12,
      failed: 1,
      cancelled: 1,
      failures: { timeout: 1, recipient_unavailable: 1 },
    },
    testEmails: { open: 1, last24Hours: { sent: 2, failed: 1 } },
  },
  environment: {
    email: {
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      fromAddress: 'sentinel@example.com',
      timeoutSeconds: 10,
      maxAgeHours: 24,
      consoleUrl: 'https://sentinel.example.com',
    },
    retention: {
      incidentDays: 365,
      notificationDays: 90,
      networkMeasurementDays: 30,
      snmpDays: 30,
      telemetryDays: 30,
      absentContainerDays: 14,
    },
    monitoring: {
      offlineThresholdSeconds: 180,
      thresholds: {
        resourceWarnPercent: 80,
        resourceCritPercent: 95,
        probeLossWarnPercent: 5,
        probeLatencyWarnMs: 150,
        targetCritFailures: 3,
      },
    },
  },
  ...over,
})

describe('the system status', () => {
  it('maps the engine, the notifier, the outbox and the deployment’s settings', () => {
    const status = parseSystemStatus(wire())
    expect(status.generatedAt).toBe('2026-10-18T10:00:00Z')
    expect(status.alertEngine).toMatchObject({
      state: 'running',
      intervalSeconds: 60,
      lastCycleMs: 140,
    })
    expect(status.alertEngine).not.toHaveProperty('generatedAt')
    expect(status.notifier).toMatchObject({
      state: 'running',
      smtpConfigured: true,
      authenticationConfigured: true,
      lastSmtpSuccessAt: '2026-10-18T09:55:00Z',
    })
    expect(status.outbox).toMatchObject({ pending: 2, sending: 1, overdue: 0 })
    expect(status.environment.email).toEqual({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      fromAddress: 'sentinel@example.com',
      timeoutSeconds: 10,
      maxAgeHours: 24,
      consoleUrl: 'https://sentinel.example.com',
    })
    expect(status.environment.retention.incidentDays).toBe(365)
    expect(status.environment.monitoring.thresholds.resourceCritPercent).toBe(95)
  })

  it('keeps the failures by category and gives every test-email status a count, zero when absent', () => {
    const { outbox } = parseSystemStatus(wire())
    expect(outbox.last24Hours.failures).toEqual({ timeout: 1, recipient_unavailable: 1 })
    expect(outbox.testEmails).toEqual({
      open: 1,
      last24Hours: { pending: 0, sending: 0, sent: 2, failed: 1, cancelled: 0, expired: 0 },
    })
  })

  it.each(['running', 'failed', 'stale', 'never_started', 'disabled'])(
    'reads the %s notifier state as itself',
    (state) => {
      expect(parseSystemStatus(wire({ notifier: wireNotifier({ state }) })).notifier.state).toBe(
        state,
      )
    },
  )

  it('reads a notifier that never ran or has email off: nothing reported, nothing invented', () => {
    const { notifier } = parseSystemStatus(
      wire({
        notifier: wireNotifier({
          state: 'never_started',
          intervalSeconds: null,
          startedAt: null,
          lastSuccessAt: null,
          lastAttemptAt: null,
          lastActiveAt: null,
          lastSmtpSuccessAt: null,
          lastCycleMs: null,
          smtpConfigured: null,
          authenticationConfigured: null,
        }),
      }),
    )
    expect(notifier).toMatchObject({
      state: 'never_started',
      intervalSeconds: null,
      lastSuccessAt: null,
      lastCycleMs: null,
      smtpConfigured: null,
      authenticationConfigured: null,
    })
  })

  it('keeps the category of a failure and a mail server failure, never a message', () => {
    const { notifier } = parseSystemStatus(
      wire({
        notifier: wireNotifier({
          state: 'failed',
          lastError: {
            at: '2026-10-18T09:59:00Z',
            category: 'database',
            message: 'password for db authentication failed',
          },
          lastSmtpError: {
            at: '2026-10-18T09:58:00Z',
            category: 'authentication',
            message: '535 bad credentials',
          },
        }),
      }),
    )
    expect(notifier.lastError).toEqual({ at: '2026-10-18T09:59:00Z', category: 'database' })
    expect(notifier.lastSmtpError).toEqual({
      at: '2026-10-18T09:58:00Z',
      category: 'authentication',
    })
    expect(JSON.stringify(notifier)).not.toMatch(/535|bad credentials|password/)
  })

  it('reads only the fields it names: a secret an answer should not hold never reaches a screen', () => {
    const raw = wire()
    const answer = {
      ...raw,
      environment: {
        ...raw.environment,
        email: { ...raw.environment.email, password: 'hunter2', user: 'smtp-user' },
      },
      secretKey: 'django-insecure-abc',
    }
    const serialized = JSON.stringify(parseSystemStatus(answer))
    expect(serialized).not.toMatch(/hunter2|smtp-user|django-insecure|password/i)
  })

  it('reads the email of a server that sends none: off, no host, no from address', () => {
    const raw = wire()
    const { environment } = parseSystemStatus(
      wire({
        environment: {
          ...raw.environment,
          email: {
            ...raw.environment.email,
            enabled: false,
            host: null,
            fromAddress: null,
            consoleUrl: null,
            security: 'none',
          },
        },
      }),
    )
    expect(environment.email).toMatchObject({
      enabled: false,
      host: null,
      fromAddress: null,
      security: 'none',
    })
  })

  it.each([
    ['a notifier state it does not know', { notifier: wireNotifier({ state: 'sleeping' }) }],
    ['a notifier with no state', { notifier: wireNotifier({ state: undefined }) }],
    ['an interval of zero', { notifier: wireNotifier({ intervalSeconds: 0 }) }],
    [
      'an unknown mail server failure category',
      {
        notifier: wireNotifier({
          lastSmtpError: { at: '2026-10-18T09:58:00Z', category: 'weather' },
        }),
      },
    ],
    ['a count that is negative', { outbox: { ...wire().outbox, pending: -1 } }],
    [
      'a failure count that is text',
      {
        outbox: {
          ...wire().outbox,
          last24Hours: { ...wire().outbox.last24Hours, failures: { timeout: 'one' } },
        },
      },
    ],
    [
      'an unknown connection security',
      {
        environment: {
          ...wire().environment,
          email: { ...wire().environment.email, security: 'ssl' },
        },
      },
    ],
    ['no outbox', { outbox: undefined }],
  ])('refuses an answer with %s', (_what, over) => {
    expect(() => parseSystemStatus(wire(over))).toThrow(/unexpected answer/)
  })

  it('asks for the status with a plain read', async () => {
    const get = vi.fn(async () => wire())
    const status = await getSystemStatus({ get } as unknown as Transport)()
    expect(get).toHaveBeenCalledWith('system/status/', { signal: undefined })
    expect(status.notifier.state).toBe('running')
  })
})

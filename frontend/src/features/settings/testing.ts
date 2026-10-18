import { NO_CAPABILITIES, type SessionCapabilities } from '@/api/auth'
import type {
  AlertRule,
  AlertRuleList,
  AlertRuleOptions,
  ChangeEffects,
  NotificationSettings,
  NotifierStatus,
  OutboxSummary,
  SystemStatus,
  TestEmail,
  TestEmailStatus,
} from '@/api/types'

/** Test fixtures only: settings, alert rules, test emails and the system status, at one fixed moment. */
export const NOW = Date.parse('2026-10-18T10:00:00Z')
export const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

/** The capabilities of an account that may do exactly these things. */
export function can(...names: (keyof SessionCapabilities)[]): SessionCapabilities {
  return { ...NO_CAPABILITIES, ...Object.fromEntries(names.map((name) => [name, true])) }
}

/** What the server says closes incidents, as it states it. */
export const CHANGE_EFFECTS: ChangeEffects = {
  enabled: { to: false, closes: 'rule_disabled', which: 'all' },
  health: { closes: 'rule_changed', which: 'all' },
  reason: { closes: 'rule_changed', which: 'all' },
  severity: { closes: 'rule_changed', which: 'all' },
  scope: { closes: 'out_of_scope', which: 'outside the new scope' },
}

export function options(over: Partial<AlertRuleOptions> = {}): AlertRuleOptions {
  return {
    generatedAt: iso(0),
    kinds: [
      {
        value: 'server',
        label: 'Server',
        conditions: [
          { health: 'critical', label: 'Critical', reasons: ['offline', 'resources'] },
          { health: 'warning', label: 'Warning', reasons: ['resources', 'status_warning'] },
        ],
      },
      {
        value: 'device',
        label: 'SNMP device',
        conditions: [
          { health: 'critical', label: 'Critical', reasons: ['unreachable', 'no_poll'] },
          { health: 'unknown', label: 'Unknown', reasons: [] },
        ],
      },
    ],
    severities: [
      { value: 'critical', label: 'Critical' },
      { value: 'warning', label: 'Warning' },
    ],
    defaults: { enabled: true, activationSeconds: 60, recoverySeconds: 120 },
    limits: { maxDurationSeconds: 86400, nameMaxLength: 80, descriptionMaxLength: 200 },
    changeEffects: CHANGE_EFFECTS,
    ...over,
  }
}

/** One alert rule, one an operator made unless a test gives it a key. */
export function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    key: null,
    name: 'Device unreachable',
    description: 'Opens when a device stops answering.',
    enabled: true,
    kind: 'device',
    health: 'critical',
    reason: 'unreachable',
    severity: 'critical',
    activationSeconds: 60,
    recoverySeconds: 120,
    scope: { type: 'all', customerId: null, customerName: null, siteId: null, siteName: null },
    openIncidents: 0,
    createdAt: iso(86400 * 30),
    updatedAt: iso(3600),
    version: 3,
    canEdit: true,
    ...over,
  }
}

export function ruleList(
  items: AlertRule[],
  over: Partial<Omit<AlertRuleList, 'items'>> = {},
): AlertRuleList {
  return {
    generatedAt: iso(0),
    items,
    page: { number: 1, size: 25, total: items.length, pages: 1 },
    counts: {
      enabled: items.filter((entry) => entry.enabled).length,
      disabled: items.filter((entry) => !entry.enabled).length,
    },
    scopeTotal: items.length,
    ...over,
  }
}

export function testEmail(
  status: TestEmailStatus = 'pending',
  over: Partial<TestEmail> = {},
): TestEmail {
  const final = status !== 'pending' && status !== 'sending'
  return {
    id: 'test-1',
    status,
    failure: null,
    createdAt: iso(30),
    expiresAt: new Date(NOW + 570_000).toISOString(),
    finishedAt: final ? iso(5) : null,
    ...over,
  }
}

export function notificationSettings(
  over: {
    enabled?: boolean
    minSeverity?: 'critical' | 'warning'
    sendRecovery?: boolean
    updatedAt?: string | null
    email?: string | null
    available?: boolean
    allowed?: boolean
    latest?: TestEmail | null
  } = {},
): NotificationSettings {
  const email = over.email === undefined ? 'maria@example.com' : over.email
  const available = over.available ?? true
  return {
    generatedAt: iso(0),
    preferences: {
      enabled: over.enabled ?? false,
      minSeverity: over.minSeverity ?? 'critical',
      sendRecovery: over.sendRecovery ?? false,
      updatedAt: over.updatedAt === undefined ? null : over.updatedAt,
    },
    account: { email },
    email: { available, deliverable: available && email !== null },
    testEmail: { allowed: over.allowed ?? true, latest: over.latest ?? null },
  }
}

export function notifier(over: Partial<NotifierStatus> = {}): NotifierStatus {
  return {
    state: 'running',
    stale: false,
    staleAfterSeconds: 720,
    intervalSeconds: 60,
    startedAt: iso(86400),
    lastSuccessAt: iso(20),
    lastAttemptAt: iso(20),
    lastActiveAt: iso(20),
    lastSmtpSuccessAt: iso(300),
    lastCycleMs: 85,
    lastError: null,
    lastSmtpError: null,
    smtpConfigured: true,
    authenticationConfigured: true,
    ...over,
  }
}

export function outbox(over: Partial<OutboxSummary> = {}): OutboxSummary {
  return {
    pending: 2,
    sending: 0,
    oldestPendingAt: iso(90),
    overdue: 0,
    last24Hours: { created: 14, sent: 12, failed: 1, cancelled: 1, failures: { timeout: 1 } },
    testEmails: {
      open: 0,
      last24Hours: { pending: 0, sending: 0, sent: 2, failed: 0, cancelled: 0, expired: 0 },
    },
    ...over,
  }
}

export function systemStatus(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    generatedAt: iso(0),
    alertEngine: {
      state: 'running',
      stale: false,
      staleAfterSeconds: 180,
      intervalSeconds: 60,
      startedAt: iso(86400),
      lastSuccessAt: iso(12),
      lastAttemptAt: iso(12),
      lastCycleMs: 140,
      lastError: null,
      monitoringSince: iso(86000),
    },
    notifier: notifier(),
    outbox: outbox(),
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
  }
}

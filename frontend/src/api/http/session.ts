import type { AuthClient, ConsoleSession, PublishedThresholds, SessionCapabilities } from '../auth'
import { ApiError } from '../errors'
import type { ScopeOptions } from '../types'
import type { Transport } from './transport'

const bad = () => new ApiError('The server sent an unexpected answer.', null, 'bad_response')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validates the session payload: the shape of a network answer is never trusted. */
export function parseSession(raw: unknown): ConsoleSession {
  if (!isRecord(raw) || typeof raw.authenticated !== 'boolean') throw bad()
  const { csrfToken, reason, user, access } = raw
  if (typeof csrfToken !== 'string' || csrfToken === '') throw bad()
  if (reason !== null && reason !== 'no_console_access') throw bad()
  if (!raw.authenticated) {
    return { authenticated: false, reason, user: null, allCustomers: false }
  }
  if (
    !isRecord(user) ||
    typeof user.username !== 'string' ||
    typeof user.displayName !== 'string' ||
    !isRecord(access) ||
    typeof access.allCustomers !== 'boolean'
  ) {
    throw bad()
  }
  return {
    authenticated: true,
    reason: null,
    user: { username: user.username, displayName: user.displayName },
    allCustomers: access.allCustomers,
    // The thresholds only matter to the screens that judge; a session without them signs in all the same.
    ...(raw.thresholds === null || raw.thresholds === undefined
      ? {}
      : { thresholds: parseThresholds(raw.thresholds) }),
    // An answer without capabilities (an older server) offers nothing: the screens never guess a right.
    ...(raw.capabilities === null || raw.capabilities === undefined
      ? {}
      : { capabilities: parseCapabilities(raw.capabilities) }),
  }
}

function parseCapabilities(raw: unknown): SessionCapabilities {
  if (!isRecord(raw)) throw bad()
  const flag = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw bad()
    return value
  }
  return {
    acknowledgeIncidents: flag(raw.acknowledgeIncidents),
    viewAlertRules: flag(raw.viewAlertRules),
    createAlertRules: flag(raw.createAlertRules),
    editAlertRules: flag(raw.editAlertRules),
    manageOwnNotifications: flag(raw.manageOwnNotifications),
    sendTestEmail: flag(raw.sendTestEmail),
    viewSystemStatus: flag(raw.viewSystemStatus),
  }
}

function parseThresholds(raw: unknown): PublishedThresholds {
  if (!isRecord(raw)) throw bad()
  const limit = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw bad()
    return value
  }
  return {
    resourceWarnPercent: limit(raw.resourceWarnPercent),
    resourceCritPercent: limit(raw.resourceCritPercent),
    probeLossWarnPercent: limit(raw.probeLossWarnPercent),
    probeLatencyWarnMs: limit(raw.probeLatencyWarnMs),
    targetCritFailures: limit(raw.targetCritFailures),
  }
}

export function parseScope(raw: unknown): ScopeOptions {
  if (!isRecord(raw) || !Array.isArray(raw.customers) || !Array.isArray(raw.sites)) throw bad()
  const text = (value: unknown): string => {
    if (typeof value !== 'string') throw bad()
    return value
  }
  return {
    customers: raw.customers.map((row: unknown) => {
      if (!isRecord(row)) throw bad()
      return { id: text(row.id), name: text(row.name) }
    }),
    sites: raw.sites.map((row: unknown) => {
      if (!isRecord(row)) throw bad()
      return { id: text(row.id), customerId: text(row.customerId), name: text(row.name) }
    }),
  }
}

/** The sign-in, sign-out and session endpoints (the transport keeps the CSRF token current). */
export function createAuthClient(transport: Transport): AuthClient {
  return {
    getSession: async (signal) => parseSession(await transport.get('session/', { signal })),
    signIn: async (username, password, signal) =>
      parseSession(await transport.post('auth/login/', { username, password }, { signal })),
    signOut: async (signal) => parseSession(await transport.post('auth/logout/', {}, { signal })),
  }
}

export const getScopeOptions =
  (transport: Transport) =>
  async (signal?: AbortSignal): Promise<ScopeOptions> =>
    parseScope(await transport.get('scope/', { signal }))

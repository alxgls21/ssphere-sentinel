import type { SentinelApi } from '../client'
import type {
  AuditChange,
  AuditEntry,
  AuditLog,
  AuditLogOptions,
  AuditOption,
  AuditValue,
} from '../types'
import { parsePage } from './lists'
import { array, bad, number, record, text, time, whole } from './parse'
import { pageText, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's audit trail (`audit-log/`): one page of entries, newest first, with the actions
 * and the kinds of object the filters may ask for. Every answer is validated by naming each field;
 * a recorded value is what JSON can hold (text, numbers, booleans, null, lists of those) and
 * nothing else, as the server records it.
 */

function auditValue(value: unknown): AuditValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return number(value)
  if (Array.isArray(value)) return value.map(auditValue)
  throw bad()
}

function parseChanges(raw: unknown): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {}
  for (const [field, value] of Object.entries(record(raw))) {
    const change = record(value)
    if (!('before' in change) || !('after' in change)) throw bad()
    changes[field] = { before: auditValue(change.before), after: auditValue(change.after) }
  }
  return changes
}

export function parseAuditEntry(raw: unknown): AuditEntry {
  const row = record(raw)
  const actor = record(row.actor)
  return {
    id: whole(row.id, 1),
    at: time(row.at),
    actor: { id: actor.id === null ? null : whole(actor.id, 1), username: text(actor.username) },
    action: text(row.action),
    actionLabel: text(row.actionLabel),
    targetType: text(row.targetType),
    targetTypeLabel: text(row.targetTypeLabel),
    targetId: text(row.targetId),
    targetName: text(row.targetName),
    changes: parseChanges(row.changes),
  }
}

function parseOption(raw: unknown): AuditOption {
  const row = record(raw)
  return { value: text(row.value), label: text(row.label) }
}

export function parseAuditLog(raw: unknown): AuditLog {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseAuditEntry),
    page: parsePage(row.page),
    scopeTotal: whole(row.scopeTotal),
    actions: array(row.actions).map(parseOption),
    targetTypes: array(row.targetTypes).map(parseOption),
  }
}

/** Only what narrows the list is sent; an empty filter is no filter. */
function listQuery(options: AuditLogOptions): Record<string, string | undefined> {
  return {
    q: searchText(options.q),
    actor: options.actor === undefined ? undefined : String(options.actor),
    action: options.action || undefined,
    targetType: options.targetType || undefined,
    targetId: options.targetId?.trim() || undefined,
    page: pageText(options.page),
    pageSize: pageText(options.pageSize),
  }
}

export const listAuditLog =
  (transport: Transport): SentinelApi['listAuditLog'] =>
  async (options = {}) =>
    parseAuditLog(
      await transport.get('audit-log/', { signal: options.signal, query: listQuery(options) }),
    )

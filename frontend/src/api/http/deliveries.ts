import type { SentinelApi } from '../client'
import type {
  AlertSeverity,
  DeliveryItem,
  DeliveryKind,
  DeliveryList,
  DeliveryStatus,
} from '../types'
import { nullableTime, oneOf, record, text, time, whole } from './parse'
import { notAll, pageText, parseRecordList, searchText } from './records'
import type { Transport } from './transport'

/**
 * The incident email log (`notifications/`): every email, what became of it, and why it did not go. An
 * email carries no address, and a failure is a category and the server's words, never a mail server's
 * message. Every answer is validated; one that does not fit is a `bad_response` error.
 */

const STATUS: readonly DeliveryStatus[] = ['pending', 'sending', 'sent', 'failed', 'cancelled']
const KIND: readonly DeliveryKind[] = ['opened', 'recovered']
const SEVERITY: readonly AlertSeverity[] = ['critical', 'warning']

function parseItem(raw: unknown): DeliveryItem {
  const row = record(raw)
  const recipient = record(row.recipient)
  const incident = record(row.incident)
  const failure = row.failure === null ? null : record(row.failure)
  return {
    id: whole(row.id, 1),
    kind: oneOf(KIND, row.kind),
    status: oneOf(STATUS, row.status),
    failure:
      failure === null ? null : { category: text(failure.category), label: text(failure.label) },
    recipient: {
      id: recipient.id === null ? null : whole(recipient.id, 1),
      username: text(recipient.username),
    },
    incident: {
      id: text(incident.id),
      ruleName: text(incident.ruleName),
      entityKind: text(incident.entityKind),
      entityLabel: text(incident.entityLabel),
      severity: oneOf(SEVERITY, incident.severity),
    },
    attempts: whole(row.attempts),
    createdAt: time(row.createdAt),
    lastAttemptAt: nullableTime(row.lastAttemptAt),
    nextAttemptAt: nullableTime(row.nextAttemptAt),
    sentAt: nullableTime(row.sentAt),
  }
}

export function parseDeliveryList(raw: unknown): DeliveryList {
  const list = parseRecordList(raw, parseItem)
  const row = record(raw)
  const counts = record(row.counts)
  return {
    ...list,
    counts: {
      pending: whole(counts.pending),
      sending: whole(counts.sending),
      sent: whole(counts.sent),
      failed: whole(counts.failed),
      cancelled: whole(counts.cancelled),
    },
    retentionDays: whole(row.retentionDays, 1),
  }
}

export const listDeliveries =
  (transport: Transport): SentinelApi['listDeliveries'] =>
  async (options = {}) =>
    parseDeliveryList(
      await transport.get('notifications/', {
        signal: options.signal,
        query: {
          q: searchText(options.q),
          status: notAll(options.status),
          kind: notAll(options.kind),
          incident: options.incident,
          recipient: pageText(options.recipient),
          sort: options.sort,
          dir: options.dir,
          page: pageText(options.page),
          pageSize: pageText(options.pageSize),
        },
      }),
    )

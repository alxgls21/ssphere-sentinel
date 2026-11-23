import type {
  DeliveryItem,
  DeliveryKindFilter,
  DeliveryListOptions,
  DeliverySortKey,
  DeliveryStatus,
  DeliveryStatusFilter,
  HealthStatus,
  SortDirection,
} from '@/api/types'
import { formatStamp, type Timezone } from '@/lib/format'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE } from './adminModel'

/**
 * What the email log asks for and says: the list query (search, status, kind, sort, page, and the
 * incident or recipient it is narrowed to), the word and the glyph of each state, and what became of an
 * email in a sentence. Pure, so it is tested without a screen.
 */

export interface DeliveriesQuery {
  q: string
  status: DeliveryStatusFilter
  kind: DeliveryKindFilter
  sort: DeliverySortKey
  dir: SortDirection
  page: number
  /** Only the emails of this incident, or of this account (a whole number). */
  incident: string
  recipient: string
}

export const DEFAULT_DELIVERIES_QUERY: DeliveriesQuery = {
  q: '',
  status: 'all',
  kind: 'all',
  sort: 'created',
  dir: 'desc',
  page: 1,
  incident: '',
  recipient: '',
}

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'sending',
  'sent',
  'failed',
  'cancelled',
]
const STATUS_FILTERS: readonly DeliveryStatusFilter[] = ['all', ...DELIVERY_STATUSES]
const KIND_FILTERS: readonly DeliveryKindFilter[] = ['all', 'opened', 'recovered']
export const DELIVERY_SORT_KEYS: readonly DeliverySortKey[] = ['created', 'status', 'recipient']
export const DELIVERY_SORT_LABEL: Record<DeliverySortKey, string> = {
  created: 'When',
  status: 'Status',
  recipient: 'Recipient',
}
/** The newest first; A to Z for the others. */
export const DELIVERY_FIRST_DIR: Record<DeliverySortKey, SortDirection> = {
  created: 'desc',
  status: 'asc',
  recipient: 'asc',
}

export function parseDeliveriesQuery(params: URLSearchParams): DeliveriesQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const status = params.get('status')
  const kind = params.get('kind')
  const recipient = params.get('recipient') ?? ''
  const key = isOneOf(DELIVERY_SORT_KEYS, sort) ? sort : DEFAULT_DELIVERIES_QUERY.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(STATUS_FILTERS, status) ? status : 'all',
    kind: isOneOf(KIND_FILTERS, kind) ? kind : 'all',
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : DELIVERY_FIRST_DIR[key],
    page: wholePage(params.get('page')),
    incident: params.get('incident') ?? '',
    recipient: /^\d{1,10}$/.test(recipient) ? recipient : '',
  }
}

export function writeDeliveriesQuery(
  params: URLSearchParams,
  query: DeliveriesQuery,
): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'status', query.status, query.status === 'all')
  setQueryParam(next, 'kind', query.kind, query.kind === 'all')
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_DELIVERIES_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === DELIVERY_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === 1)
  setQueryParam(next, 'incident', query.incident, query.incident === '')
  setQueryParam(next, 'recipient', query.recipient, query.recipient === '')
  return next
}

export const nextDeliveriesSort = (
  query: DeliveriesQuery,
  key: DeliverySortKey,
): Pick<DeliveriesQuery, 'sort' | 'dir'> => nextListSort(query, key, DELIVERY_FIRST_DIR)

export const deliveriesRequest = (query: DeliveriesQuery, q: string): DeliveryListOptions => ({
  q,
  status: query.status,
  kind: query.kind,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
  ...(query.incident === '' ? {} : { incident: query.incident }),
  ...(query.recipient === '' ? {} : { recipient: Number(query.recipient) }),
})

export const DELIVERY_WORD: Record<DeliveryStatus, string> = {
  pending: 'QUEUED',
  sending: 'SENDING',
  sent: 'SENT',
  failed: 'FAILED',
  cancelled: 'NOT SENT',
}

/** The glyph a state wears: sent is the one healthy state; waiting is neither good nor bad. */
export const DELIVERY_HEALTH: Record<DeliveryStatus, HealthStatus> = {
  pending: 'unknown',
  sending: 'unknown',
  sent: 'healthy',
  failed: 'critical',
  cancelled: 'idle',
}

export const KIND_WORD = { opened: 'Opened', recovered: 'Recovered' } as const

/** What became of an email, in a sentence, from the server's own words for a failure. */
export function deliverySentence(item: DeliveryItem, tz: Timezone, nowMs: number): string {
  const when = (iso: string) => formatStamp(Date.parse(iso), tz, nowMs)
  const why = item.failure?.label
  switch (item.status) {
    case 'sent':
      return item.sentAt ? `Sent ${when(item.sentAt)}.` : 'Sent.'
    case 'sending':
      return 'Being sent now.'
    case 'pending':
      if (why && item.nextAttemptAt) {
        return `The last attempt failed (${why}). Tried again ${when(item.nextAttemptAt)}.`
      }
      return item.nextAttemptAt
        ? `Waiting to be sent, ${when(item.nextAttemptAt)}.`
        : 'Waiting to be sent.'
    case 'failed':
      return why ? `Not delivered: ${why}.` : 'Not delivered.'
    case 'cancelled':
      return why ? `Not sent, on purpose: ${why}.` : 'Not sent, on purpose.'
  }
}

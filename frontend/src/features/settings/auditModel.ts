import type { AuditChange, AuditLogOptions, AuditValue } from '@/api/types'
import { setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE } from './adminModel'

/**
 * What the audit log asks for, and how a recorded change reads. The entries, their order and the
 * filters offered are the console API's. Pure, so it is tested without a screen.
 */

export interface AuditQuery {
  q: string
  /** One of the actions the API offers, or '' for any. */
  action: string
  /** One of the kinds of object the API offers, or '' for any. */
  targetType: string
  /** 1-based. */
  page: number
}

export const DEFAULT_AUDIT_QUERY: AuditQuery = { q: '', action: '', targetType: '', page: 1 }

/** A filter value from the URL is kept only if it looks like one of the API's own keys. */
const KEY = /^[a-z_]{1,48}$/

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const action = params.get('action') ?? ''
  const targetType = params.get('targetType') ?? ''
  return {
    q: params.get('q') ?? '',
    action: KEY.test(action) ? action : '',
    targetType: KEY.test(targetType) ? targetType : '',
    page: wholePage(params.get('page')),
  }
}

export function writeAuditQuery(params: URLSearchParams, query: AuditQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'action', query.action, query.action === '')
  setQueryParam(next, 'targetType', query.targetType, query.targetType === '')
  setQueryParam(next, 'page', String(query.page), query.page === DEFAULT_AUDIT_QUERY.page)
  return next
}

export const auditRequest = (query: AuditQuery, q: string): AuditLogOptions => ({
  q,
  action: query.action,
  targetType: query.targetType,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

export const isDefaultAuditView = (query: AuditQuery): boolean =>
  query.q.trim() === '' && query.action === '' && query.targetType === ''

/** A recorded value in words: nothing, yes or no, a list, or the value itself. */
export function valueText(value: AuditValue): string {
  if (value === null) return 'none'
  if (value === true) return 'yes'
  if (value === false) return 'no'
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(valueText).join(', ')
  if (value === '') return 'blank'
  return String(value)
}

export interface ChangeLine {
  field: string
  before: string
  after: string
}

/** The changes of an entry, one line each, in the order the API recorded them. */
export function changeLines(changes: Record<string, AuditChange>): ChangeLine[] {
  return Object.entries(changes).map(([field, change]) => ({
    field,
    before: valueText(change.before),
    after: valueText(change.after),
  }))
}

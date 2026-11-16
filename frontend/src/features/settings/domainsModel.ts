import type {
  DomainListOptions,
  DomainSortKey,
  DomainStatus,
  DomainStatusFilter,
  DomainVerification,
  SortDirection,
} from '@/api/types'
import type { DisplayStatus } from '@/lib/status'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE } from './adminModel'

/**
 * What the Domains screens say and ask: the list query (search, status, sort, page), the words and
 * the status of each state, the check made before a domain is added, and what a verification found
 * in a sentence. Pure, so it is tested without a screen.
 */

export interface DomainsQuery {
  q: string
  status: DomainStatusFilter
  sort: DomainSortKey
  dir: SortDirection
  page: number
}

export const DEFAULT_DOMAINS_QUERY: DomainsQuery = {
  q: '',
  status: 'all',
  sort: 'name',
  dir: 'asc',
  page: 1,
}
export const DOMAIN_SORT_KEYS: readonly DomainSortKey[] = ['name', 'customer', 'status', 'created']
export const DOMAIN_SORT_LABEL: Record<DomainSortKey, string> = {
  name: 'Domain',
  customer: 'Customer',
  status: 'Status',
  created: 'Added',
}
/** The server's own first direction for each column. */
export const DOMAIN_FIRST_DIR: Record<DomainSortKey, SortDirection> = {
  name: 'asc',
  customer: 'asc',
  status: 'asc',
  created: 'desc',
}
export const DOMAIN_STATUSES: readonly DomainStatus[] = [
  'pending',
  'verified',
  'degraded',
  'suspended',
]
const FILTERS: readonly DomainStatusFilter[] = ['all', ...DOMAIN_STATUSES]

export function parseDomainsQuery(params: URLSearchParams): DomainsQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const status = params.get('status')
  const key = isOneOf(DOMAIN_SORT_KEYS, sort) ? sort : DEFAULT_DOMAINS_QUERY.sort
  return {
    q: params.get('q') ?? '',
    status: isOneOf(FILTERS, status) ? status : 'all',
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : DOMAIN_FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

/** Writes a query into URL params, omitting defaults. Other params are kept. */
export function writeDomainsQuery(params: URLSearchParams, query: DomainsQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'status', query.status, query.status === 'all')
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_DOMAINS_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === DOMAIN_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === 1)
  return next
}

export const nextDomainsSort = (
  query: DomainsQuery,
  key: DomainSortKey,
): Pick<DomainsQuery, 'sort' | 'dir'> => nextListSort(query, key, DOMAIN_FIRST_DIR)

export const domainsRequest = (query: DomainsQuery, q: string): DomainListOptions => ({
  q,
  status: query.status,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

export const STATUS_WORD: Record<DomainStatus, string> = {
  pending: 'PENDING',
  verified: 'VERIFIED',
  degraded: 'DEGRADED',
  suspended: 'SUSPENDED',
}

/** The health glyph and tint a state wears: a word always comes with it. */
export const STATUS_DISPLAY: Record<DomainStatus, DisplayStatus> = {
  pending: 'unknown',
  verified: 'healthy',
  degraded: 'warning',
  suspended: 'critical',
}

export const STATUS_MEANING: Record<DomainStatus, string> = {
  pending: 'Waiting for the record to be added and found.',
  verified: 'The record was found: the domain is monitored.',
  degraded: 'Verified before; the latest check did not find the record.',
  suspended: 'Monitoring is stopped for this domain.',
}

/** The domain is added as typed; the server normalizes it. Only an empty or absurd name is refused here. */
export const DOMAIN_NAME_MAX = 253
export const DOMAIN_FIELDS = ['customerId', 'name'] as const
export type DomainField = (typeof DOMAIN_FIELDS)[number]

export interface DomainDraft {
  customerId: string
  name: string
}
export const EMPTY_DOMAIN: DomainDraft = { customerId: '', name: '' }

export function validateDomain(draft: DomainDraft): Partial<Record<DomainField, string[]>> {
  const errors: Partial<Record<DomainField, string[]>> = {}
  if (draft.customerId === '') errors.customerId = ['Choose the customer this domain belongs to.']
  const name = draft.name.trim()
  if (name === '') errors.name = ['Enter the domain, for example example.com.']
  else if (name.length > DOMAIN_NAME_MAX) errors.name = [`At most ${DOMAIN_NAME_MAX} characters.`]
  return errors
}

export const domainInput = (draft: DomainDraft) => ({
  customerId: draft.customerId,
  name: draft.name.trim(),
})

/** A verification is over when it is done or expired; until then the page keeps asking. */
export const verificationOver = (verification: DomainVerification): boolean =>
  verification.status === 'done' || verification.status === 'expired'

/** What a verification found, in one sentence, from the server's own words. */
export function verificationSentence(verification: DomainVerification): string {
  if (verification.status === 'pending') return 'Waiting for the verifier to pick the request up.'
  if (verification.status === 'running') return 'The verifier is asking the domain’s name servers.'
  if (verification.status === 'expired')
    return 'No verifier took this request in time. Ask again once the verifier is running.'
  const outcome = verification.outcome?.label ?? 'No result'
  return verification.detail ? `${outcome}: ${verification.detail.label}.` : `${outcome}.`
}

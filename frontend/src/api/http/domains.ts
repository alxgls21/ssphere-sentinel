import type { SentinelApi } from '../client'
import type {
  Choice,
  DomainDetail,
  DomainList,
  DomainRecord,
  DomainStatus,
  DomainVerification,
  VerificationAnswer,
  VerificationStatus,
  VerifierState,
} from '../types'
import { array, bad, nullableTime, number, oneOf, record, text, time } from './parse'
import { body, notAll, pageText, parseRecordList, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's monitored domains: the list (`domains/`), one domain with the DNS record to add
 * (`domains/<id>/`), adding one (POST `domains/`), asking for a verification (POST `domains/<id>/verify/`)
 * and reading one (`domains/<id>/verifications/<id>/`). A domain is never changed or deleted here.
 * Every answer is validated; what a write carries is named field by field.
 */

const STATUS: readonly DomainStatus[] = ['pending', 'verified', 'degraded', 'suspended']
const VERIFICATION: readonly VerificationStatus[] = ['pending', 'running', 'done', 'expired']
const VERIFIER: readonly VerifierState[] = ['never_started', 'running', 'failed', 'stale']

function parseChoice(raw: unknown): Choice | null {
  if (raw === null) return null
  const row = record(raw)
  return { value: text(row.value), label: text(row.label) }
}

function parseDomain(raw: unknown): DomainRecord {
  const row = record(raw)
  const customer = record(row.customer)
  return {
    id: text(row.id),
    name: text(row.name),
    displayName: text(row.displayName),
    customer: { id: text(customer.id), name: text(customer.name) },
    status: oneOf(STATUS, row.status),
    verifiedAt: nullableTime(row.verifiedAt),
    lastVerifiedAt: nullableTime(row.lastVerifiedAt),
    lastCheckedAt: nullableTime(row.lastCheckedAt),
    lastOutcome: parseChoice(row.lastOutcome ?? null),
    createdAt: time(row.createdAt),
    createdBy: text(row.createdBy),
    version: number(row.version),
  }
}

function parseEvidence(raw: unknown): DomainVerification['evidence'] {
  if (raw === null || raw === undefined) return null
  const row = record(raw)
  return {
    zone: text(row.zone),
    aliases: array(row.aliases).map(text),
    nameserverCount: number(row.nameserverCount),
    nameservers: array(row.nameservers).map((entry) => {
      const server = record(entry)
      return { name: text(server.name), address: text(server.address), result: text(server.result) }
    }),
  }
}

export function parseVerification(raw: unknown): DomainVerification {
  const row = record(raw)
  return {
    id: text(row.id),
    domainId: text(row.domainId),
    status: oneOf(VERIFICATION, row.status),
    outcome: parseChoice(row.outcome ?? null),
    detail: parseChoice(row.detail ?? null),
    requestedBy: text(row.requestedBy),
    createdAt: time(row.createdAt),
    expiresAt: time(row.expiresAt),
    startedAt: nullableTime(row.startedAt),
    finishedAt: nullableTime(row.finishedAt),
    evidence: parseEvidence(row.evidence),
  }
}

export function parseDomainDetail(raw: unknown): DomainDetail {
  const row = record(raw)
  const item = record(row.item)
  const rec = record(item.record)
  const type = text(rec.type)
  if (type === '') throw bad()
  return {
    generatedAt: time(row.generatedAt),
    item: parseDomain(item),
    record: { type, name: text(rec.name), value: text(rec.value) },
    latestVerification:
      item.latestVerification === null || item.latestVerification === undefined
        ? null
        : parseVerification(item.latestVerification),
  }
}

export function parseVerificationAnswer(raw: unknown): VerificationAnswer {
  const row = record(raw)
  return {
    generatedAt: time(row.generatedAt),
    item: parseVerification(row.item),
    verifier: { state: oneOf(VERIFIER, record(row.verifier).state) },
  }
}

export function parseDomainList(raw: unknown): DomainList {
  const list = parseRecordList(raw, parseDomain)
  const counts = record(record(raw).counts)
  const count = (status: DomainStatus) => {
    const value = number(counts[status])
    if (!Number.isInteger(value) || value < 0) throw bad()
    return value
  }
  return {
    ...list,
    counts: {
      pending: count('pending'),
      verified: count('verified'),
      degraded: count('degraded'),
      suspended: count('suspended'),
    },
  }
}

const domainPath = (id: string) => `domains/${encodeURIComponent(id)}/`

export const listDomains =
  (transport: Transport): SentinelApi['listDomains'] =>
  async (options = {}) =>
    parseDomainList(
      await transport.get('domains/', {
        signal: options.signal,
        query: {
          q: searchText(options.q),
          status: notAll(options.status),
          customer: options.customer,
          sort: options.sort,
          dir: options.dir,
          page: pageText(options.page),
          pageSize: pageText(options.pageSize),
        },
      }),
    )

export const getDomain =
  (transport: Transport): SentinelApi['getDomain'] =>
  async (id, options) =>
    parseDomainDetail(await transport.get(domainPath(id), { signal: options?.signal }))

export const createDomain =
  (transport: Transport): SentinelApi['createDomain'] =>
  async (input, options) =>
    parseDomainDetail(
      await transport.post('domains/', body({ customerId: input.customerId, name: input.name }), {
        signal: options?.signal,
      }),
    )

export const verifyDomain =
  (transport: Transport): SentinelApi['verifyDomain'] =>
  async (id, options) =>
    parseVerificationAnswer(
      await transport.post(`${domainPath(id)}verify/`, {}, { signal: options?.signal }),
    )

export const getDomainVerification =
  (transport: Transport): SentinelApi['getDomainVerification'] =>
  async (domainId, verificationId, options) =>
    parseVerificationAnswer(
      await transport.get(
        `${domainPath(domainId)}verifications/${encodeURIComponent(verificationId)}/`,
        {
          signal: options?.signal,
        },
      ),
    )

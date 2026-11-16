import { describe, expect, it, vi } from 'vitest'
import {
  createDomain,
  getDomain,
  getDomainVerification,
  listDomains,
  verifyDomain,
} from './domains'
import type { Transport } from './transport'

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  return { get, post } as unknown as Transport & { get: typeof get; post: typeof post }
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  name: 'xn--bcher-kva.example',
  displayName: 'bücher.example',
  customer: { id: 'c1', name: 'Acme' },
  status: 'verified',
  verifiedAt: '2026-10-17T10:00:00.000Z',
  lastVerifiedAt: '2026-10-17T10:00:00.000Z',
  lastCheckedAt: '2026-10-17T10:00:00.000Z',
  lastOutcome: { value: 'verified', label: 'Verified' },
  createdAt: '2026-10-16T10:00:00.000Z',
  createdBy: 'maria',
  version: 3,
  ...over,
})
const verification = (over: Record<string, unknown> = {}) => ({
  id: 'v1',
  domainId: 'd1',
  status: 'done',
  outcome: { value: 'verified', label: 'Verified' },
  detail: null,
  requestedBy: 'maria',
  createdAt: '2026-10-17T10:00:00.000Z',
  expiresAt: '2026-10-17T10:10:00.000Z',
  startedAt: '2026-10-17T10:00:01.000Z',
  finishedAt: '2026-10-17T10:00:02.000Z',
  evidence: {
    zone: 'example',
    aliases: [],
    nameserverCount: 1,
    nameservers: [{ name: 'ns1', address: '192.0.2.1', result: 'found' }],
  },
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:00.000Z',
  items: [row()],
  page: { number: 1, size: 50, total: 1, pages: 1 },
  counts: { pending: 0, verified: 1, degraded: 0, suspended: 0 },
  scopeTotal: 1,
  ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:00.000Z',
  item: {
    ...row(),
    record: { type: 'TXT', name: '_ssphere-sentinel.x', value: 'ssphere-verification=t' },
    latestVerification: verification(),
    ...over,
  },
})

describe('domains list', () => {
  it('asks with what differs from the defaults and reads the page, the counts and the choices', async () => {
    const t = transport(list())
    const result = await listDomains(t)({
      q: ' acme ',
      status: 'verified',
      customer: 'c1',
      sort: 'created',
      dir: 'desc',
      page: 2,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('domains/', {
      signal: undefined,
      query: {
        q: 'acme',
        status: 'verified',
        customer: 'c1',
        sort: 'created',
        dir: 'desc',
        page: '2',
        pageSize: '50',
      },
    })
    expect(result.counts.verified).toBe(1)
    expect(result.items[0]).toMatchObject({
      displayName: 'bücher.example',
      customer: { name: 'Acme' },
      lastOutcome: { label: 'Verified' },
    })
  })

  it('does not send the status "all"', async () => {
    const t = transport(list())
    await listDomains(t)({ status: 'all' })
    expect(t.get).toHaveBeenCalledWith('domains/', {
      signal: undefined,
      query: expect.objectContaining({ status: undefined }),
    })
  })

  it.each([
    ['a state it does not know', list({ items: [row({ status: 'gone' })] })],
    ['a count that is missing', list({ counts: { pending: 0 } })],
    ['a customer that is not an object', list({ items: [row({ customer: 'Acme' })] })],
  ])('refuses %s', async (_what, answer) => {
    await expect(listDomains(transport(answer))({})).rejects.toMatchObject({
      code: 'bad_response',
    })
  })
})

describe('one domain', () => {
  it('encodes the id and reads the record to add and the latest verification with its evidence', async () => {
    const t = transport(detail())
    const result = await getDomain(t)('a/b')
    expect(t.get).toHaveBeenCalledWith('domains/a%2Fb/', { signal: undefined })
    expect(result.record).toEqual({
      type: 'TXT',
      name: '_ssphere-sentinel.x',
      value: 'ssphere-verification=t',
    })
    expect(result.latestVerification?.evidence?.nameservers[0]?.result).toBe('found')
  })

  it('accepts a domain never verified and a verification with no evidence', async () => {
    const result = await getDomain(transport(detail({ latestVerification: null })))('d1')
    expect(result.latestVerification).toBeNull()
    const second = await getDomain(
      transport(detail({ latestVerification: verification({ evidence: null }) })),
    )('d1')
    expect(second.latestVerification?.evidence).toBeNull()
  })

  it('refuses an answer with no record to add', async () => {
    await expect(
      getDomain(transport(detail({ record: { type: '', name: '', value: '' } })))('d1'),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('adding and verifying', () => {
  it('posts the customer and the name, and nothing else', async () => {
    const t = transport(detail())
    await createDomain(t)({ customerId: 'c1', name: 'Example.com' })
    expect(t.post).toHaveBeenCalledWith(
      'domains/',
      { customerId: 'c1', name: 'Example.com' },
      { signal: undefined },
    )
  })

  it('asks for a verification with no body and reads who is working on it', async () => {
    const t = transport({
      generatedAt: '2026-10-17T10:00:00.000Z',
      item: verification({ status: 'pending', outcome: null, evidence: null }),
      verifier: { state: 'running' },
    })
    const result = await verifyDomain(t)('d1')
    expect(t.post).toHaveBeenCalledWith('domains/d1/verify/', {}, { signal: undefined })
    expect(result.verifier.state).toBe('running')
    expect(result.item.status).toBe('pending')
  })

  it('reads one verification of the domain, and refuses a verifier state it does not know', async () => {
    const t = transport({
      generatedAt: '2026-10-17T10:00:00.000Z',
      item: verification(),
      verifier: { state: 'never_started' },
    })
    await getDomainVerification(t)('d1', 'v 1')
    expect(t.get).toHaveBeenCalledWith('domains/d1/verifications/v%201/', { signal: undefined })
    await expect(
      getDomainVerification(
        transport({
          generatedAt: '2026-10-17T10:00:00.000Z',
          item: verification(),
          verifier: { state: 'lost' },
        }),
      )('d1', 'v1'),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })
})

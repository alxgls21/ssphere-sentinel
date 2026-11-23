import { describe, expect, it, vi } from 'vitest'
import { listDeliveries, parseDeliveryList } from './deliveries'
import type { Transport } from './transport'

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get } as unknown as Transport & { get: typeof get }
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 12,
  kind: 'opened',
  status: 'failed',
  failure: { category: 'recipient_refused', label: 'The SMTP server refused the recipient' },
  recipient: { id: 7, username: 'maria' },
  incident: {
    id: 'i1',
    ruleName: 'Server resources',
    entityKind: 'server',
    entityLabel: 'ath-db-01',
    severity: 'critical',
  },
  attempts: 3,
  createdAt: '2026-10-17T10:00:00.000Z',
  lastAttemptAt: '2026-10-17T10:05:00.000Z',
  nextAttemptAt: null,
  sentAt: null,
  ...over,
})
const list = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:10:00.000Z',
  items: [item()],
  page: { number: 1, size: 50, total: 1, pages: 1 },
  counts: { pending: 0, sending: 0, sent: 4, failed: 1, cancelled: 2 },
  scopeTotal: 7,
  retentionDays: 90,
  ...over,
})

describe('the email log', () => {
  it('asks with what differs from the defaults and reads the item, the counts and the retention', async () => {
    const t = transport(list())
    const result = await listDeliveries(t)({
      q: ' maria ',
      status: 'failed',
      kind: 'opened',
      incident: 'i1',
      recipient: 7,
      sort: 'status',
      dir: 'asc',
      page: 2,
      pageSize: 50,
    })
    expect(t.get).toHaveBeenCalledWith('notifications/', {
      signal: undefined,
      query: {
        q: 'maria',
        status: 'failed',
        kind: 'opened',
        incident: 'i1',
        recipient: '7',
        sort: 'status',
        dir: 'asc',
        page: '2',
        pageSize: '50',
      },
    })
    expect(result.items[0]).toMatchObject({
      id: 12,
      status: 'failed',
      failure: { label: 'The SMTP server refused the recipient' },
      recipient: { id: 7, username: 'maria' },
      attempts: 3,
    })
    expect(result.counts).toEqual({ pending: 0, sending: 0, sent: 4, failed: 1, cancelled: 2 })
    expect(result.retentionDays).toBe(90)
  })

  it('does not send the filters "all"', async () => {
    const t = transport(list())
    await listDeliveries(t)({ status: 'all', kind: 'all' })
    expect(t.get).toHaveBeenCalledWith('notifications/', {
      signal: undefined,
      query: expect.objectContaining({ status: undefined, kind: undefined }),
    })
  })

  it('reads an email with no failure, and a recipient whose account is gone', () => {
    const read = parseDeliveryList(
      list({
        items: [
          item({
            status: 'sent',
            failure: null,
            recipient: { id: null, username: 'former' },
            sentAt: '2026-10-17T10:01:00.000Z',
          }),
        ],
      }),
    )
    expect(read.items[0]).toMatchObject({
      failure: null,
      recipient: { id: null, username: 'former' },
    })
  })

  it.each([
    ['a state it does not know', list({ items: [item({ status: 'lost' })] })],
    ['a kind it does not know', list({ items: [item({ kind: 'reminder' })] })],
    ['a count that is missing', list({ counts: { sent: 1 } })],
    ['no retention', list({ retentionDays: undefined })],
    ['a recipient with no name', list({ items: [item({ recipient: { id: 7 } })] })],
  ])('refuses %s', (_what, answer) => {
    expect(() => parseDeliveryList(answer)).toThrow(/unexpected answer/)
  })
})

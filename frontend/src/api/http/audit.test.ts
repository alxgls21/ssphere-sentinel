import { describe, expect, it, vi } from 'vitest'
import { listAuditLog, parseAuditEntry, parseAuditLog } from './audit'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (audit_log.py). */
const entry = (over: Record<string, unknown> = {}) => ({
  id: 42,
  at: '2026-10-17T10:00:00.000Z',
  actor: { id: 7, username: 'maria' },
  action: 'customer_changed',
  actionLabel: 'Customer changed',
  targetType: 'customer',
  targetTypeLabel: 'Customer',
  targetId: 'c1',
  targetName: 'Meridian',
  changes: { notes: { before: '', after: 'first' }, siteIds: { before: [], after: ['s1'] } },
  ...over,
})
const log = (items: unknown[]) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  scopeTotal: 9,
  actions: [{ value: 'customer_changed', label: 'Customer changed' }],
  targetTypes: [{ value: 'customer', label: 'Customer' }],
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  return { get } as unknown as Transport & { get: typeof get }
}

describe('the audit log', () => {
  it('lists the entries with the filters offered, sending only the filters that narrow', async () => {
    const t = transport(log([entry()]))
    const result = await listAuditLog(t)({
      q: ' meri ',
      actor: 7,
      action: 'customer_changed',
      targetType: '',
      targetId: ' c1 ',
      page: 2,
    })
    expect(result.items[0]).toMatchObject({
      id: 42,
      actor: { id: 7, username: 'maria' },
      actionLabel: 'Customer changed',
      changes: { notes: { before: '', after: 'first' }, siteIds: { before: [], after: ['s1'] } },
    })
    expect(result.actions).toEqual([{ value: 'customer_changed', label: 'Customer changed' }])
    expect(result.scopeTotal).toBe(9)
    expect(t.get).toHaveBeenCalledWith('audit-log/', {
      signal: undefined,
      query: {
        q: 'meri',
        actor: '7',
        action: 'customer_changed',
        targetType: undefined,
        targetId: 'c1',
        page: '2',
        pageSize: undefined,
      },
    })
  })

  it('keeps the actor of an account that is gone by name', () => {
    expect(parseAuditEntry(entry({ actor: { id: null, username: 'former' } })).actor).toEqual({
      id: null,
      username: 'former',
    })
  })

  it('reads every kind of value an entry may hold, and nothing else', () => {
    const parsed = parseAuditEntry(
      entry({
        changes: { a: { before: null, after: true }, b: { before: 1.5, after: ['x', 2, null] } },
      }),
    )
    expect(parsed.changes).toEqual({
      a: { before: null, after: true },
      b: { before: 1.5, after: ['x', 2, null] },
    })
    expect(() => parseAuditEntry(entry({ changes: { a: { before: {}, after: 1 } } }))).toThrow(
      /unexpected answer/,
    )
    expect(() => parseAuditEntry(entry({ changes: { a: { after: 1 } } }))).toThrow(
      /unexpected answer/,
    )
  })

  it.each([
    ['an id that is not whole', entry({ id: '42' })],
    ['an actor without a name', entry({ actor: { id: 7 } })],
    ['changes that are not an object', entry({ changes: [] })],
    ['a time that does not parse', entry({ at: 'yesterday' })],
  ])('refuses an entry with %s', (_what, raw) => {
    expect(() => parseAuditLog(log([raw]))).toThrow(/unexpected answer/)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  changeOwnPassword,
  createUser,
  getUser,
  listUsers,
  parseAccount,
  parseAccountList,
  resetUserPassword,
  unlockUser,
  updateUser,
} from './users'
import type { Transport } from './transport'

/** The shapes below are what apps/console serves (users.py). */
const account = (over: Record<string, unknown> = {}) => ({
  id: 7,
  username: 'maria',
  firstName: 'Maria',
  lastName: 'Papadopoulou',
  displayName: 'Maria Papadopoulou',
  email: 'maria@example.com',
  role: 'viewer',
  allCustomers: false,
  active: true,
  lastLoginAt: '2026-10-17T09:00:00.000Z',
  createdAt: '2026-09-01T08:00:00.000Z',
  locked: false,
  lockedUntil: null,
  self: false,
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [{ id: 's1', customerId: 'c2', customerName: 'Globex', name: 'Plant' }],
  ...over,
})
const list = (items: unknown[]) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  items,
  page: { number: 1, size: 50, total: items.length, pages: 1 },
  counts: { active: 3, inactive: 1 },
  scopeTotal: 4,
})
const detail = (over: Record<string, unknown> = {}) => ({
  generatedAt: '2026-10-17T10:00:05.000Z',
  item: account(over),
})

const transport = (answer: unknown) => {
  const get = vi.fn(async () => answer)
  const post = vi.fn(async () => answer)
  const patch = vi.fn(async () => answer)
  const put = vi.fn(async () => answer)
  return { get, post, patch, put } as unknown as Transport & {
    get: typeof get
    post: typeof post
    patch: typeof patch
    put: typeof put
  }
}

describe('accounts', () => {
  it('lists them with the counts, the page and the scope total', async () => {
    const t = transport(list([account()]))
    const result = await listUsers(t)({
      q: 'mar',
      active: 'active',
      sort: 'lastLogin',
      dir: 'desc',
    })
    expect(result.items[0]).toMatchObject({
      id: 7,
      username: 'maria',
      role: 'viewer',
      locked: false,
      customers: [{ id: 'c1', name: 'Meridian' }],
    })
    expect(result.counts).toEqual({ active: 3, inactive: 1 })
    expect(t.get).toHaveBeenCalledWith('users/', {
      signal: undefined,
      query: {
        q: 'mar',
        active: 'active',
        sort: 'lastLogin',
        dir: 'desc',
        page: undefined,
        pageSize: undefined,
      },
    })
    // `all` is the default: not sent.
    await listUsers(t)({ active: 'all' })
    expect(t.get).toHaveBeenLastCalledWith('users/', {
      signal: undefined,
      query: {
        q: undefined,
        active: undefined,
        sort: undefined,
        dir: undefined,
        page: undefined,
        pageSize: undefined,
      },
    })
  })

  it('reads an account without a role, a locked one, and the signed-in one', () => {
    expect(parseAccount(account({ role: null })).role).toBeNull()
    const locked = parseAccount(account({ locked: true, lockedUntil: '2026-10-17T10:15:00.000Z' }))
    expect(locked.lockedUntil).toBe('2026-10-17T10:15:00.000Z')
    expect(parseAccount(account({ self: true })).self).toBe(true)
  })

  it('never carries a password or a hash, even if an answer held one', () => {
    const parsed = parseAccount(account({ password: 'md5$x', passwordHash: 'y' }))
    expect(JSON.stringify(parsed)).not.toMatch(/password|md5/)
  })

  it('asks for one account by its number, and refuses a number that is not an id', async () => {
    const t = transport(detail())
    expect((await getUser(t)(7)).item.username).toBe('maria')
    expect(t.get).toHaveBeenCalledWith('users/7/', { signal: undefined })
    await expect(getUser(t)(0)).rejects.toThrow(/unexpected answer/)
    await expect(getUser(t)(1.5)).rejects.toThrow(/unexpected answer/)
  })

  it('creates an account with its password in that one request, and the fields named', async () => {
    const t = transport(detail())
    await createUser(t)({
      username: 'maria',
      password: 'a-long-passphrase',
      role: 'viewer',
      email: 'maria@example.com',
      customerIds: ['c1'],
      ...({ isSuperuser: true } as object),
    })
    expect(t.post).toHaveBeenCalledWith(
      'users/',
      {
        username: 'maria',
        role: 'viewer',
        email: 'maria@example.com',
        customerIds: ['c1'],
        password: 'a-long-passphrase',
      },
      { signal: undefined },
    )
  })

  it('changes an account without ever sending a password', async () => {
    const t = transport(detail())
    await updateUser(t)(7, { role: 'editor', active: false, ...({ password: 'x' } as object) })
    expect(t.patch).toHaveBeenCalledWith(
      'users/7/',
      { role: 'editor', active: false },
      { signal: undefined },
    )
  })

  it('sets a password and unlocks from their own endpoints', async () => {
    const t = transport(detail())
    await resetUserPassword(t)(7, 'new-passphrase')
    expect(t.post).toHaveBeenCalledWith(
      'users/7/password/',
      { password: 'new-passphrase' },
      { signal: undefined },
    )
    await unlockUser(t)(7)
    expect(t.post).toHaveBeenLastCalledWith('users/7/unlock/', {}, { signal: undefined })
  })

  it('changes the own password with PUT and reads when it changed', async () => {
    const t = transport({
      generatedAt: '2026-10-17T10:00:05.000Z',
      changedAt: '2026-10-17T10:00:05.000Z',
    })
    const result = await changeOwnPassword(t)({ currentPassword: 'old', newPassword: 'new' })
    expect(result.changedAt).toBe('2026-10-17T10:00:05.000Z')
    expect(t.put).toHaveBeenCalledWith(
      'account/password/',
      { currentPassword: 'old', newPassword: 'new' },
      { signal: undefined },
    )
  })

  it.each([
    ['an id that is text', account({ id: '7' })],
    ['an unknown role', account({ role: 'owner' })],
    ['a grant without a name', account({ customers: [{ id: 'c1' }] })],
    ['a flag that is not a boolean', account({ active: 'yes' })],
    ['a time that does not parse', account({ createdAt: 'yesterday' })],
  ])('refuses an account with %s', (_what, raw) => {
    expect(() => parseAccount(raw)).toThrow(/unexpected answer/)
    expect(() => parseAccountList(list([raw]))).toThrow(/unexpected answer/)
  })
})

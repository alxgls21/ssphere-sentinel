import { describe, expect, it, vi } from 'vitest'
import { createAuthClient, getScopeOptions, parseScope, parseSession } from './session'
import type { Transport } from './transport'

const user = { username: 'alice', displayName: 'Alice Example' }
const signedIn = {
  apiVersion: 1,
  serverTime: '2026-10-13T08:00:00.000Z',
  authenticated: true,
  reason: null,
  csrfToken: 'tok',
  user,
  access: { allCustomers: false },
  thresholds: null,
}
const anonymous = { ...signedIn, authenticated: false, user: null, access: null }

describe('parseSession', () => {
  it('reads a signed-in answer', () => {
    expect(parseSession(signedIn)).toEqual({
      authenticated: true,
      reason: null,
      user,
      allCustomers: false,
    })
  })

  it('reads an anonymous answer, and an account without console access', () => {
    expect(parseSession(anonymous)).toMatchObject({
      authenticated: false,
      user: null,
      reason: null,
    })
    expect(parseSession({ ...anonymous, reason: 'no_console_access' })).toMatchObject({
      authenticated: false,
      reason: 'no_console_access',
    })
  })

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['no authenticated flag', { ...signedIn, authenticated: undefined }],
    ['no token', { ...signedIn, csrfToken: '' }],
    ['an unknown reason', { ...anonymous, reason: 'whatever' }],
    ['a signed-in answer without a user', { ...signedIn, user: null }],
    ['a user without a name', { ...signedIn, user: { username: 1, displayName: 'x' } }],
    ['no access block', { ...signedIn, access: null }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseSession(raw)).toThrow(/unexpected answer/)
  })
})

describe('parseScope', () => {
  it('reads the customers and sites as the console API sends them', () => {
    expect(
      parseScope({
        customers: [{ id: 'c1', name: 'Acme', extra: 1 }],
        sites: [{ id: 's1', customerId: 'c1', name: 'DC' }],
      }),
    ).toEqual({
      customers: [{ id: 'c1', name: 'Acme' }],
      sites: [{ id: 's1', customerId: 'c1', name: 'DC' }],
    })
  })

  it.each([
    ['no lists', {}],
    ['a customer without a name', { customers: [{ id: 'c' }], sites: [] }],
    ['a site that is not an object', { customers: [], sites: ['x'] }],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseScope(raw)).toThrow(/unexpected answer/)
  })
})

describe('the clients', () => {
  const transport = (answer: unknown): Transport =>
    ({
      get: vi.fn(async () => answer),
      post: vi.fn(async () => answer),
    }) as unknown as Transport

  it('signs in with the credentials as the only body', async () => {
    const t = transport(signedIn)
    const result = await createAuthClient(t).signIn('alice', 'pw')
    expect(t.post).toHaveBeenCalledWith(
      'auth/login/',
      { username: 'alice', password: 'pw' },
      { signal: undefined },
    )
    expect(result.user).toEqual(user)
  })

  it('signs out and reports the anonymous session', async () => {
    const t = transport(anonymous)
    expect((await createAuthClient(t).signOut()).authenticated).toBe(false)
    expect(t.post).toHaveBeenCalledWith('auth/logout/', {}, { signal: undefined })
  })

  it('reads the scope', async () => {
    const t = transport({ customers: [], sites: [] })
    await expect(getScopeOptions(t)()).resolves.toEqual({ customers: [], sites: [] })
    expect(t.get).toHaveBeenCalledWith('scope/', { signal: undefined })
  })
})

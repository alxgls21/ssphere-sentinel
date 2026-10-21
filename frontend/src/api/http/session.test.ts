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

describe('parseSession thresholds', () => {
  const published = {
    resourceWarnPercent: 75,
    resourceCritPercent: 90,
    probeLossWarnPercent: 3,
    probeLatencyWarnMs: 200,
    targetCritFailures: 4,
  }

  it('carries the limits the server published with a signed-in session', () => {
    expect(parseSession({ ...signedIn, thresholds: published }).thresholds).toEqual(published)
  })

  it('signs in without limits when the server published none', () => {
    expect(parseSession({ ...signedIn, thresholds: null })).not.toHaveProperty('thresholds')
    expect(parseSession(anonymous)).not.toHaveProperty('thresholds')
  })

  it.each([
    ['not an object', 'high'],
    ['a limit missing', { ...published, resourceCritPercent: undefined }],
    ['a limit that is not a number', { ...published, resourceWarnPercent: '75' }],
    ['a negative limit', { ...published, probeLatencyWarnMs: -1 }],
    ['a limit that is not finite', { ...published, targetCritFailures: Number.NaN }],
  ])('refuses limits that are %s', (_what, thresholds) => {
    expect(() => parseSession({ ...signedIn, thresholds })).toThrow(/unexpected answer/)
  })
})

describe('parseSession capabilities', () => {
  const granted = {
    acknowledgeIncidents: true,
    viewAlertRules: true,
    createAlertRules: false,
    editAlertRules: true,
    manageOwnNotifications: true,
    sendTestEmail: false,
    viewSystemStatus: false,
  }

  it('carries what the server says the account may do, flag by flag', () => {
    expect(parseSession({ ...signedIn, capabilities: granted }).capabilities).toEqual(granted)
  })

  it('offers nothing when the answer has none (an anonymous session, an older server)', () => {
    expect(parseSession({ ...signedIn, capabilities: null })).not.toHaveProperty('capabilities')
    expect(parseSession(anonymous)).not.toHaveProperty('capabilities')
  })

  it('keeps only the flags it knows: nothing else an answer holds is carried', () => {
    const { capabilities } = parseSession({
      ...signedIn,
      capabilities: { ...granted, isSuperuser: true },
    })
    expect(capabilities).not.toHaveProperty('isSuperuser')
  })

  it.each([
    ['not an object', 'yes'],
    ['a flag missing', { ...granted, viewSystemStatus: undefined }],
    ['a flag that is not a boolean', { ...granted, sendTestEmail: 'true' }],
    ['a flag that is a number', { ...granted, editAlertRules: 1 }],
  ])('refuses capabilities that are %s', (_what, capabilities) => {
    expect(() => parseSession({ ...signedIn, capabilities })).toThrow(/unexpected answer/)
  })
})

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

  it('asks whether setup is required, with no body', async () => {
    const yes = transport({ required: true })
    await expect(createAuthClient(yes).getSetup()).resolves.toBe(true)
    expect(yes.get).toHaveBeenCalledWith('setup/', { signal: undefined })
    await expect(createAuthClient(transport({ required: false })).getSetup()).resolves.toBe(false)
  })

  it.each([[{}], [{ required: 'yes' }], [null], [[true]]])(
    'refuses a setup answer that is not {required: boolean}: %j',
    async (answer) => {
      await expect(createAuthClient(transport(answer)).getSetup()).rejects.toMatchObject({
        code: 'bad_response',
      })
    },
  )

  it('creates the first administrator with exactly the four fields, and no empty email', async () => {
    const t = transport(signedIn)
    const input = {
      code: 'K7QX-M2P9-A4TR',
      username: 'root',
      email: '  ',
      password: 'pw',
      isSuperuser: true,
    } as unknown as Parameters<ReturnType<typeof createAuthClient>['createFirstAdministrator']>[0]
    const result = await createAuthClient(t).createFirstAdministrator(input)
    expect(t.post).toHaveBeenCalledWith(
      'setup/',
      { code: 'K7QX-M2P9-A4TR', username: 'root', email: null, password: 'pw' },
      { signal: undefined },
    )
    expect(result.user).toEqual(user)
  })

  it('sends a trimmed email when there is one', async () => {
    const t = transport(signedIn)
    await createAuthClient(t).createFirstAdministrator({
      code: 'c',
      username: 'root',
      email: ' root@example.com ',
      password: 'pw',
    })
    expect(t.post).toHaveBeenCalledWith(
      'setup/',
      expect.objectContaining({ email: 'root@example.com' }),
      { signal: undefined },
    )
  })

  it('reads the scope', async () => {
    const t = transport({ customers: [], sites: [] })
    await expect(getScopeOptions(t)()).resolves.toEqual({ customers: [], sites: [] })
    expect(t.get).toHaveBeenCalledWith('scope/', { signal: undefined })
  })
})

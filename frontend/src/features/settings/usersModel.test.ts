import { describe, expect, it } from 'vitest'
import type { Account } from '@/api/types'
import {
  accountDraft,
  accountInput,
  accountPatch,
  emailsText,
  parseUsersQuery,
  scopeText,
  signInText,
  usersRequest,
  validateAccount,
  validatePassword,
  writeUsersQuery,
} from './usersModel'

const account: Account = {
  id: 7,
  username: 'maria',
  firstName: 'Maria',
  lastName: '',
  displayName: 'Maria',
  email: 'maria@example.com',
  role: 'viewer',
  allCustomers: false,
  active: true,
  lastLoginAt: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  locked: false,
  lockedUntil: null,
  failedSignIns: 0,
  maxFailedSignIns: 5,
  notifications: { enabled: false, minSeverity: null, receiving: false },
  self: false,
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [{ id: 's9', customerId: 'c2', customerName: 'Globex', name: 'Plant' }],
}

describe('the accounts list query', () => {
  it('reads and writes the search, the state filter, the sort and the page', () => {
    expect(parseUsersQuery(new URLSearchParams('active=inactive&sort=lastLogin'))).toEqual({
      q: '',
      active: 'inactive',
      locked: 'all',
      notifications: 'all',
      sort: 'lastLogin',
      dir: 'desc',
      page: 1,
    })
    expect(parseUsersQuery(new URLSearchParams('active=locked&sort=role'))).toMatchObject({
      active: 'all',
      sort: 'username',
    })
    const written = writeUsersQuery(new URLSearchParams(''), {
      q: 'm',
      active: 'active',
      locked: 'locked',
      notifications: 'on',
      sort: 'joined',
      dir: 'asc',
      page: 2,
    })
    expect(Object.fromEntries(written)).toEqual({
      q: 'm',
      active: 'active',
      locked: 'locked',
      notifications: 'on',
      sort: 'joined',
      dir: 'asc',
      page: '2',
    })
    expect(
      usersRequest(
        {
          q: 'x',
          active: 'all',
          locked: 'locked',
          notifications: 'off',
          sort: 'username',
          dir: 'asc',
          page: 1,
        },
        'settled',
      ),
    ).toEqual({
      q: 'settled',
      active: 'all',
      locked: 'locked',
      notifications: 'off',
      sort: 'username',
      dir: 'asc',
      page: 1,
      pageSize: 50,
    })
  })
})

describe('what an account sees, in words', () => {
  it('says every customer, or counts the grants, or that there are none', () => {
    expect(scopeText({ ...account, allCustomers: true })).toBe('All customers')
    expect(scopeText(account)).toBe('1 customer, 1 site')
    expect(scopeText({ ...account, customers: [], sites: [] })).toBe('Nothing yet')
  })
})

describe('the account form', () => {
  it('starts from the account as it is, with the least role for one that has none', () => {
    expect(accountDraft(account)).toMatchObject({
      username: 'maria',
      role: 'viewer',
      customerIds: ['c1'],
      siteIds: ['s9'],
      password: '',
      confirm: '',
    })
    expect(accountDraft({ ...account, role: null }).role).toBe('viewer')
  })

  it('requires a user name without spaces, and a password typed twice for a new account', () => {
    const draft = { ...accountDraft(account), username: 'ma ria' }
    expect(validateAccount(draft, false)).toEqual({ username: ['No spaces.'] })
    expect(validateAccount({ ...accountDraft(account), username: ' ' }, false)).toEqual({
      username: ['Required.'],
    })
    expect(validateAccount(accountDraft(account), true)).toEqual({ password: ['Required.'] })
    expect(
      validateAccount({ ...accountDraft(account), password: 'short', confirm: 'x' }, true),
    ).toEqual({
      password: ['At least 8 characters.'],
      confirm: ['The two passwords differ.'],
    })
    expect(validatePassword('a-long-passphrase', 'a-long-passphrase')).toEqual({})
  })

  it('sends the scope only for a viewer or an operator, and no grants to an account that sees every customer', () => {
    const viewer = accountDraft(account)
    expect(accountInput({ ...viewer, password: 'a-long-passphrase' })).toEqual({
      username: 'maria',
      password: 'a-long-passphrase',
      role: 'viewer',
      email: 'maria@example.com',
      firstName: 'Maria',
      lastName: '',
      active: true,
      allCustomers: false,
      customerIds: ['c1'],
      siteIds: ['s9'],
    })
    expect(accountInput({ ...viewer, allCustomers: true })).toMatchObject({
      allCustomers: true,
      customerIds: [],
      siteIds: [],
    })
    const editor = accountInput({ ...viewer, role: 'editor' })
    expect(editor).not.toHaveProperty('allCustomers')
    expect(editor).toMatchObject({ customerIds: [], siteIds: [] })
  })

  it('sends only what changed, a role always with its scope', () => {
    expect(accountPatch(accountDraft(account), account)).toBeNull()
    expect(
      accountPatch({ ...accountDraft(account), email: 'm@example.com', active: false }, account),
    ).toEqual({
      email: 'm@example.com',
      active: false,
    })
    expect(accountPatch({ ...accountDraft(account), allCustomers: true }, account)).toEqual({
      role: 'viewer',
      allCustomers: true,
      customerIds: [],
      siteIds: [],
    })
    expect(accountPatch({ ...accountDraft(account), role: 'editor' }, account)).toEqual({
      role: 'editor',
      customerIds: [],
      siteIds: [],
    })
    expect(accountPatch({ ...accountDraft(account), customerIds: ['c1', 'c2'] }, account)).toEqual({
      customerIds: ['c1', 'c2'],
    })
    // The same grants in another order are the same grants.
    expect(
      accountPatch(
        { ...accountDraft(account), customerIds: ['c1'], siteIds: ['s9'] },
        { ...account, sites: [...account.sites] },
      ),
    ).toBeNull()
  })
})

describe('what the list says about sign-in and incident emails', () => {
  const now = Date.parse('2026-10-18T10:00:00Z')
  it('says locked until when, or how many failures still count, or nothing', () => {
    expect(signInText(account, now, 'utc')).toBeNull()
    expect(signInText({ ...account, failedSignIns: 2 }, now, 'utc')).toBe('2 of 5 failed sign-ins')
    expect(
      signInText(
        { ...account, locked: true, lockedUntil: '2026-10-18T10:15:00.000Z', failedSignIns: 5 },
        now,
        'utc',
      ),
    ).toMatch(/^Locked until /)
    expect(signInText({ ...account, locked: true }, now, 'utc')).toBe('Locked')
  })

  it('says off, on and received, or on and not received', () => {
    const on = { enabled: true, minSeverity: 'critical' as const, receiving: true }
    expect(emailsText(account)).toBe('Off')
    expect(emailsText({ ...account, notifications: on })).toBe('Critical only')
    expect(emailsText({ ...account, notifications: { ...on, minSeverity: 'warning' } })).toBe(
      'Warning and critical',
    )
    expect(emailsText({ ...account, notifications: { ...on, receiving: false } })).toBe(
      'On, not received',
    )
  })

  it('reads the locked and emails filters, ignoring what it does not know', () => {
    expect(parseUsersQuery(new URLSearchParams('locked=locked&notifications=on'))).toMatchObject({
      locked: 'locked',
      notifications: 'on',
    })
    expect(parseUsersQuery(new URLSearchParams('locked=x&notifications=maybe'))).toMatchObject({
      locked: 'all',
      notifications: 'all',
    })
  })
})

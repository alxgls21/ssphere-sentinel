import { describe, expect, it } from 'vitest'
import type { Account } from '@/api/types'
import {
  accountDraft,
  accountInput,
  accountPatch,
  parseUsersQuery,
  scopeText,
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
  self: false,
  customers: [{ id: 'c1', name: 'Meridian' }],
  sites: [{ id: 's9', customerId: 'c2', customerName: 'Globex', name: 'Plant' }],
}

describe('the accounts list query', () => {
  it('reads and writes the search, the state filter, the sort and the page', () => {
    expect(parseUsersQuery(new URLSearchParams('active=inactive&sort=lastLogin'))).toEqual({
      q: '',
      active: 'inactive',
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
      sort: 'joined',
      dir: 'asc',
      page: 2,
    })
    expect(Object.fromEntries(written)).toEqual({
      q: 'm',
      active: 'active',
      sort: 'joined',
      dir: 'asc',
      page: '2',
    })
    expect(
      usersRequest({ q: 'x', active: 'all', sort: 'username', dir: 'asc', page: 1 }, 'settled'),
    ).toEqual({
      q: 'settled',
      active: 'all',
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

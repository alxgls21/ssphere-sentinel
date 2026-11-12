import type {
  Account,
  AccountActiveFilter,
  AccountInput,
  AccountListOptions,
  AccountPatch,
  AccountSortKey,
  SortDirection,
  UserRole,
} from '@/api/types'
import type { FieldErrors } from '@/hooks/useSaveForm'
import { isOneOf, nextListSort, setQueryParam, wholePage } from '@/lib/listQuery'
import { ADMIN_PAGE_SIZE, tooLong } from './adminModel'

/**
 * What the accounts list asks for, the words of the roles, and the form of an account: what is
 * typed, what is wrong with it, and what is sent. The server checks everything again (the unique
 * user name, the password's rules, who may be demoted): the checks here only save a round trip.
 */

export interface UsersQuery {
  q: string
  active: AccountActiveFilter
  sort: AccountSortKey
  dir: SortDirection
  /** 1-based. */
  page: number
}

export const DEFAULT_USERS_QUERY: UsersQuery = {
  q: '',
  active: 'all',
  sort: 'username',
  dir: 'asc',
  page: 1,
}

export const ACTIVE_FILTERS: readonly AccountActiveFilter[] = ['all', 'active', 'inactive']
export const ACTIVE_LABEL: Record<AccountActiveFilter, string> = {
  all: 'ALL',
  active: 'ACTIVE',
  inactive: 'INACTIVE',
}
export const USER_SORT_KEYS: readonly AccountSortKey[] = ['username', 'joined', 'lastLogin']
export const USER_SORT_LABEL: Record<AccountSortKey, string> = {
  username: 'User name',
  joined: 'Created',
  lastLogin: 'Last sign-in',
}
/** Names A to Z; the newest account first; the most recent sign-in first. */
export const USER_FIRST_DIR: Record<AccountSortKey, SortDirection> = {
  username: 'asc',
  joined: 'desc',
  lastLogin: 'desc',
}

export function parseUsersQuery(params: URLSearchParams): UsersQuery {
  const sort = params.get('sort')
  const dir = params.get('dir')
  const active = params.get('active')
  const key = isOneOf(USER_SORT_KEYS, sort) ? sort : DEFAULT_USERS_QUERY.sort
  return {
    q: params.get('q') ?? '',
    active: isOneOf(ACTIVE_FILTERS, active) ? active : DEFAULT_USERS_QUERY.active,
    sort: key,
    dir: dir === 'asc' || dir === 'desc' ? dir : USER_FIRST_DIR[key],
    page: wholePage(params.get('page')),
  }
}

export function writeUsersQuery(params: URLSearchParams, query: UsersQuery): URLSearchParams {
  const next = new URLSearchParams(params)
  setQueryParam(next, 'q', query.q, query.q.trim() === '')
  setQueryParam(next, 'active', query.active, query.active === DEFAULT_USERS_QUERY.active)
  setQueryParam(next, 'sort', query.sort, query.sort === DEFAULT_USERS_QUERY.sort)
  setQueryParam(next, 'dir', query.dir, query.dir === USER_FIRST_DIR[query.sort])
  setQueryParam(next, 'page', String(query.page), query.page === DEFAULT_USERS_QUERY.page)
  return next
}

export const nextUsersSort = (
  query: UsersQuery,
  key: AccountSortKey,
): Pick<UsersQuery, 'sort' | 'dir'> => nextListSort(query, key, USER_FIRST_DIR)

export const usersRequest = (query: UsersQuery, q: string): AccountListOptions => ({
  q,
  active: query.active,
  sort: query.sort,
  dir: query.dir,
  page: query.page,
  pageSize: ADMIN_PAGE_SIZE,
})

export const ROLES: readonly UserRole[] = ['viewer', 'operator', 'editor', 'administrator']
export const ROLE_LABEL: Record<UserRole, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  editor: 'Editor',
  administrator: 'Administrator',
}
/** What each role may do, in one line: the least that does the job is the right one. */
export const ROLE_HINT: Record<UserRole, string> = {
  viewer: 'Reads what its customers and sites show. Nothing else.',
  operator: 'Reads, acknowledges incidents and may ask for a test email.',
  editor:
    'Configures monitoring for every customer: hosts, targets, devices, customers and sites, alert rules, domains. Sees the system status.',
  administrator:
    'Everything, accounts and the audit log included; may also use the admin. Give it to as few accounts as possible.',
}

/** The roles whose scope is a choice; the others see every customer. */
export const scopedRole = (role: UserRole | null): boolean =>
  role === 'viewer' || role === 'operator'

/** "All customers", "2 customers, 1 site", or what an account without any grant sees: nothing. */
export function scopeText(account: Account): string {
  if (account.allCustomers) return 'All customers'
  const parts = [
    account.customers.length > 0
      ? `${account.customers.length} ${account.customers.length === 1 ? 'customer' : 'customers'}`
      : null,
    account.sites.length > 0
      ? `${account.sites.length} ${account.sites.length === 1 ? 'site' : 'sites'}`
      : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : 'Nothing yet'
}

export const LIMITS = { username: 150, name: 150, email: 254, password: 1024 } as const
/** The installation's own validators decide; this is the shortest they ever accept. */
export const MIN_PASSWORD_LENGTH = 8

export interface AccountDraft {
  username: string
  firstName: string
  lastName: string
  email: string
  role: UserRole
  allCustomers: boolean
  customerIds: string[]
  siteIds: string[]
  active: boolean
  /** A new account only: typed twice. Never kept once sent. */
  password: string
  confirm: string
}

export type AccountField = keyof AccountDraft
export const ACCOUNT_FIELDS: readonly AccountField[] = [
  'username',
  'firstName',
  'lastName',
  'email',
  'role',
  'allCustomers',
  'customerIds',
  'siteIds',
  'active',
  'password',
  'confirm',
]

export const EMPTY_ACCOUNT: AccountDraft = {
  username: '',
  firstName: '',
  lastName: '',
  email: '',
  role: 'viewer',
  allCustomers: false,
  customerIds: [],
  siteIds: [],
  active: true,
  password: '',
  confirm: '',
}

export const accountDraft = (account: Account): AccountDraft => ({
  username: account.username,
  firstName: account.firstName,
  lastName: account.lastName,
  email: account.email,
  // An account that may not use the console yet is offered the least role.
  role: account.role ?? 'viewer',
  allCustomers: account.allCustomers,
  customerIds: account.customers.map((grant) => grant.id),
  siteIds: account.sites.map((grant) => grant.id),
  active: account.active,
  password: '',
  confirm: '',
})

/** The two spellings of a new password must agree, and it must be long enough for any validator. */
export function validatePassword(
  password: string,
  confirm: string,
): { password?: string[]; confirm?: string[] } {
  const errors: { password?: string[]; confirm?: string[] } = {}
  if (password === '') errors.password = ['Required.']
  else if (password.length < MIN_PASSWORD_LENGTH)
    errors.password = [`At least ${MIN_PASSWORD_LENGTH} characters.`]
  else if (password.length > LIMITS.password) errors.password = [tooLong(LIMITS.password)]
  if (confirm !== password) errors.confirm = ['The two passwords differ.']
  return errors
}

export function validateAccount(draft: AccountDraft, creating: boolean): FieldErrors<AccountField> {
  const errors: FieldErrors<AccountField> = {}
  const username = draft.username.trim()
  if (username === '') errors.username = ['Required.']
  else if (username.length > LIMITS.username) errors.username = [tooLong(LIMITS.username)]
  else if (/\s/.test(username)) errors.username = ['No spaces.']
  if (draft.firstName.trim().length > LIMITS.name) errors.firstName = [tooLong(LIMITS.name)]
  if (draft.lastName.trim().length > LIMITS.name) errors.lastName = [tooLong(LIMITS.name)]
  if (draft.email.trim().length > LIMITS.email) errors.email = [tooLong(LIMITS.email)]
  if (creating) {
    const password = validatePassword(draft.password, draft.confirm)
    if (password.password) errors.password = password.password
    if (password.confirm) errors.confirm = password.confirm
  }
  return errors
}

/** Everything a new account is created with. The scope is sent only for the roles that choose one. */
export function accountInput(draft: AccountDraft): AccountInput {
  const scoped = scopedRole(draft.role)
  return {
    username: draft.username.trim(),
    password: draft.password,
    role: draft.role,
    email: draft.email.trim(),
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    active: draft.active,
    ...(scoped ? { allCustomers: draft.allCustomers } : {}),
    customerIds: scoped && !draft.allCustomers ? draft.customerIds : [],
    siteIds: scoped && !draft.allCustomers ? draft.siteIds : [],
  }
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index])

/** Only what changed; null when nothing did. A role is always sent with its scope, so neither is guessed. */
export function accountPatch(draft: AccountDraft, account: Account): AccountPatch | null {
  const input = accountInput(draft)
  const patch: AccountPatch = {}
  if (input.username !== account.username) patch.username = input.username
  if (input.email !== account.email) patch.email = input.email
  if (input.firstName !== account.firstName) patch.firstName = input.firstName
  if (input.lastName !== account.lastName) patch.lastName = input.lastName
  if (input.active !== account.active) patch.active = input.active
  const wantsAll = scopedRole(draft.role) ? draft.allCustomers : true
  if (input.role !== account.role || wantsAll !== account.allCustomers) {
    patch.role = input.role
    if (scopedRole(draft.role)) patch.allCustomers = draft.allCustomers
  }
  const customerIds = input.customerIds ?? []
  const siteIds = input.siteIds ?? []
  if (
    !sameIds(
      customerIds,
      account.customers.map((grant) => grant.id),
    )
  )
    patch.customerIds = customerIds
  if (
    !sameIds(
      siteIds,
      account.sites.map((grant) => grant.id),
    )
  )
    patch.siteIds = siteIds
  return Object.keys(patch).length > 0 ? patch : null
}

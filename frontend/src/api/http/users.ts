import type { SentinelApi } from '../client'
import type {
  Account,
  AccountDetail,
  AccountInput,
  AccountList,
  AccountListOptions,
  AccountPatch,
  PasswordChanged,
  UserRole,
} from '../types'
import { parsePage } from './lists'
import { array, bad, flag, nullableTime, oneOf, record, text, time, whole } from './parse'
import { body, notAll, pageText, searchText } from './records'
import type { Transport } from './transport'

/**
 * The console API's accounts: the list (`users/`), one account (`users/<id>/`), a new one (POST), a
 * change (PATCH), a new password set by an administrator (`users/<id>/password/`), an unlock
 * (`users/<id>/unlock/`) and the signed-in account's own password (`account/password/`). Every
 * answer is validated by naming each field: were a password or a hash ever in an answer, it would
 * not be read. A password goes out in the one request that sets it, and nowhere else.
 */

const ROLE: readonly UserRole[] = ['viewer', 'operator', 'editor', 'administrator']

/** A whole number id, as the server gives it (not a string: the user model's keys are numbers). */
function userId(value: unknown): number {
  const id = whole(value, 1)
  return id
}

export function parseAccount(raw: unknown): Account {
  const row = record(raw)
  return {
    id: userId(row.id),
    username: text(row.username),
    firstName: text(row.firstName),
    lastName: text(row.lastName),
    displayName: text(row.displayName),
    email: text(row.email),
    role: row.role === null ? null : oneOf(ROLE, row.role),
    allCustomers: flag(row.allCustomers),
    active: flag(row.active),
    lastLoginAt: nullableTime(row.lastLoginAt),
    createdAt: time(row.createdAt),
    locked: flag(row.locked),
    lockedUntil: nullableTime(row.lockedUntil),
    self: flag(row.self),
    customers: array(row.customers).map((value) => {
      const grant = record(value)
      return { id: text(grant.id), name: text(grant.name) }
    }),
    sites: array(row.sites).map((value) => {
      const grant = record(value)
      return {
        id: text(grant.id),
        customerId: text(grant.customerId),
        customerName: text(grant.customerName),
        name: text(grant.name),
      }
    }),
  }
}

export function parseAccountList(raw: unknown): AccountList {
  const row = record(raw)
  const counts = record(row.counts)
  return {
    generatedAt: time(row.generatedAt),
    items: array(row.items).map(parseAccount),
    page: parsePage(row.page),
    scopeTotal: whole(row.scopeTotal),
    counts: { active: whole(counts.active), inactive: whole(counts.inactive) },
  }
}

export function parseAccountDetail(raw: unknown): AccountDetail {
  const row = record(raw)
  return { generatedAt: time(row.generatedAt), item: parseAccount(row.item) }
}

export function parsePasswordChanged(raw: unknown): PasswordChanged {
  const row = record(raw)
  return { generatedAt: time(row.generatedAt), changedAt: time(row.changedAt) }
}

function listQuery(options: AccountListOptions): Record<string, string | undefined> {
  return {
    q: searchText(options.q),
    active: notAll(options.active),
    sort: options.sort,
    dir: options.dir,
    page: pageText(options.page),
    pageSize: pageText(options.pageSize),
  }
}

/** An account id is a path segment: a whole number, or the request is not made. */
function userPath(id: number): string {
  if (!Number.isInteger(id) || id < 1) throw bad()
  return `users/${id}/`
}

/** The fields of an account, named one by one: nothing else the caller holds can go out. */
function accountBody(input: AccountPatch): Record<string, unknown> {
  return body({
    username: input.username,
    role: input.role,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    active: input.active,
    allCustomers: input.allCustomers,
    customerIds: input.customerIds,
    siteIds: input.siteIds,
  })
}

export const listUsers =
  (transport: Transport): SentinelApi['listUsers'] =>
  async (options = {}) =>
    parseAccountList(
      await transport.get('users/', { signal: options.signal, query: listQuery(options) }),
    )

export const getUser =
  (transport: Transport): SentinelApi['getUser'] =>
  async (id, options) =>
    parseAccountDetail(await transport.get(userPath(id), { signal: options?.signal }))

/** The one request that carries a new account's password, with the fields of the account. */
export const createUser =
  (transport: Transport): SentinelApi['createUser'] =>
  async (input: AccountInput, options) =>
    parseAccountDetail(
      await transport.post(
        'users/',
        { ...accountBody(input), password: input.password },
        { signal: options?.signal },
      ),
    )

export const updateUser =
  (transport: Transport): SentinelApi['updateUser'] =>
  async (id, patch, options) =>
    parseAccountDetail(
      await transport.patch(userPath(id), accountBody(patch), { signal: options?.signal }),
    )

export const resetUserPassword =
  (transport: Transport): SentinelApi['resetUserPassword'] =>
  async (id, password, options) =>
    parseAccountDetail(
      await transport.post(`${userPath(id)}password/`, { password }, { signal: options?.signal }),
    )

export const unlockUser =
  (transport: Transport): SentinelApi['unlockUser'] =>
  async (id, options) =>
    parseAccountDetail(
      await transport.post(`${userPath(id)}unlock/`, {}, { signal: options?.signal }),
    )

export const changeOwnPassword =
  (transport: Transport): SentinelApi['changeOwnPassword'] =>
  async (input, options) =>
    parsePasswordChanged(
      await transport.put(
        'account/password/',
        { currentPassword: input.currentPassword, newPassword: input.newPassword },
        { signal: options?.signal },
      ),
    )

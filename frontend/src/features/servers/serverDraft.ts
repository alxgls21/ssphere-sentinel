import type { ScopeOptions, ServerInput } from '@/api/types'

/**
 * The form that adds a server: what is typed, what is wrong with it, and what is sent. Pure, so
 * it is tested without a screen. The server checks everything again (the address properly, the
 * site's existence, the unique name): the checks here only save a round trip for the obvious.
 */

export interface ServerDraft {
  name: string
  hostname: string
  /** The id of the site, or '' for none. */
  siteId: string
  ipAddress: string
  operatingSystem: string
  description: string
}

export type ServerErrors = Partial<Record<keyof ServerDraft, readonly string[]>>

/** The fields the form draws an error under, as the API names them. */
export const SERVER_FIELDS: readonly (keyof ServerDraft)[] = [
  'name',
  'hostname',
  'siteId',
  'ipAddress',
  'operatingSystem',
  'description',
]

/** The lengths the server accepts (its model's), so a long value is said here, not after a round trip. */
export const LIMITS = { name: 255, hostname: 255, operatingSystem: 255, description: 2000 } as const

export const EMPTY_DRAFT: ServerDraft = {
  name: '',
  hostname: '',
  siteId: '',
  ipAddress: '',
  operatingSystem: '',
  description: '',
}

const tooLong = (limit: number) => `At most ${limit} characters.`

/** An address is digits, dots and hexadecimal groups: anything else is a host name, which the field is not for. */
const ADDRESS_SHAPE = /^[0-9a-fA-F.:]{2,45}$/

export function validate(draft: ServerDraft): ServerErrors {
  const errors: ServerErrors = {}
  if (draft.name.trim() === '') errors.name = ['Required.']
  else if (draft.name.trim().length > LIMITS.name) errors.name = [tooLong(LIMITS.name)]
  if (draft.hostname.trim().length > LIMITS.hostname) errors.hostname = [tooLong(LIMITS.hostname)]
  if (draft.operatingSystem.trim().length > LIMITS.operatingSystem)
    errors.operatingSystem = [tooLong(LIMITS.operatingSystem)]
  if (draft.description.length > LIMITS.description)
    errors.description = [tooLong(LIMITS.description)]
  const address = draft.ipAddress.trim()
  if (address !== '' && !ADDRESS_SHAPE.test(address))
    errors.ipAddress = ['Expected an IPv4 or IPv6 address.']
  return errors
}

export const hasErrors = (errors: ServerErrors): boolean =>
  Object.values(errors).some((messages) => (messages?.length ?? 0) > 0)

/**
 * What is sent: trimmed, and only what was given. A blank hostname is left to the server (it
 * names the host by its name); a blank address or site is sent as none.
 */
export function toInput(draft: ServerDraft): ServerInput {
  const input: ServerInput = { name: draft.name.trim() }
  const hostname = draft.hostname.trim()
  if (hostname !== '') input.hostname = hostname
  const operatingSystem = draft.operatingSystem.trim()
  if (operatingSystem !== '') input.operatingSystem = operatingSystem
  if (draft.description !== '') input.description = draft.description
  const address = draft.ipAddress.trim()
  input.ipAddress = address === '' ? null : address
  input.siteId = draft.siteId === '' ? null : draft.siteId
  return input
}

/** The site choices: none first, then every site the account may see, named with its customer. */
export function siteChoices(scope: ScopeOptions): { value: string; label: string }[] {
  const customers = new Map(scope.customers.map((customer) => [customer.id, customer.name]))
  return [
    { value: '', label: 'No site (seen by accounts with every customer only)' },
    ...scope.sites.map((site) => ({
      value: site.id,
      label: `${customers.get(site.customerId) ?? 'Unknown customer'} / ${site.name}`,
    })),
  ]
}

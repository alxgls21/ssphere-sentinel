import type {
  CustomerInput,
  CustomerPatch,
  CustomerRecord,
  SiteInput,
  SitePatch,
  SiteRecord,
} from '@/api/types'
import type { FieldErrors } from '@/hooks/useSaveForm'
import { tooLong } from './adminModel'

/**
 * The forms of a customer and of a site: what is typed, what is wrong with it, and what is sent
 * (everything on creation, only what changed on a change). The server checks everything again
 * (the unique name, the customer's existence): the checks here only save a round trip.
 */

export const LIMITS = { name: 255, notes: 2000, description: 2000 } as const

export interface CustomerDraft {
  name: string
  notes: string
}

export type CustomerField = keyof CustomerDraft
export const CUSTOMER_FIELDS: readonly CustomerField[] = ['name', 'notes']
export const EMPTY_CUSTOMER: CustomerDraft = { name: '', notes: '' }

export const customerDraft = (record: CustomerRecord): CustomerDraft => ({
  name: record.name,
  notes: record.notes,
})

export function validateCustomer(draft: CustomerDraft): FieldErrors<CustomerField> {
  const errors: FieldErrors<CustomerField> = {}
  if (draft.name.trim() === '') errors.name = ['Required.']
  else if (draft.name.trim().length > LIMITS.name) errors.name = [tooLong(LIMITS.name)]
  if (draft.notes.length > LIMITS.notes) errors.notes = [tooLong(LIMITS.notes)]
  return errors
}

export const customerInput = (draft: CustomerDraft): CustomerInput => ({
  name: draft.name.trim(),
  notes: draft.notes,
})

/** Only what changed; null when nothing did. */
export function customerPatch(draft: CustomerDraft, record: CustomerRecord): CustomerPatch | null {
  const input = customerInput(draft)
  const patch: CustomerPatch = {}
  if (input.name !== record.name) patch.name = input.name
  if (input.notes !== record.notes) patch.notes = input.notes
  return Object.keys(patch).length > 0 ? patch : null
}

export interface SiteDraft {
  /** The id of the customer, or '' while none is chosen. */
  customerId: string
  name: string
  description: string
}

export type SiteField = keyof SiteDraft
export const SITE_FIELDS: readonly SiteField[] = ['customerId', 'name', 'description']

export const newSiteDraft = (customerId = ''): SiteDraft => ({
  customerId,
  name: '',
  description: '',
})

export const siteDraft = (record: SiteRecord): SiteDraft => ({
  customerId: record.customerId,
  name: record.name,
  description: record.description,
})

export function validateSite(draft: SiteDraft): FieldErrors<SiteField> {
  const errors: FieldErrors<SiteField> = {}
  if (draft.customerId === '') errors.customerId = ['Choose the customer the site belongs to.']
  if (draft.name.trim() === '') errors.name = ['Required.']
  else if (draft.name.trim().length > LIMITS.name) errors.name = [tooLong(LIMITS.name)]
  if (draft.description.length > LIMITS.description)
    errors.description = [tooLong(LIMITS.description)]
  return errors
}

export const siteInput = (draft: SiteDraft): SiteInput => ({
  customerId: draft.customerId,
  name: draft.name.trim(),
  description: draft.description,
})

/** Only what changed; null when nothing did. */
export function sitePatch(draft: SiteDraft, record: SiteRecord): SitePatch | null {
  const input = siteInput(draft)
  const patch: SitePatch = {}
  if (input.customerId !== record.customerId) patch.customerId = input.customerId
  if (input.name !== record.name) patch.name = input.name
  if (input.description !== record.description) patch.description = input.description
  return Object.keys(patch).length > 0 ? patch : null
}

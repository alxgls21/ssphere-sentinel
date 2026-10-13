import { useApi } from '@/api/context'
import { ALL_SCOPE, type Scope, type ScopeOptions } from '@/api/types'
import { useScope } from '@/app/viewState'
import { useResource } from '@/hooks/useResource'
import type { SelectOption } from '@/ui/controls'

/** The option value that means "no filter". */
export const ALL = ''

export interface ScopeChoices {
  customers: SelectOption<string>[]
  sites: SelectOption<string>[]
}

/**
 * What the two pickers offer. The sites follow the chosen customer (all sites,
 * prefixed with their customer, when none is chosen). A scope id the options do
 * not list yet (the URL arrived before the options did) is kept as its own
 * entry, so a picker never claims "All customers" while the view is scoped.
 */
export function buildScopeChoices(options: ScopeOptions | undefined, scope: Scope): ScopeChoices {
  const customerName = (id: string) => options?.customers.find((c) => c.id === id)?.name ?? id
  const customers: SelectOption<string>[] = [
    { value: ALL, label: 'All customers' },
    ...(options?.customers ?? []).map((c) => ({ value: c.id, label: c.name })),
  ]
  const sites: SelectOption<string>[] = [
    { value: ALL, label: 'All sites' },
    ...(options?.sites ?? [])
      .filter((s) => !scope.customerId || s.customerId === scope.customerId)
      .map((s) => ({
        value: s.id,
        label: scope.customerId ? s.name : `${customerName(s.customerId)} / ${s.name}`,
      })),
  ]
  if (scope.customerId && !customers.some((c) => c.value === scope.customerId)) {
    customers.push({ value: scope.customerId, label: scope.customerId })
  }
  if (scope.siteId && !sites.some((s) => s.value === scope.siteId)) {
    sites.push({ value: scope.siteId, label: scope.siteId })
  }
  return { customers, sites }
}

/** A new customer drops the site unless the site belongs to it. */
export function scopeWithCustomer(
  options: ScopeOptions | undefined,
  scope: Scope,
  customerId: string,
): Scope {
  if (customerId === ALL) return ALL_SCOPE
  const site = options?.sites.find((s) => s.id === scope.siteId)
  return { customerId, siteId: site?.customerId === customerId ? scope.siteId : null }
}

/** Choosing a site also chooses its customer, so the pair can never disagree. */
export function scopeWithSite(
  options: ScopeOptions | undefined,
  scope: Scope,
  siteId: string,
): Scope {
  if (siteId === ALL) return { customerId: scope.customerId, siteId: null }
  const site = options?.sites.find((s) => s.id === siteId)
  return { customerId: site?.customerId ?? scope.customerId, siteId }
}

/** Lower-case, dash-joined names for the breadcrumb: "sentinel › acme › athens-dc". */
export function scopeSegments(options: ScopeOptions | undefined, scope: Scope): string[] {
  const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-')
  const customer = options?.customers.find((c) => c.id === scope.customerId)
  const site = options?.sites.find((s) => s.id === scope.siteId)
  return [customer, site].flatMap((entity) => (entity ? [slug(entity.name)] : []))
}

/** What the retry control says: what failed, why, and what the button does. */
export const scopeErrorLabel = (error: Error): string =>
  `Customers and sites could not be loaded: ${error.message} Retry`

export interface ScopeState {
  scope: Scope
  choices: ScopeChoices
  /** The customer and site lists have loaded; until then the pickers are inert. */
  ready: boolean
  /** Why they could not be loaded. The pickers stay inert (there is no scope to offer) until `retry` succeeds. */
  error: Error | null
  retry: () => void
  segments: string[]
  setCustomer: (customerId: string) => void
  setSite: (siteId: string) => void
}

/** Scope (in the URL) plus the options to pick it from. One instance per bar. */
export function useScopeState(): ScopeState {
  const api = useApi()
  const [scope, setScope] = useScope()
  const resource = useResource('scope-options', (signal) => api.getScopeOptions({ signal }))
  const options = resource.data
  return {
    scope,
    choices: buildScopeChoices(options, scope),
    ready: resource.status === 'success',
    error: resource.status === 'error' ? resource.error : null,
    retry: resource.refetch,
    segments: scopeSegments(options, scope),
    setCustomer: (customerId) => setScope(scopeWithCustomer(options, scope, customerId)),
    setSite: (siteId) => setScope(scopeWithSite(options, scope, siteId)),
  }
}

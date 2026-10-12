import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { ALL_SCOPE, type RangeKey, type Scope } from '@/api/types'
import { DEFAULT_RANGE, isRangeKey } from '@/lib/range'

/**
 * Range and scope live in the URL (?range=6h&customer=...&site=...) so a view
 * can be shared, bookmarked and restored by "copy link to this view".
 * Defaults are omitted to keep URLs short.
 */

export function useRange(): readonly [RangeKey, (range: RangeKey) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('range')
  const range = isRangeKey(raw) ? raw : DEFAULT_RANGE
  const setRange = useCallback(
    (next: RangeKey) =>
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (next === DEFAULT_RANGE) copy.delete('range')
          else copy.set('range', next)
          return copy
        },
        { replace: true },
      ),
    [setParams],
  )
  return [range, setRange] as const
}

export function useScope(): readonly [Scope, (scope: Scope) => void] {
  const [params, setParams] = useSearchParams()
  const customer = params.get('customer')
  const site = params.get('site')
  const scope = useMemo<Scope>(
    () => (customer || site ? { customerId: customer, siteId: site } : ALL_SCOPE),
    [customer, site],
  )
  const setScope = useCallback(
    (next: Scope) =>
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (next.customerId) copy.set('customer', next.customerId)
          else copy.delete('customer')
          if (next.siteId) copy.set('site', next.siteId)
          else copy.delete('site')
          return copy
        },
        { replace: true },
      ),
    [setParams],
  )
  return [scope, setScope] as const
}

/** Stable string for a scope, for use inside resource keys. */
export function scopeKey(scope: Scope): string {
  return `${scope.customerId ?? '*'}/${scope.siteId ?? '*'}`
}
